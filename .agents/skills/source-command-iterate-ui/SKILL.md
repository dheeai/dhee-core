---
name: "source-command-iterate-ui"
description: "Tight visual loop for changing the desktop UI — edit code, screenshot the running window, look at it, iterate. Use whenever the user asks you to change anything visible in the dhee-desktop renderer."
---

# source-command-iterate-ui

Use this skill when the user asks to run the migrated source command `iterate-ui`.

## Command Template

You are iterating on the UI **of the running desktop** the user is looking at. The dev server's HMR picks up renderer edits without restart; main-process edits need `/restart-desktop`. Do not finish a UI change without visually verifying it.

## Prerequisites

The desktop must be running with the CDP socket exposed:

```bash
ps aux | grep -E "electronmon.*kshana-desktop|webpack.*kshana-desktop" | grep -v grep | head -1
DHEE_DEBUG_PORT=9223 npm --prefix /Users/ganaraj/Projects/kshana-desktop run desktop-drive url
```

If `url` returns `ok:false`, run `/restart-desktop` first.

## The loop

For each iteration:

### 1. Make the change

Edit the renderer file(s) — TSX, SCSS, anything under `src/renderer/`. Save.

If the change is in `src/main/` (main process, IPC, dheeCoreManager, etc.), HMR doesn't apply — you must `/restart-desktop` to see it.

If the change is in **kshana-core source**, you need `pnpm tsup` then `/restart-desktop` (the desktop loads kshana-core from `./dist/`, not source).

### 2. Wait for HMR to settle (~1–2s)

```bash
sleep 2
```

Renderer-only changes are usually picked up by the time the screenshot fires. Don't sleep longer — if HMR is broken you want to know immediately, not after a 30s blind wait.

### 3. Screenshot the window

```bash
mkdir -p /tmp/dhee-iterate
DHEE_DEBUG_PORT=9223 npm --prefix /Users/ganaraj/Projects/kshana-desktop run desktop-drive screenshot /tmp/dhee-iterate/$(date +%s).png
```

Then `Read` the PNG with the Read tool. **Look at it.** Compare to what the user asked for. Don't just check that the file got written — check that the rendered output matches intent.

### 4. Decide

- **Looks right** — run any relevant tests (`pnpm test` for unit, `pnpm test:e2e` for playwright), then commit + push.
- **Looks wrong** — figure out the gap from the screenshot, edit, return to step 2.

If you can't tell what's wrong from the screenshot (e.g. the layout looks fine but a value is wrong), inspect the DOM:

```bash
DHEE_DEBUG_PORT=9223 npm --prefix /Users/ganaraj/Projects/kshana-desktop run desktop-drive eval "document.querySelector('.some-class')?.outerHTML"
DHEE_DEBUG_PORT=9223 npm --prefix /Users/ganaraj/Projects/kshana-desktop run desktop-drive text --selector "[data-testid=foo]"
```

Renderer console errors hint at React crashes — surface them up to the user explicitly rather than silently retrying.

### 5. Navigate before screenshotting if needed

The screenshot captures whatever's currently on screen. If your change is on the Settings overlay or inside a project, drive there first:

```bash
# Open a specific project from the landing screen
DHEE_DEBUG_PORT=9223 npm --prefix /Users/ganaraj/Projects/kshana-desktop run desktop-drive click '.ProjectCard-module__card--LVGQv:has(h3:text-is("Ruby V4"))'
sleep 1
# Open an overlay (Settings, Library, Plans, Timeline)
DHEE_DEBUG_PORT=9223 npm --prefix /Users/ganaraj/Projects/kshana-desktop run desktop-drive click "Settings"
```

## Notes

- HMR fails silently sometimes. If a renderer edit doesn't show up after a screenshot, `/restart-desktop` and retry — don't keep editing against an unchanged window.
- Save before-and-after screenshots when the change is visual (color, layout, spacing). They're the artifact you show the user when you report done.
- For pixel-level changes, narrow the screenshot to the affected region: `eval "document.querySelector('X').getBoundingClientRect()"` to find the rect, then call `screenshot --full` and crop in your mental model.
- **You're not done until you've seen the result.** Tests passing doesn't mean the screen renders correctly. CSS changes especially.
