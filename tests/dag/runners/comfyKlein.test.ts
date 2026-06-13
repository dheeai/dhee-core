/**
 * comfy.klein — Flux 2 Klein reference-edit runner.
 *
 * Tests run against the REAL klein.json + klein.manifest.json (copied
 * into a temp bundle), so the prune-on-absent node ids and the
 * ReferenceLatent chain rewiring are exercised for real — not against a
 * hand-rolled stub that could drift from the shipped workflow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createComfyKleinRunner } from '../../../src/dag/runners/comfyKlein.js';
import { refKeyForCharacterAtShot } from '../../../src/dag/runners/characterState.js';
import type { ComfyImageClient } from '../../../src/dag/runners/comfyExecutor.js';
import { writeAliases } from '../../../src/dag/workflowAliases.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

const REAL_KLEIN = resolve('src/dag/bundles/narrative_prompt_relay/workflows/klein.json');
const REAL_KLEIN_MANIFEST = resolve('src/dag/bundles/narrative_prompt_relay/workflows/klein.manifest.json');

interface Stub {
  queued: Array<Record<string, { inputs: Record<string, unknown>; class_type?: string }>>;
  uploads: string[];
}
function makeStubClient(stub: Stub): ComfyImageClient {
  return {
    async uploadImage(p) {
      stub.uploads.push(p);
      return { name: `up_${p.split('/').pop()}` };
    },
    async queueAndWait(wf) {
      stub.queued.push(wf as never);
      return { outputs: [{ filename: 'klein_out.png' }] };
    },
    async downloadOutput(_f, _s, destPath) {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(destPath, '..'), { recursive: true });
      await fs.writeFile(destPath, Buffer.from('png'));
    },
  };
}

let bundleDir: string;
let projectDir: string;
let savedMode: string | undefined;
let savedCas: string | undefined;
let base: string;
let r1: string;
let r2: string;
let r3: string;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'klein-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'klein-proj-'));
  mkdirSync(join(bundleDir, 'workflows'), { recursive: true });
  copyFileSync(REAL_KLEIN, join(bundleDir, 'workflows/klein.json'));
  copyFileSync(REAL_KLEIN_MANIFEST, join(bundleDir, 'workflows/klein.manifest.json'));
  for (const [name, v] of [['base', 'b'], ['r1', '1'], ['r2', '2'], ['r3', '3']] as const) {
    const p = join(projectDir, `${name}.png`);
    writeFileSync(p, Buffer.from(v));
    if (name === 'base') base = p;
    else if (name === 'r1') r1 = p;
    else if (name === 'r2') r2 = p;
    else r3 = p;
  }
  savedMode = process.env['COMFY_MODE'];
  savedCas = process.env['DHEE_DISABLE_CAS'];
  process.env['COMFY_MODE'] = 'cloud';
  process.env['DHEE_DISABLE_CAS'] = '1';
  process.env['ENDPOINT_test_endpoint'] = 'http://stub.local:8188';
});
afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  delete process.env['ENDPOINT_test_endpoint'];
  if (savedMode === undefined) delete process.env['COMFY_MODE'];
  else process.env['COMFY_MODE'] = savedMode;
  if (savedCas === undefined) delete process.env['DHEE_DISABLE_CAS'];
  else process.env['DHEE_DISABLE_CAS'] = savedCas;
});

function makeCtx(config: Record<string, unknown>, inputs: Record<string, unknown> = {}): RunnerContext {
  const node: NodeDef = {
    id: 'shot_image',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'image', pattern: 'out.png' },
    runner: { tool: 'comfy.klein', config },
  };
  return { projectDir, bundleDir, node, inputs, itemId: 'scene_1_shot_1', log: () => {} };
}

const baseConfig = () => ({
  workflowPath: 'workflows/klein.json',
  manifestPath: 'workflows/klein.manifest.json',
  endpoint: 'test.endpoint',
  prompt: 'a dusty 1970s street',
  width: 1920,
  height: 1080,
  outputPath: 'out.png',
});

describe('comfy.klein — prune-on-absent reference chain', () => {
  it('with base + 1 reference, prunes ref slots 3 & 4 and rewires CFGGuider to ref-2 latents', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(makeCtx({ ...baseConfig(), baseImage: base, referenceImages: [r1] }));

    expect(result.ok).toBe(true);
    const wf = stub.queued[0]!;
    // base (76) + reference_image_1 (81) present & wired to uploads.
    expect(wf['76']!.inputs['image']).toBe('up_base.png');
    expect(wf['81']!.inputs['image']).toBe('up_r1.png');
    // reference_image_2 (82) and reference_image_3 (83) branches pruned.
    expect(wf['82']).toBeUndefined();
    expect(wf['83']).toBeUndefined();
    expect(wf['92:88:77']).toBeUndefined();
    expect(wf['92:89:77']).toBeUndefined();
    // CFGGuider (92:63) now reads ref-2's ReferenceLatent outputs.
    expect(wf['92:63']!.inputs['positive']).toEqual(['92:84:77', 0]);
    expect(wf['92:63']!.inputs['negative']).toEqual(['92:84:76', 0]);
  });

  it('with base only, prunes all 3 optional refs and rewires CFGGuider to the base latents', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(makeCtx({ ...baseConfig(), baseImage: base }));

    expect(result.ok).toBe(true);
    const wf = stub.queued[0]!;
    expect(wf['76']!.inputs['image']).toBe('up_base.png');
    expect(wf['81']).toBeUndefined();
    expect(wf['82']).toBeUndefined();
    expect(wf['83']).toBeUndefined();
    // Falls all the way back to base's ReferenceLatent (92:79:*).
    expect(wf['92:63']!.inputs['positive']).toEqual(['92:79:77', 0]);
    expect(wf['92:63']!.inputs['negative']).toEqual(['92:79:76', 0]);
    // Only the base image was uploaded.
    expect(stub.uploads).toEqual([base]);
  });

  it('with base + 3 references, prunes nothing and keeps the full chain', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(makeCtx({ ...baseConfig(), baseImage: base, referenceImages: [r1, r2, r3] }));

    expect(result.ok).toBe(true);
    const wf = stub.queued[0]!;
    expect(wf['81']!.inputs['image']).toBe('up_r1.png');
    expect(wf['82']!.inputs['image']).toBe('up_r2.png');
    expect(wf['83']!.inputs['image']).toBe('up_r3.png');
    // Full chain intact → CFGGuider still on ref-4 latents.
    expect(wf['92:63']!.inputs['positive']).toEqual(['92:89:77', 0]);
    expect(wf['92:63']!.inputs['negative']).toEqual(['92:89:76', 0]);
  });
});

describe('comfy.klein — reference resolution from shot prompt', () => {
  it('resolves references[] against character_image / setting_image maps into base + refs', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
    const harper = join(projectDir, 'harper.png');
    const joyce = join(projectDir, 'joyce.png');
    writeFileSync(harper, Buffer.from('h'));
    writeFileSync(joyce, Buffer.from('j'));

    const result = await runner.run(
      makeCtx(
        { ...baseConfig(), prompt: undefined }, // force prompt resolution from upstream
        {
          shot_image_prompt: {
            imagePrompt: 'wide shot of harper crossing',
            references: [
              { id: 'harper', type: 'setting' },
              { id: 'joyce', type: 'character' },
            ],
          },
          setting_image: { harper },
          character_image: { joyce },
        },
      ),
    );

    expect(result.ok).toBe(true);
    const wf = stub.queued[0]!;
    // First reference (setting) → base_image (node 76); second → reference_image_1 (node 81).
    expect(wf['76']!.inputs['image']).toBe('up_harper.png');
    expect(wf['81']!.inputs['image']).toBe('up_joyce.png');
    // Prompt came from the upstream shot prompt.
    expect(wf['109']!.inputs['text']).toBe('wide shot of harper crossing');
    // Slots 3 & 4 pruned (only 2 references).
    expect(wf['82']).toBeUndefined();
    expect(wf['83']).toBeUndefined();
  });

  it('fails clearly when the shot prompt has zero resolvable references (base_image required)', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(
      makeCtx(
        { ...baseConfig(), prompt: undefined },
        { shot_image_prompt: { imagePrompt: 'a close-up of someone never generated', references: [] } },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/required input 'base_image'/);
    expect(stub.queued.length).toBe(0);
  });
});

describe('comfy.klein — guards & aliases', () => {
  it('rejects more than 3 reference images', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(
      makeCtx({ ...baseConfig(), baseImage: base, referenceImages: [r1, r2, r3, base] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at most 3|reference/i);
  });

  it('applies a persisted model alias to UNETLoader before queueing', async () => {
    const aliasesDir = mkdtempSync(join(tmpdir(), 'klein-aliases-'));
    const saved = process.env['DHEE_WORKFLOW_ALIASES_DIR'];
    process.env['DHEE_WORKFLOW_ALIASES_DIR'] = aliasesDir;
    try {
      writeAliases(aliasesDir, process.env['ENDPOINT_test_endpoint']!, {
        name_aliases: { 'flux-2-klein-9b.safetensors': 'flux-2-klein-q8.safetensors' },
      });
      const stub: Stub = { queued: [], uploads: [] };
      const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
      const result = await runner.run(makeCtx({ ...baseConfig(), baseImage: base }));
      expect(result.ok).toBe(true);
      // klein.json UNETLoader is node 92:70.
      expect(stub.queued[0]!['92:70']!.inputs['unet_name']).toBe('flux-2-klein-q8.safetensors');
    } finally {
      if (saved === undefined) delete process.env['DHEE_WORKFLOW_ALIASES_DIR'];
      else process.env['DHEE_WORKFLOW_ALIASES_DIR'] = saved;
      rmSync(aliasesDir, { recursive: true, force: true });
    }
  });
});

describe('comfy.klein — state-aware character reference resolution', () => {
  it('uses the state-variant reference when the character has diverged at this shot', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
    const miraBase = join(projectDir, 'mira.png');
    const miraVariant = join(projectDir, 'mira_v.png');
    writeFileSync(miraBase, Buffer.from('mb'));
    writeFileSync(miraVariant, Buffer.from('mv'));
    // Mira diverges (muddy) exactly at this shot (scene_1_shot_1).
    const ledger = {
      characters: [{ id: 'mira', events: [{ atShot: 'scene_1_shot_1', facets: { condition: 'soaked, muddy' } }] }],
    };
    const refKey = refKeyForCharacterAtShot(ledger, 'scene_1_shot_1', 'mira');
    expect(refKey).not.toBe('base');

    const result = await runner.run(
      makeCtx(
        { ...baseConfig(), prompt: undefined },
        {
          shot_image_prompt: { imagePrompt: 'mira on the ledge', references: [{ id: 'mira', type: 'character' }] },
          character_image: { mira: miraBase },
          character_state_image: { [`mira__${refKey}`]: miraVariant },
          continuity_plan: ledger,
        },
      ),
    );

    expect(result.ok).toBe(true);
    // base_image (node 76) is the VARIANT, not the clean portrait.
    expect(stub.queued[0]!['76']!.inputs['image']).toBe('up_mira_v.png');
  });

  it('falls back to the base portrait when the character is in base state at this shot (counter-test)', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
    const miraBase = join(projectDir, 'mira.png');
    const miraVariant = join(projectDir, 'mira_v.png');
    writeFileSync(miraBase, Buffer.from('mb'));
    writeFileSync(miraVariant, Buffer.from('mv'));
    // The change is anchored in the FUTURE (scene_2) → base at scene_1_shot_1.
    const ledger = {
      characters: [{ id: 'mira', events: [{ atShot: 'scene_2_shot_1', facets: { condition: 'soaked' } }] }],
    };
    const futureKey = refKeyForCharacterAtShot(ledger, 'scene_2_shot_1', 'mira');

    const result = await runner.run(
      makeCtx(
        { ...baseConfig(), prompt: undefined },
        {
          shot_image_prompt: { imagePrompt: 'mira at dawn', references: [{ id: 'mira', type: 'character' }] },
          character_image: { mira: miraBase },
          // The variant image EXISTS, but must not be used at a base-state shot.
          character_state_image: { [`mira__${futureKey}`]: miraVariant },
          continuity_plan: ledger,
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(stub.queued[0]!['76']!.inputs['image']).toBe('up_mira.png');
  });

  it('without continuity inputs, resolves to the base portrait (backward compatible)', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyKleinRunner({ clientFactory: () => makeStubClient(stub) });
    const miraBase = join(projectDir, 'mira.png');
    writeFileSync(miraBase, Buffer.from('mb'));

    const result = await runner.run(
      makeCtx(
        { ...baseConfig(), prompt: undefined },
        {
          shot_image_prompt: { imagePrompt: 'mira', references: [{ id: 'mira', type: 'character' }] },
          character_image: { mira: miraBase },
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(stub.queued[0]!['76']!.inputs['image']).toBe('up_mira.png');
  });
});
