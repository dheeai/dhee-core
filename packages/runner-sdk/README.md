# @dhee_ai/runner-sdk

The public authoring SDK for [Dhee](https://github.com/dheeai) **runners** and **bundles**.

`dhee-core` is a content-agnostic DAG engine that walks a *bundle* (a pipeline graph) and executes each node with a *runner* (a node executor). Runners ship as standalone npm packages the engine discovers at runtime — and they depend on **this package only**, never on `dhee-core` internals. That firewall lets the engine evolve without breaking the ecosystem, and lets you build, test, and publish a runner in isolation.

## Install

```sh
npm install @dhee_ai/runner-sdk
```

## What it gives you

- **`defineRunner(impl)`** — wrap your `{ describe, run }` into a `Runner`.
- **`resolveEndpointUrl(name)`** — resolve a named endpoint (`self.local`, `self.cloud`, …) to its URL from the user's env (`ENDPOINT_<name>` / `COMFYUI_BASE_URL`). Keeps endpoint URLs out of bundles.
- **`retryTransient(fn, opts)` / `isTransientError(e)`** — retry network/Comfy calls with backoff + abort support.
- **`computeInputsHash(key)`** — content-addressed cache key for a node's inputs.
- The canonical **types**: `Runner`, `RunnerContext`, `RunnerDescription`, `RunnerManifest`, `RunnerResult`, `RunnerArtifact`, `DagBundle`, `NodeDef`, and the bundle/LLM-access types.

## Minimal runner

```ts
import { defineRunner, resolveEndpointUrl, retryTransient } from '@dhee_ai/runner-sdk';
import type { RunnerContext, RunnerDescription, RunnerManifest } from '@dhee_ai/runner-sdk';

export const manifest = {
  tool: 'my.thing',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  credentials: [],
  displayName: 'My Thing',
  description: 'Does a thing.',
  entry: 'dist/index.js',
  permissions: { network: ['<host>'], filesystem: 'project', subprocess: false, env: [] },
} satisfies RunnerManifest;

const describe = (): RunnerDescription => ({
  id: manifest.tool,
  displayName: 'My Thing',
  description: 'Does a thing.',
  capabilities: ['example'],
  modalities: { input: ['text'], output: ['image'] },
  configSchema: { type: 'object', required: ['outputPath'], properties: { outputPath: { type: 'string' } } },
});

async function run(ctx: RunnerContext) {
  // ... do work, write ctx.node.runner.config.outputPath under ctx.projectDir ...
  return { ok: true, outputPath: 'out.png' };
}

export const runner = defineRunner({ describe, run });

// Discovery entry — package.json "dhee.runners" points here.
export const runners = [{ manifest, runner }];
```

## Discovery (how dhee-core finds your runner)

Your package opts in via **name + keyword + entry point**:

```jsonc
{
  "name": "dhee-runner-my-thing",
  "keywords": ["dhee-runner"],
  "dhee": { "runners": "./dist/index.js" },
  "dependencies": { "@dhee_ai/runner-sdk": "^0.1.0" }
}
```

`npm create dhee-runner` scaffolds all of this for you.

## License

Apache-2.0
