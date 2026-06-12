/**
 * Phase 4 — walker enhancements.
 *
 * The existing walker had skip-if-output-exists as implicit state and
 * no formal stop-at / runOnly support. Phase 4 makes the state
 * explicit (walkState in project.json) and adds stopAt + runOnly +
 * event stream.
 *
 * Test surface = the formal contract the agent calls into and what the
 * walker promises about resumability across crashes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  walkBundle,
  loadWalkState,
  saveWalkState,
  type WalkState,
} from '../../src/dag/walker.js';
import {
  RunnerRegistry,
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner, RunnerResult } from '../../src/dag/schema.js';

// ── Test bundle: tiny 3-node DAG ───────────────────────────────────────

const TINY_BUNDLE: DagBundle = {
  id: 'tiny',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  goal: 'final',
  nodes: [
    {
      id: 'story',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'md', pattern: 'plans/story.md' },
      runner: { tool: 'stub.runner', config: { name: 'story' } },
    },
    {
      id: 'beats',
      kind: 'stage',
      inputs: [{ from: 'story', usage: 'input' }],
      outputs: { format: 'json', pattern: 'plans/beats.json' },
      runner: { tool: 'stub.runner', config: { name: 'beats' } },
    },
    {
      id: 'final',
      kind: 'stage',
      inputs: [{ from: 'beats', usage: 'input' }],
      outputs: { format: 'video', pattern: 'final.mp4' },
      runner: { tool: 'stub.runner', config: { name: 'final' } },
    },
  ],
};

const TEXT_FIRST_BUNDLE: DagBundle = {
  id: 'text-first',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  goal: 'final',
  nodes: [
    {
      id: 'story',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'md', pattern: 'plans/story.md' },
      runner: { tool: 'llm.fake', config: { name: 'story' } },
    },
    {
      id: 'character_image_prompt',
      kind: 'stage',
      inputs: [{ from: 'story', usage: 'context' }],
      outputs: { format: 'json', pattern: 'prompts/character.json' },
      runner: { tool: 'llm.fake', config: { name: 'character_image_prompt' } },
    },
    {
      id: 'character_image',
      kind: 'stage',
      inputs: [{ from: 'character_image_prompt', usage: 'input' }],
      outputs: { format: 'image', pattern: 'images/character.png' },
      runner: { tool: 'comfy.fake', config: { name: 'character_image' } },
    },
    {
      id: 'settings_plan',
      kind: 'stage',
      inputs: [{ from: 'story', usage: 'context' }],
      outputs: { format: 'json', pattern: 'plans/settings.json' },
      runner: { tool: 'llm.fake', config: { name: 'settings_plan' } },
    },
    {
      id: 'scene_video_prompt',
      kind: 'stage',
      inputs: [{ from: 'settings_plan', usage: 'context' }],
      outputs: { format: 'md', pattern: 'prompts/scene-video.md' },
      runner: { tool: 'llm.fake', config: { name: 'scene_video_prompt' } },
    },
    {
      id: 'final',
      kind: 'stage',
      inputs: [
        { from: 'character_image', usage: 'input' },
        { from: 'scene_video_prompt', usage: 'context' },
      ],
      outputs: { format: 'video', pattern: 'final.mp4' },
      runner: { tool: 'stub.final', config: { name: 'final' } },
    },
  ],
};

// ── Stub runner that records what it ran ───────────────────────────────

function makeStubRunner(opts: {
  failOn?: string[]; // node names that should fail
  ranNodes: string[]; // mutable accumulator
}): Runner {
  return {
    describe: () => ({
      id: 'stub.runner',
      displayName: 'stub',
      description: 'test stub',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx): Promise<RunnerResult> {
      const cfg = ctx.node.runner.config as { name: string };
      opts.ranNodes.push(cfg.name);
      if (opts.failOn?.includes(cfg.name)) {
        return { ok: false, error: `stub fail: ${cfg.name}` };
      }
      const outPath = ctx.node.outputs.pattern;
      const outAbs = join(ctx.projectDir, outPath);
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, `result of ${cfg.name}`);
      return { ok: true, outputPath: outPath };
    },
  };
}

// ── Per-test scratch + registry setup ─────────────────────────────────

let projectDir: string;
let ranNodes: string[];

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'walker-enh-'));
  ranNodes = [];
  __resetGlobalRegistryForTesting();
  const reg = getGlobalRegistry();
  reg.register(
    {
      tool: 'stub.runner',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
    },
    makeStubRunner({ ranNodes }),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
  // Re-import the built-in registrations.
  vi.resetModules();
});

// ── walkState persistence ──────────────────────────────────────────────

describe('walkState persistence', () => {
  it('loadWalkState returns null when no project.json exists', () => {
    expect(loadWalkState(projectDir)).toBeNull();
  });

  it('loadWalkState returns null when project.json has no walkState field', () => {
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ id: 'p' }));
    expect(loadWalkState(projectDir)).toBeNull();
  });

  it('saveWalkState writes to project.json without clobbering other fields', () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', title: 'My Project', otherStuff: { keep: true } }),
    );
    const state: WalkState = {
      bundleSource: 'built-in:tiny',
      bundleVersion: '0.1.0',
      engineVersion: '0.1.0',
      nodes: { story: { status: 'completed', outputPath: 'plans/story.md' } },
      lastInvalidatedIds: [],
    };
    saveWalkState(projectDir, state);

    const raw = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as Record<string, unknown>;
    expect(raw['id']).toBe('p');
    expect(raw['title']).toBe('My Project');
    expect(raw['otherStuff']).toEqual({ keep: true });
    expect(raw['walkState']).toEqual(state);
  });

  it('walkBundle persists walkState after each completed node', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(true);
    const state = loadWalkState(projectDir);
    expect(state).not.toBeNull();
    expect(state!.nodes['story']?.status).toBe('completed');
    expect(state!.nodes['beats']?.status).toBe('completed');
    expect(state!.nodes['final']?.status).toBe('completed');
  });

  it('walkBundle preserves walkState on failure (so resumes pick up where it left off)', async () => {
    __resetGlobalRegistryForTesting();
    const reg = getGlobalRegistry();
    reg.register(
      { tool: 'stub.runner', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes, failOn: ['beats'] }),
    );

    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(false);

    const state = loadWalkState(projectDir);
    expect(state).not.toBeNull();
    expect(state!.nodes['story']?.status).toBe('completed');
    expect(state!.nodes['beats']?.status).toBe('failed');
    expect(state!.nodes['final']?.status).toBe('pending');
  });

  it('walkBundle treats malformed walkState as missing (re-initializes, all pending)', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', walkState: 'not an object, malformed' }),
    );
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(true);
    const state = loadWalkState(projectDir);
    expect(state!.nodes['story']?.status).toBe('completed');
  });
});

// ── Resume semantics ───────────────────────────────────────────────────

describe('resume from walkState', () => {
  it('skips nodes already marked completed with valid output', async () => {
    // Pre-seed walkState with story completed.
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/story.md'), 'pre-existing story');
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        walkState: {
          bundleSource: 'built-in:tiny',
          bundleVersion: '0.1.0',
          engineVersion: '0.1.0',
          nodes: {
            story: { status: 'completed', outputPath: 'plans/story.md' },
          },
          lastInvalidatedIds: [],
        } as WalkState,
      }),
    );

    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).not.toContain('story');     // skipped
    expect(ranNodes).toContain('beats');
    expect(ranNodes).toContain('final');
    // Original story content preserved.
    expect(readFileSync(join(projectDir, 'plans/story.md'), 'utf-8')).toBe('pre-existing story');
  });

  it('re-runs nodes whose recorded output file no longer exists on disk', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        walkState: {
          bundleSource: 'built-in:tiny',
          bundleVersion: '0.1.0',
          engineVersion: '0.1.0',
          nodes: {
            story: { status: 'completed', outputPath: 'plans/story.md' },
          },
          lastInvalidatedIds: [],
        } as WalkState,
      }),
    );
    // story.md doesn't exist on disk despite walkState saying completed.

    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toContain('story'); // re-run
  });

  it('treats walkState entries for nodes no longer in the bundle as stale (drops them)', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        walkState: {
          bundleSource: 'built-in:tiny',
          bundleVersion: '0.1.0',
          engineVersion: '0.1.0',
          nodes: {
            story: { status: 'completed', outputPath: 'plans/story.md' },
            zombie_node_from_old_bundle: { status: 'completed', outputPath: 'gone.txt' },
          },
          lastInvalidatedIds: [],
        } as WalkState,
      }),
    );
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/story.md'), 'kept');

    await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    const state = loadWalkState(projectDir);
    expect(state!.nodes['zombie_node_from_old_bundle']).toBeUndefined();
  });
});

// ── stopAt ─────────────────────────────────────────────────────────────

describe('stopAt', () => {
  it('runs everything up to and including the named node, then stops', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      stopAt: 'beats',
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual(['story', 'beats']);
    const state = loadWalkState(projectDir);
    expect(state!.nodes['beats']?.status).toBe('completed');
    expect(state!.nodes['final']?.status ?? 'pending').toBe('pending');
  });

  it('fails clearly when stopAt names a node not in the bundle', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      stopAt: 'no_such_node',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no_such_node|not in bundle|valid nodes/i);
    }
  });

  it('stopAt at the goal node is equivalent to no stopAt', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      stopAt: 'final',
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual(['story', 'beats', 'final']);
  });
});

// ── runOnly (now a back-compat no-op) ──────────────────────────────────
//
// `runOnly` used to drive a cascade filter inside the walker, forcing
// re-runs of the named nodes + their dependents. With cascade-
// invalidation moved out into invalidateNodes (projectRegen.ts), the
// walker is state-as-truth: pending → run, completed (with file) →
// skip. `runOnly` is accepted only for back-compat with old callers;
// it does NOT cause any cache bypass. Tests below assert the new
// contract.

describe('runOnly (back-compat — now a no-op)', () => {
  it('does NOT force a re-run when all nodes are already completed', async () => {
    // Seed all 3 as completed with files on disk.
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/story.md'), 's');
    writeFileSync(join(projectDir, 'plans/beats.json'), '{}');
    writeFileSync(join(projectDir, 'final.mp4'), 'v');
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        walkState: {
          bundleSource: 'built-in:tiny',
          bundleVersion: '0.1.0',
          engineVersion: '0.1.0',
          nodes: {
            story: { status: 'completed', outputPath: 'plans/story.md' },
            beats: { status: 'completed', outputPath: 'plans/beats.json' },
            final: { status: 'completed', outputPath: 'final.mp4' },
          },
          lastInvalidatedIds: [],
        } as WalkState,
      }),
    );

    // Pre-cascade walker would re-run beats + final. State-as-truth
    // walker skips everything — all completed, files on disk. The
    // caller's job (invalidateNodes) is to clear walkState first.
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      runOnly: ['beats'],
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual([]);
  });

  it('still runs every pending node, regardless of what runOnly names', async () => {
    // Empty walkState — everything is pending. runOnly should NOT
    // restrict the walk; this is the v1 onboarding-path behavior
    // (someone calling regenerate before any prior run finished).
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      runOnly: ['beats'],
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual(['story', 'beats', 'final']);
  });

  it('empty runOnly array is a no-op (does not block pending nodes)', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      runOnly: [],
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual(['story', 'beats', 'final']);
  });

  it('runOnly node id that does not exist in the bundle fails clearly (validation kept for fast feedback)', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      runOnly: ['no_such_node'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no_such_node|not in bundle/i);
    }
  });
});

// ── Project-local character references ────────────────────────────────

describe('project character references', () => {
  it('uses a setup character reference as the character_image output before invoking Comfy', async () => {
    const bundle: DagBundle = {
      id: 'character-ref-bundle',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      goal: 'character_image',
      nodes: [
        {
          id: 'characters_plan',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'json', pattern: 'plans/characters_plan.json' },
          runner: { tool: 'characters.fake', config: {} },
        },
        {
          id: 'character_image_prompt',
          kind: 'collection',
          itemSource: 'characters_plan',
          itemKey: 'characters',
          inputs: [{ from: 'characters_plan', usage: 'input' }],
          outputs: { format: 'json', pattern: 'prompts/character_images/{{item_id}}.json' },
          runner: { tool: 'llm.fake', config: { name: 'character_image_prompt' } },
        },
        {
          id: 'character_image',
          kind: 'collection',
          itemSource: 'character_image_prompt',
          inputs: [{ from: 'character_image_prompt', usage: 'input', scope: 'matching' }],
          outputs: { format: 'image', pattern: 'assets/images/characters/{{item_id}}.png' },
          runner: { tool: 'comfy.fake', config: { name: 'character_image' } },
        },
      ],
    };

    mkdirSync(join(projectDir, 'assets/uploads/characters'), { recursive: true });
    writeFileSync(join(projectDir, 'assets/uploads/characters/hero.png'), 'uploaded-arjun');
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        inputs: [
          {
            id: 'character-ref-1',
            source: { type: 'local_path', value: 'assets/uploads/characters/hero.png' },
            mediaType: 'image',
            purpose: 'character_ref',
            metadata: {
              originalFilename: 'hero.png',
              referenceRole: 'character',
            },
            processing: {
              status: 'completed',
              localPath: 'assets/uploads/characters/hero.png',
            },
          },
        ],
      }),
    );

    const reg = getGlobalRegistry();
    reg.register(
      { tool: 'characters.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      {
        describe: () => ({
          id: 'characters.fake',
          displayName: 'characters',
          description: 'characters',
          capabilities: [],
          modalities: { input: [], output: [] },
          configSchema: {},
        }),
        async run(ctx): Promise<RunnerResult> {
          const outputPath = ctx.node.runner.config['outputPath'] as string;
          const outAbs = join(ctx.projectDir, outputPath);
          mkdirSync(join(outAbs, '..'), { recursive: true });
          writeFileSync(
            outAbs,
            JSON.stringify({
              characters: [
                { id: 'arjun', name: 'Arjun' },
              ],
            }),
          );
          return { ok: true, outputPath };
        },
      },
    );
    reg.register(
      { tool: 'llm.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes }),
    );
    reg.register(
      { tool: 'comfy.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      {
        describe: () => ({
          id: 'comfy.fake',
          displayName: 'comfy',
          description: 'comfy',
          capabilities: [],
          modalities: { input: [], output: [] },
          configSchema: {},
        }),
        async run(): Promise<RunnerResult> {
          return { ok: false, error: 'comfy.fake should not run for a bound character reference' };
        },
      },
    );

    const result = await walkBundle({
      projectDir,
      bundle,
      bundleSource: 'built-in:character-ref-bundle',
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(projectDir, 'assets/images/characters/arjun.png'), 'utf8')).toBe('uploaded-arjun');
    expect(ranNodes).toEqual(['character_image_prompt']);
    const state = loadWalkState(projectDir);
    expect(state?.nodes['character_image:arjun']?.metadata).toMatchObject({
      generationTool: 'project.character_reference',
      userSupplied: true,
      characterReference: {
        sourcePath: 'assets/uploads/characters/hero.png',
        strategy: 'single_reference_first_character',
      },
    });
  });
});

// ── Project-local setting references ──────────────────────────────────

describe('project setting references', () => {
  it('uses a setup setting reference as the setting_image output before invoking Comfy', async () => {
    const bundle: DagBundle = {
      id: 'setting-ref-bundle',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      goal: 'setting_image',
      nodes: [
        {
          id: 'settings_plan',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'json', pattern: 'plans/settings_plan.json' },
          runner: { tool: 'settings.fake', config: {} },
        },
        {
          id: 'setting_image_prompt',
          kind: 'collection',
          itemSource: 'settings_plan',
          itemKey: 'settings',
          inputs: [{ from: 'settings_plan', usage: 'input' }],
          outputs: { format: 'json', pattern: 'prompts/setting_images/{{item_id}}.json' },
          runner: { tool: 'llm.fake', config: { name: 'setting_image_prompt' } },
        },
        {
          id: 'setting_image',
          kind: 'collection',
          itemSource: 'setting_image_prompt',
          inputs: [{ from: 'setting_image_prompt', usage: 'input', scope: 'matching' }],
          outputs: { format: 'image', pattern: 'assets/images/settings/{{item_id}}.png' },
          runner: { tool: 'comfy.fake', config: { name: 'setting_image' } },
        },
      ],
    };

    mkdirSync(join(projectDir, 'assets/uploads/settings'), { recursive: true });
    writeFileSync(join(projectDir, 'assets/uploads/settings/everest.png'), 'uploaded-everest');
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        inputs: [
          {
            id: 'setting-ref-1',
            source: { type: 'local_path', value: 'assets/uploads/settings/everest.png' },
            mediaType: 'image',
            purpose: 'setting_ref',
            metadata: {
              originalFilename: 'everest.png',
              referenceRole: 'setting',
            },
            processing: {
              status: 'completed',
              localPath: 'assets/uploads/settings/everest.png',
            },
          },
        ],
      }),
    );

    const reg = getGlobalRegistry();
    reg.register(
      { tool: 'settings.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      {
        describe: () => ({
          id: 'settings.fake',
          displayName: 'settings',
          description: 'settings',
          capabilities: [],
          modalities: { input: [], output: [] },
          configSchema: {},
        }),
        async run(ctx): Promise<RunnerResult> {
          const outputPath = ctx.node.runner.config['outputPath'] as string;
          const outAbs = join(ctx.projectDir, outputPath);
          mkdirSync(join(outAbs, '..'), { recursive: true });
          writeFileSync(
            outAbs,
            JSON.stringify({
              settings: [
                { id: 'everest_base_camp', name: 'Everest Base Camp' },
              ],
            }),
          );
          return { ok: true, outputPath };
        },
      },
    );
    reg.register(
      { tool: 'llm.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes }),
    );
    reg.register(
      { tool: 'comfy.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      {
        describe: () => ({
          id: 'comfy.fake',
          displayName: 'comfy',
          description: 'comfy',
          capabilities: [],
          modalities: { input: [], output: [] },
          configSchema: {},
        }),
        async run(): Promise<RunnerResult> {
          return { ok: false, error: 'comfy.fake should not run for a bound setting reference' };
        },
      },
    );

    const result = await walkBundle({
      projectDir,
      bundle,
      bundleSource: 'built-in:setting-ref-bundle',
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(projectDir, 'assets/images/settings/everest_base_camp.png'), 'utf8')).toBe('uploaded-everest');
    expect(ranNodes).toEqual(['setting_image_prompt']);
    const state = loadWalkState(projectDir);
    expect(state?.nodes['setting_image:everest_base_camp']?.metadata).toMatchObject({
      generationTool: 'project.setting_reference',
      userSupplied: true,
      settingReference: {
        sourcePath: 'assets/uploads/settings/everest.png',
        strategy: 'single_reference_first_setting',
      },
    });
  });
});

// ── Ready-node scheduling ─────────────────────────────────────────────

describe('runner phase scheduling', () => {
  it('drains ready llm.* nodes before dispatching ready media nodes', async () => {
    const reg = getGlobalRegistry();
    reg.register(
      { tool: 'llm.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes }),
    );
    reg.register(
      { tool: 'comfy.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes }),
    );
    reg.register(
      { tool: 'stub.final', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes }),
    );

    const result = await walkBundle({
      projectDir,
      bundle: TEXT_FIRST_BUNDLE,
      bundleSource: 'built-in:text-first',
    });

    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual([
      'story',
      'character_image_prompt',
      'settings_plan',
      'scene_video_prompt',
      'character_image',
      'final',
    ]);
  });

  it('still drains llm.* first when an llm node has a previousN self-edge (relay/chain bundles)', async () => {
    const reg = getGlobalRegistry();
    reg.register(
      { tool: 'llm.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes }),
    );
    reg.register(
      { tool: 'comfy.fake', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes }),
    );
    reg.register(
      { tool: 'stub.final', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes }),
    );

    // Same graph as TEXT_FIRST_BUNDLE, but character_image_prompt reads its
    // own prior outputs via previousN — the relay/chain-bundle pattern
    // (shot_image_prompt reading shot_image_prompt). Before the self-edge
    // guard this stalled the Kahn drain, tripped the fallback, and left the
    // bundle in unprioritized order (media interleaved with llm work).
    const SELF_EDGE_BUNDLE: DagBundle = {
      ...TEXT_FIRST_BUNDLE,
      id: 'text-first-self-edge',
      nodes: TEXT_FIRST_BUNDLE.nodes.map((n) =>
        n.id === 'character_image_prompt'
          ? {
              ...n,
              inputs: [
                ...n.inputs,
                { from: 'character_image_prompt', usage: 'context', scope: 'previousN', n: 5 },
              ],
            }
          : n,
      ),
    };

    const result = await walkBundle({
      projectDir,
      bundle: SELF_EDGE_BUNDLE,
      bundleSource: 'built-in:text-first-self-edge',
    });

    expect(result.ok).toBe(true);
    // The media node (character_image) must still come after BOTH downstream
    // llm nodes — i.e. the optimization engaged despite the self-edge.
    expect(ranNodes).toEqual([
      'story',
      'character_image_prompt',
      'settings_plan',
      'scene_video_prompt',
      'character_image',
      'final',
    ]);
  });
});
