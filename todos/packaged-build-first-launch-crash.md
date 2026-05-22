# Packaged build first-launch crash on macOS — "undefined: undefined"

## Status: OPEN — 2026-05-22

## Symptom

User downloaded v1.2.0 (or thereabouts) installer from the website,
installed, ran the terminal command from the install guide (almost
certainly `xattr -d com.apple.quarantine /Applications/Dhee.app` to
remove the macOS Gatekeeper quarantine flag), entered the sudo
password, opened Dhee — and got Electron's built-in error dialog:

  > A JavaScript error occurred in the main process
  > Uncaught Exception:
  > undefined: undefined

The "undefined: undefined" means the thrown value was either
`undefined` / `null` / a non-Error, OR an Error with no `name` /
`message`. Electron formats it as `${error?.name}: ${error?.message}`.

The dialog is Electron's BUILT-IN default — fires when an uncaught
exception happens BEFORE our `process.on('uncaughtException')` handler
at `main.ts:3517` registers. So the bug is in early module load.

## Update 2026-05-22 — log evidence narrows the throw point

User shared `~/Library/Logs/dhee-desktop/main.log`. Same 4 lines appear
on every launch attempt (4 attempts: 19:12, 19:13, 09:28, 09:46) and
then NOTHING — log just stops:

  [RemotionBootstrap] Startup cwd=/
  [RemotionBootstrap] Normalized NODE_PATH for packaged runtime: ...
  [RemotionBootstrap] Final NODE_PATH=...
  [EsbuildBinaryPath] Using packaged esbuild binary at .../@esbuild/darwin-arm64/bin/esbuild

This is the LAST log emitted by `bootstrapRemotionRuntime.ts`
(line 72, the `bootstrapPackagedEsbuildBinaryPath` call). After it
returns, control flows back to main.ts:1 and the next imports run.
**The throw is in one of those next imports.** Specifically — it
runs before any other user-code log, which means it's in:

  import path from 'path';                       // std lib, won't throw
  import fs from 'fs/promises';                  // std lib
  import { randomUUID } from 'crypto';           // std lib
  import { app, BrowserWindow, ... } from 'electron';
  import log from 'electron-log';                // already loaded
  import { autoUpdater } from 'electron-updater';     ← SUSPECT
  import ffmpeg from '@ts-ffmpeg/fluent-ffmpeg';
  import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';     ← SUSPECT
  import ffprobeInstaller from '@ffprobe-installer/ffprobe';  ← SUSPECT
  ... (other local imports)

### Refined hypothesis ranking

1. **`@ffmpeg-installer/ffmpeg` / `@ffprobe-installer/ffprobe`.** These
   resolve a platform-specific native binary path at IMPORT time
   (`darwin-arm64/ffmpeg`). If the binary isn't in `asar.unpacked`
   (asar can't execute native binaries — they MUST be unpacked), the
   resolver throws. The throw target is often an object literal
   without a `.message` field → Electron formats as "undefined:
   undefined".
2. **`electron-updater` autoUpdater on unsigned macOS.** User ran
   xattr to clear quarantine, meaning the app isn't notarized.
   electron-updater's autoUpdater static initializer can throw on
   unsigned builds.
3. **A local import (`accountManager`, `settingsManager`,
   `analytics`, etc.)** doing keychain or safeStorage I/O at module
   load. Less likely — those have try/catches per inspection.

### Next diagnostic to ship to user

Run the app directly from terminal so stderr is visible:

```
/Applications/Dhee.app/Contents/MacOS/Dhee 2>&1 | tee /tmp/dhee-stderr.log
```

stderr will show the actual stack + thrown value even when the
Electron dialog hides it. Paste back `/tmp/dhee-stderr.log` to
pinpoint the throw site.

### Validation steps once root cause is known

If it's #1 (ffmpeg / ffprobe):
  - Check `electron-builder` config (`package.json` `build.asarUnpack`)
    for entries covering `@ffmpeg-installer/**/*` and
    `@ffprobe-installer/**/*`.
  - Verify the v1.2.0 installer actually has these in `app.asar.unpacked/`.
  - If missing, add to `asarUnpack`, rebuild, re-release.

If it's #2 (electron-updater):
  - Guard the import or move it inside `app.whenReady().then(...)`.
  - Long-term: get the macOS build properly notarized so quarantine
    isn't an issue.

## Reproduction

- Fresh macOS install (no prior Dhee in `~/Library/Application Support/`)
- v1.2.0 or whatever the website serves
- xattr quarantine removal applied
- Launch from /Applications or via `open -a Dhee`

We haven't reproduced in dev (where `npm start` works fine). The
delta is packaged-build-specific:
  - asar bundling vs filesystem source
  - electron-builder app signing state
  - `app.isPackaged === true` code paths
  - native deps rebuilt for production Electron Node version
  - `process.resourcesPath` actually populated

## Likely culprits (ranked by recency + first-launch sensitivity)

### 1. `electron.safeStorage` called before `app.ready` (commit c83e8da)

`safeStorage.isEncryptionAvailable()` is ONLY safe after `app.ready`.
If `settingsManager.getSettings()` runs during top-level module
evaluation (e.g. any module's top-level code that imports it +
immediately calls `getSettings()`), it can throw.

On a FRESH install with no existing settings file, `getSettings` may
trigger a write of defaults — which calls `encryptCredential` → which
calls `safeStorage.encryptString` → throws if app isn't ready.

Check:
  - All importers of `settingsManager` (src/main/main.ts:46 + others)
  - Look for any module-load-time `getSettings()` call
  - Either defer to `app.whenReady().then(...)` or guard with
    `if (!app.isReady()) return defaults;`

### 2. Runtime config injection at module load (commits 132515a, c7aa4f0)

`cloudRuntimeConfig.ts` is imported at `main.ts:53-56`. If the
packaged build's runtime-config file (written by
`.erb/scripts/write-runtime-config.js` during CI release builds) is
missing, malformed, or unreadable, the import-time code execution
inside `cloudRuntimeConfig.ts` might throw.

Check:
  - Does `applyRuntimeAnalyticsConfigFromFile` actually fire at
    import time, or only on call?
  - What does it do if the runtime-config file is absent?
  - Is the file present in the packaged asar? Look at
    `release/build/mac/Dhee.app/Contents/Resources/...`

### 3. `bootstrapRemotionRuntime.ts` (line 1 of main.ts imports)

Top of main.ts: `import './utils/bootstrapRemotionRuntime';`. This
runs BEFORE every other import. It calls `process.chdir`, manipulates
`NODE_PATH`, invokes `Module._initPaths`. On a quarantine-cleared
install, weird permission states could throw.

Check:
  - The `try { process.chdir(safeCwd) } catch` covers chdir failure
  - But the `Module._initPaths?.()` call has no try/catch — if it
    throws (e.g. NODE_PATH points to a non-existent dir), Electron's
    early-exception handler catches an opaque error.

### 4. PostHog analytics startup (commits c7aa4f0, c5c7ec1)

`startDesktopAnalytics` may be triggered too early. If PostHog tries
to read a runtime-config-derived API key that's undefined, the
analytics lib might throw.

## How to actually diagnose

Ask the user for `~/Library/Logs/dhee-desktop/main.log`:

```
cat ~/Library/Logs/dhee-desktop/main.log | tail -80
```

`electron-log` writes here. Even when Electron's default dialog
catches the early error, `log.error` calls before the throw point
will appear. The stack trace + file + line should pinpoint the
throw site.

Also useful:
  - `cat ~/Library/Logs/dhee-desktop/main.old.log` (previous run if
    any retry was attempted)
  - `~/Library/Application Support/dhee-desktop/logs/debug.log`

## Hypothesis A: safeStorage timing fix

If diagnosis confirms it's `safeStorage` related:

1. Audit every call to `getSettings()` / `updateSettings()` at module
   import time. Defer to `app.whenReady()`.
2. In `credentialCipher.ts`, guard `safeStorage.*` calls with
   `app.isReady()` check; return plaintext (or sentinel) if not ready.
3. Add a regression test: import settingsManager in a test that runs
   BEFORE `app.ready` fires (electron-mocha or similar) and assert no
   throw.

## Hypothesis B: runtime-config-file missing in installer

If diagnosis points to `cloudRuntimeConfig`:

1. Check that `.erb/scripts/write-runtime-config.js` actually runs in
   the release CI pipeline for macOS (it's in `.github/workflows/release.yml`
   per commit 132515a).
2. Check that the output file is included in the asar via
   `electron-builder`'s `files` / `extraResources` config.
3. Make the import-time code defensive: if the file is missing,
   default everything to PostHog-disabled rather than throwing.

## Immediate action (without waiting for user log)

1. **Add a top-level try/catch around the imports in main.ts** so any
   early-load throw at least gets logged with stack rather than showing
   "undefined: undefined". This is a 5-line defensive measure that buys
   us debuggability for the NEXT release.
2. **Register `process.on('uncaughtException')` AS THE FIRST LINE of
   main.ts**, before any imports. Currently it's at line 3517, after
   thousands of lines of module-evaluation code. Moving it up means we
   catch and properly log even early-init errors.

Both of these are independent of root-cause diagnosis and only improve
observability — worth shipping immediately.

## Workaround for the user (until fixed)

If they can get past the dialog (clicking OK usually quits the app):

- Delete `~/Library/Application Support/dhee-desktop/` and try again
  (in case it's a corrupted settings file)
- Run the app from terminal (`/Applications/Dhee.app/Contents/MacOS/Dhee`)
  to see stderr directly
- Send us the `main.log` content

## References

- `src/main/main.ts:1` — imports start (bootstrapRemotionRuntime first)
- `src/main/main.ts:3517` — uncaughtException handler (registered too late)
- `src/main/credentialCipher.ts` — safeStorage wrapper added in c83e8da
- `src/main/cloudRuntimeConfig.ts` — runtime config loader added in 132515a
- `src/main/bootstrapRemotionRuntime.ts` — packaged-runtime patching
- Commits: c83e8da (encryption), 132515a (runtime config), c7aa4f0 (analytics ordering)
- `.erb/scripts/write-runtime-config.js` — release-time config injection
