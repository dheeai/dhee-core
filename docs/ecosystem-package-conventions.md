# Ecosystem packages — publishing dhee runners & bundles to npm

dhee-core is a content-agnostic generative engine. The community extends
it by publishing **runners** (node executors) and **bundles** (pipelines)
as npm packages that dhee-core discovers and loads — the same way ESLint
discovers `eslint-plugin-*` / `eslint-config-*`.

> **Two distribution channels — don't conflate them:**
> 1. **Authoring skills** (the *how-to* guides `bundle-authoring` /
>    `runner-authoring`) ship via the **Claude Code plugin marketplace**
>    in this repo (`.claude-plugin/`). For humans/agents *writing*
>    runners and bundles.
> 2. **Runners & bundles themselves** (the executable code / pipeline
>    data) ship via **npm packages** following the convention below. For
>    dhee-core to *load at runtime*.
>
> This document is about (2).

---

## Naming convention (ESLint-style)

| Artifact | Unscoped | Scoped |
|----------|----------|--------|
| A package that provides **runner(s)** | `dhee-runner-<name>` | `@<scope>/dhee-runner-<name>` or `@<scope>/dhee-runner` |
| A package that provides **bundle(s)** | `dhee-bundle-<name>` | `@<scope>/dhee-bundle-<name>` or `@<scope>/dhee-bundle` |

Examples: `dhee-runner-runway`, `dhee-runner-musicgen`,
`@acme/dhee-runner`; `dhee-bundle-anime-storybook`, `dhee-bundle-podcast`,
`@acme/dhee-bundle`.

**Discovery match** (mirrors ESLint's `eslint-plugin-` matcher):

```
^(@[^/]+/)?dhee-(runner|bundle)(-.+)?$
```

A package MAY provide both (a bundle that ships the runner it needs) —
name it for its primary artifact and declare both entry points (below).

---

## `package.json` contract

```jsonc
{
  "name": "dhee-runner-runway",
  "version": "1.2.0",
  "keywords": ["dhee-runner"],          // REQUIRED guard — see below
  "dependencies": { "@dhee/runner-sdk": "^0.1.0" },  // the contract runners build on
  "dhee": {                               // declares what this package exports
    "runners": "./dist/index.js",         // module exporting `runners` (see below)
    "bundles": "./bundles"                // dir OR module exporting bundles
  }
}
```

- **`keywords`** MUST include `dhee-runner` and/or `dhee-bundle`. Discovery
  matches on the name pattern AND requires the keyword, so an unrelated
  `dhee-runner-utils` helper lib isn't auto-loaded. (ESLint trusts the
  name alone; we add the keyword guard deliberately.)
- **`@dhee/runner-sdk`** is the package a runner builds against —
  `defineRunner`, the canonical types, and the shared primitives
  (`resolveEndpointUrl`, `retryTransient`, `computeInputsHash`). A runner
  depends ONLY on the SDK, never on `dhee-core` internals (enforced by the
  runner-sdk firewall test). The reference implementation is
  `packages/openrouter-image-runner` (published name
  `dhee-runner-openrouter-image`).
- **`dhee`** field names the entry point(s). Either or both keys.

### Runner entry point

The module named by `dhee.runners` exports an array of
`{ manifest, runner }` pairs, built with the SDK's `defineRunner`
(`RunnerManifest` + `Runner` come from `@dhee/runner-sdk`):

```ts
import { defineRunner, type RunnerManifest } from '@dhee/runner-sdk';

export const manifest: RunnerManifest = {
  tool: 'runway.gen3', version: '1.2.0', engineCompat: '>=0.1.0',
  credentials: ['RUNWAY_API_KEY'], displayName: 'Runway Gen-3',
  // Declared capability surface (network/filesystem/subprocess/env):
  permissions: { network: ['api.runwayml.com'], filesystem: 'project', env: ['RUNWAY_API_KEY'] },
};
export const runner = defineRunner({ describe: () => ({ /* … */ }), run: async (ctx) => { /* … */ } });

export const runners = [{ manifest, runner }];
```

dhee-core calls `registry.register(manifest, runner)` for each. Tool ids
are dot-namespaced and SHOULD relate to the package
(`dhee-runner-runway` → `runway.*`). `credentials[]` make bundles using
the runner fail validation up front if the env vars are unset.

### Bundle entry point

`dhee.bundles` is either:
- a **directory** with one subdirectory per bundle (each a normal bundle
  dir: `bundle.json` + `prompts/` + `schemas/` + `workflows/`), or
- a **module** exporting `export const bundles: DagBundle[]`.

A project references such a bundle through the bundle-source scheme
(`src/dag/bundleSource.ts`), extending the existing `built-in:<id>` form:

```
npm:dhee-bundle-podcast              # the package's sole/default bundle
npm:@acme/dhee-bundle#anime_storybook  # a named bundle within a multi-bundle package
```

A bundle package that needs a specific runner should depend on its
`dhee-runner-*` package (or ship the runner itself).

---

## Discovery & precedence (the loader)

On engine startup dhee-core enumerates installed dependencies whose name
matches the regex above **and** carry the matching keyword, then:

- **runners** → `registry.register(...)` for each exported pair;
- **bundles** → added to the bundle-source registry under `npm:<pkg>`.

Resolution precedence, highest wins:

1. Explicit project/local override (`~/.kshana/runners/`, project bundles)
2. Installed npm package (the declared/closest version)
3. Built-in (shipped in dhee-core)

A bundle's `dependencies.runners` semver ranges still gate at walk start:
the resolved runner must be registered and satisfy the range, or the
bundle fails before any work runs.

---

## Bundle → runner dependencies & install hints

A bundle declares the runners it needs in `bundle.json`
`dependencies.runners` (tool id → semver range), validated against the
registry before the walk. Those are *tool ids*, not packages — so there
are two complementary ways to make sure a needed runner is actually
present, and to tell the user how to get it:

1. **npm-native (for bundle packages).** A `dhee-bundle-*` package lists
   the runner package in its `package.json` `dependencies` /
   `peerDependencies` (e.g. `"dhee-runner-runway": "^1"`). Then
   `npm i <bundle-pkg>` installs the runner package too, and discovery
   registers it — no extra step. (Same shape as an `eslint-config-*`
   depending on an `eslint-plugin-*`.)

2. **Declared install hint (for built-in / local bundles).** Add
   `dependencies.runnerPackages` to `bundle.json` mapping a tool id to its
   npm package:

   ```jsonc
   "dependencies": {
     "runners":        { "runway.gen3": ">=1.0.0" },
     "runnerPackages": { "runway.gen3": "dhee-runner-runway@^1.2.0" }
   }
   ```

   `checkBundleRunners(bundle, registry)` (`src/dag/ecosystem.ts`) returns
   every required runner that isn't registered, each with a ready
   `install` command — the declared package, or, if undeclared, a
   `dhee-runner-<namespace>` convention guess. A discovery / "configure
   this bundle" UI surfaces `npm i <package>` so the user can install the
   missing runner before running.

## Trust

Installing a `dhee-runner-*` package means **running its code in your
engine** — treat it like any npm dependency. Runners can declare required
`credentials[]`; review what a third-party runner asks for before
supplying keys.

---

## Status

**Implemented** in `src/dag/ecosystem.ts`:

- `findEcosystemPackages()` — scan node_modules (cwd up; `DHEE_NODE_MODULES_DIRS`
  override) for name-matching + keyword-guarded packages.
- `discoverNpmRunners(reg)` — import each `dhee.runners` entry and register
  the runners; idempotent (skips already-registered tools), best-effort
  (one bad package never poisons the rest). Wired into `runProjectViaBundle`
  via `ensureNpmRunnersLoaded()` (once per process) so npm runners are
  available before the bundle's runner dependencies are validated.
- `findNpmBundles()` + the `npm:<pkg>[#<id>]` bundle-source scheme
  (`bundleSource.ts`) + `listBundles()` enumeration — `dhee-bundle-*`
  packages resolve and show up in the picker (lower precedence than user /
  built-in, so a same-id fork still wins).
- `checkBundleRunners()` — missing-runner detection with `npm i` install
  hints (see above).

Alongside the pre-existing loaders: built-in runners
(`src/dag/runners/index.ts`), custom runners from `~/.kshana/runners/`
(`runner.json`, `discovery.ts`), and project/installed bundles
(`installBundle.ts`).
