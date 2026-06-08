import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { discoverRunners } from '../../src/dag/runners/discovery.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import { walkBundle } from '../../src/dag/walker.js';
import type { DagBundle, LLMAccess, LLMGenerateTextOptions } from '../../src/dag/schema.js';

const REPO_ROOT = resolve(__dirname, '../..');
const SDK_ROOT = join(REPO_ROOT, 'packages/runner-sdk');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  __resetGlobalRegistryForTesting();
});

function ensureSdkBuilt(): void {
  if (existsSync(join(SDK_ROOT, 'dist/index.d.ts')) && existsSync(join(SDK_ROOT, 'dist/index.js'))) {
    return;
  }
  execFileSync(PNPM, ['-C', SDK_ROOT, 'run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
}

function writeSdkOnlyRunnerPackage(opts: {
  searchRoot: string;
  packageName: string;
  tool: string;
  source: string;
  permissions?: Record<string, unknown>;
}): string {
  const runnerDir = join(opts.searchRoot, opts.packageName);
  const srcDir = join(runnerDir, 'src');
  const nodeModulesAtScope = join(runnerDir, 'node_modules/@dhee');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(nodeModulesAtScope, { recursive: true });
  symlinkSync(SDK_ROOT, join(nodeModulesAtScope, 'runner-sdk'), 'dir');

  writeFileSync(
    join(runnerDir, 'package.json'),
    JSON.stringify(
      {
        name: opts.packageName,
        version: '1.0.0',
        type: 'module',
        dependencies: {
          '@dhee/runner-sdk': '0.1.0',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(runnerDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM'],
          rootDir: './src',
          outDir: './dist',
          strict: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(runnerDir, 'runner.json'),
    JSON.stringify({
      tool: opts.tool,
      version: '1.0.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      entry: 'dist/index.js',
      permissions: opts.permissions ?? {
        network: [],
        filesystem: 'project',
        subprocess: false,
        env: [],
      },
    }),
  );
  writeFileSync(join(srcDir, 'index.ts'), opts.source);

  const packageJson = JSON.parse(readFileSync(join(runnerDir, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
  };
  const dheeDeps = Object.keys(packageJson.dependencies ?? {}).filter((dep) => dep.startsWith('@dhee/'));
  expect(dheeDeps).toEqual(['@dhee/runner-sdk']);
  expect(readFileSync(join(srcDir, 'index.ts'), 'utf-8')).not.toMatch(/\.\.\/src|src\/dag/);

  execFileSync(PNPM, ['exec', 'tsc', '-p', join(runnerDir, 'tsconfig.json')], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });

  return runnerDir;
}

describe('@dhee/runner-sdk firewall', () => {
  it('compiles, discovers, validates, and runs an out-of-tree SDK-only runner', async () => {
    ensureSdkBuilt();
    tempRoot = mkdtempSync(join(tmpdir(), 'dhee-runner-sdk-firewall-'));
    const searchRoot = join(tempRoot, 'runners');
    writeSdkOnlyRunnerPackage({
      searchRoot,
      packageName: 'sdk-only-runner',
      tool: 'test.sdk_only',
      permissions: {
        network: ['api.example.com'],
        filesystem: 'project',
        subprocess: false,
        env: ['EXAMPLE_API_KEY'],
      },
      source: `
import { defineRunner } from '@dhee/runner-sdk';
import type { RunnerContext, RunnerManifest } from '@dhee/runner-sdk';

export const manifest = {
  tool: 'test.sdk_only',
  version: '1.0.0',
  engineCompat: '>=0.1.0',
  credentials: [],
  permissions: {
    network: ['api.example.com'],
    filesystem: 'project',
    subprocess: false,
    env: ['EXAMPLE_API_KEY'],
  },
} satisfies RunnerManifest;

export const runner = defineRunner({
  describe: () => ({
    id: manifest.tool,
    displayName: 'SDK-only runner',
    description: 'Compiled outside the engine against @dhee/runner-sdk only.',
    capabilities: ['firewall-test'],
    modalities: { input: ['text'], output: ['text'] },
    configSchema: {},
  }),
  run: async (ctx: RunnerContext) => {
    const outputPath = String(ctx.node.runner.config['outputPath'] ?? 'sdk-only.txt');
    return {
      ok: true,
      outputPath,
      metadata: {
        sdkOnly: true,
        hasInjectedLlm: Boolean(ctx.llm),
        inputKeys: Object.keys(ctx.inputs).sort(),
      },
    };
  },
});
`,
    });

    const reg = getGlobalRegistry();
    await discoverRunners(reg, [searchRoot]);
    expect(reg.get('test.sdk_only')).toBeDefined();
    expect(reg.getManifest('test.sdk_only')?.permissions).toEqual({
      network: ['api.example.com'],
      filesystem: 'project',
      subprocess: false,
      env: ['EXAMPLE_API_KEY'],
    });

    const bundle: DagBundle = {
      id: 'sdk_firewall_bundle',
      version: '0.1.0',
      goal: 'sdk_node',
      dependencies: {
        runners: {
          'test.sdk_only': '^1.0.0',
        },
      },
      nodes: [
        {
          id: 'sdk_node',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'text', pattern: 'sdk-only.txt' },
          runner: {
            tool: 'test.sdk_only',
            config: { outputPath: 'sdk-only.txt' },
          },
        },
      ],
    };

    expect(reg.validateBundle(bundle)).toEqual({ ok: true });
    const projectDir = join(tempRoot, 'project');
    mkdirSync(projectDir, { recursive: true });
    const result = await walkBundle({ projectDir, bundle });
    expect(result.ok).toBe(true);
    const completed = result.instances.find((inst) => inst.def.id === 'sdk_node');
    expect(completed?.metadata).toEqual({
      sdkOnly: true,
      hasInjectedLlm: true,
      inputKeys: [],
    });
  });

  it('lets an out-of-tree SDK-only runner call ctx.llm.generateText through the walker', async () => {
    ensureSdkBuilt();
    tempRoot = mkdtempSync(join(tmpdir(), 'dhee-runner-sdk-llm-'));
    const searchRoot = join(tempRoot, 'runners');
    writeSdkOnlyRunnerPackage({
      searchRoot,
      packageName: 'sdk-llm-runner',
      tool: 'test.sdk_llm',
      source: `
import { defineRunner } from '@dhee/runner-sdk';
import type { RunnerContext } from '@dhee/runner-sdk';

export const runner = defineRunner({
  describe: () => ({
    id: 'test.sdk_llm',
    displayName: 'SDK LLM runner',
    description: 'Calls ctx.llm without importing engine LLM internals.',
    capabilities: ['firewall-llm-test'],
    modalities: { input: ['text'], output: ['text'] },
    configSchema: {},
  }),
  run: async (ctx: RunnerContext) => {
    if (!ctx.llm) return { ok: false, error: 'ctx.llm missing' };
    const response = await ctx.llm.generateText({
      tier: 'heavy',
      purpose: 'content.story',
      temperature: 0.2,
      maxTokens: 50,
      messages: [
        { role: 'system', content: 'Return a tiny answer.' },
        { role: 'user', content: String(ctx.inputs['prompt'] ?? 'missing prompt') },
      ],
    });
    const outputPath = String(ctx.node.runner.config['outputPath'] ?? 'llm-output.txt');
    return {
      ok: true,
      outputPath,
      metadata: {
        model: response.model,
        content: response.content,
        generatedBytes: (response.content ?? '').length,
      },
    };
  },
});
`,
    });

    const reg = getGlobalRegistry();
    await discoverRunners(reg, [searchRoot]);
    expect(reg.get('test.sdk_llm')).toBeDefined();

    const bundle: DagBundle = {
      id: 'sdk_llm_bundle',
      version: '0.1.0',
      goal: 'sdk_llm_node',
      dependencies: {
        runners: {
          'test.sdk_llm': '^1.0.0',
        },
      },
      inputs: [
        {
          id: 'prompt',
          kind: 'project',
          field: 'prompt',
          required: true,
        },
      ],
      nodes: [
        {
          id: 'sdk_llm_node',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'text', pattern: 'llm-output.txt' },
          runner: {
            tool: 'test.sdk_llm',
            config: { outputPath: 'llm-output.txt' },
          },
        },
      ],
    };

    expect(reg.validateBundle(bundle)).toEqual({ ok: true });

    const seen: LLMGenerateTextOptions[] = [];
    const fakeLlm: LLMAccess = {
      async generateText(opts) {
        seen.push(opts);
        return {
          content: 'fake generated story',
          model: 'fake-model',
        };
      },
    };

    const projectDir = join(tempRoot, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ prompt: 'Write about rain.' }));

    const result = await walkBundle({ projectDir, bundle, llm: fakeLlm });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tier: 'heavy',
      purpose: 'content.story',
      temperature: 0.2,
      maxTokens: 50,
      messages: [
        { role: 'system', content: 'Return a tiny answer.' },
        { role: 'user', content: 'Write about rain.' },
      ],
    });
    const completed = result.instances.find((inst) => inst.def.id === 'sdk_llm_node');
    expect(completed?.metadata).toEqual({
      model: 'fake-model',
      content: 'fake generated story',
      generatedBytes: 'fake generated story'.length,
    });
  });
});
