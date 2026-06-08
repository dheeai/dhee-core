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
  "peerDependencies": { "dhee-core": ">=0.1.0" },
  "dhee": {                               // declares what this package exports
    "runners": "./dist/runners.js",       // module exporting runners (see below)
    "bundles": "./bundles"                // dir OR module exporting bundles
  }
}
```

- **`keywords`** MUST include `dhee-runner` and/or `dhee-bundle`. Discovery
  matches on the name pattern AND requires the keyword, so an unrelated
  `dhee-runner-utils` helper lib isn't auto-loaded. (ESLint trusts the
  name alone; we add the keyword guard deliberately.)
- **`peerDependencies.dhee-core`** declares the engine range, like an
  eslint plugin peer-depends on `eslint`.
- **`dhee`** field names the entry point(s). Either or both keys.

### Runner entry point

The module named by `dhee.runners` exports an array of
`{ manifest, runner }` pairs (the same shapes the built-in registry uses —
`RunnerManifest` from `src/dag/runners/registry.ts`, `Runner` from
`src/dag/schema.ts`):

```ts
export const runners: Array<{ manifest: RunnerManifest; runner: Runner }> = [
  { manifest: { tool: 'runway.gen3', version: '1.2.0', engineCompat: '>=0.1.0',
                credentials: ['RUNWAY_API_KEY'], displayName: 'Runway Gen-3' },
    runner: runwayGen3Runner },
];
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

## Trust

Installing a `dhee-runner-*` package means **running its code in your
engine** — treat it like any npm dependency. Runners can declare required
`credentials[]`; review what a third-party runner asks for before
supplying keys.

---

## Status

**Convention / forward-looking.** The integration points already exist —
`RunnerRegistry.register` and the bundle-source parser/resolver
(`src/dag/bundleSource.ts`) — and the current loaders are: built-in
runners (`src/dag/runners/index.ts`), custom runners discovered from
`~/.kshana/runners/` (`runner.json`), and project/installed bundles
(`installBundle.ts`). The **npm auto-discovery loader** (scan node_modules
→ register) is not implemented yet. This document fixes the naming + entry
points so the ecosystem and the loader can be built against a stable
contract.
