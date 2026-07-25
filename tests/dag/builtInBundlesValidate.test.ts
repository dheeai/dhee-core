import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getGlobalRegistry } from '../../src/dag/runners/registry.js';
import '../../src/dag/runners/index.js';
import type { DagBundle } from '../../src/dag/schema.js';

const BUNDLE_IDS = [
  'narrative_prompt_relay',
  'narrative_shot_by_shot',
  'narrative_text_only',
  'narrative_text_video',
  'narrative_qwen_chain_relay',
  'narrative_qwen_chain_review',
  'narrative_klein_relay_review',
] as const;

const BUNDLES_DIR = resolve(__dirname, '../../src/dag/bundles');

// Runners these bundles declare that now ship as EXTERNAL packages, discovered
// from the npm ecosystem at runtime rather than registered as built-ins. Stub
// them into the registry so this structural check stays honest without
// depending on the external packages being installed in CI.
//
// This list only grows as dheeai/dhee-core#191 proceeds. It is also the signal
// that this whole file belongs in the bundle repos (#192): it validates PRODUCT
// bundles, so every runner they externalize adds a stub here.
const EXTERNAL_RUNNER_STUBS: Array<{
  tool: string;
  version: string;
  displayName: string;
  pkg: string;
  output: 'video' | 'image';
}> = [
  {
    tool: 'comfy.ltx_director',
    version: '0.2.0',
    displayName: 'LTX Director',
    pkg: 'dhee-runner-ltx-director',
    output: 'video',
  },
  {
    tool: 'comfy.qwen_edit_chain',
    version: '0.2.0',
    displayName: 'Comfy Qwen Edit chain',
    pkg: 'dhee-runner-qwen-edit-chain',
    output: 'image',
  },
  {
    // RETIRED rather than externalized: comfy.klein's node-id prune table is now
    // editConfig data in each bundle's klein.manifest.json, driven by
    // comfy.image_edit. Bundles still naming comfy.klein are stale.
    tool: 'comfy.klein',
    version: '0.1.0',
    displayName: 'Comfy Klein (retired → comfy.image_edit)',
    pkg: 'dhee-runner-image-edit',
    output: 'image',
  },
];
{
  const reg = getGlobalRegistry();
  for (const s of EXTERNAL_RUNNER_STUBS) {
    if (reg.get(s.tool)) continue;
    reg.register(
      { tool: s.tool, version: s.version, engineCompat: '>=0.1.0', credentials: [] },
      {
        describe: () => ({
          id: s.tool,
          displayName: `${s.displayName} (external stub)`,
          description: `Provided by ${s.pkg} (external).`,
          capabilities: [],
          modalities: { input: ['image', 'text'], output: [s.output] },
          configSchema: {},
        }),
        run: async () => ({ ok: true as const, outputPath: '' }),
      },
    );
  }
}

function loadBundle(id: string): DagBundle {
  return JSON.parse(readFileSync(join(BUNDLES_DIR, id, 'bundle.json'), 'utf-8')) as DagBundle;
}

describe('built-in narrative bundles', () => {
  it('all seven validate against the registered built-in runners', () => {
    const reg = getGlobalRegistry();
    const failures: Record<string, string[]> = {};

    for (const id of BUNDLE_IDS) {
      const result = reg.validateBundle(loadBundle(id));
      if (!result.ok) failures[id] = result.errors;
    }

    expect(failures).toEqual({});
  });

  it('motion directive nodes require transition in their output schema', () => {
    for (const id of BUNDLE_IDS) {
      const bundle = loadBundle(id);
      const motionNode = bundle.nodes.find((node) => node.id === 'shot_motion_directive');
      if (!motionNode) continue;

      const cfg = motionNode.runner.config as Record<string, string | undefined>;
      expect(cfg.outputSchema, `${id}: shot_motion_directive must declare outputSchema`).toBe(
        'schemas/shot_motion_directive.schema.json',
      );

      const schema = JSON.parse(
        readFileSync(join(BUNDLES_DIR, id, cfg.outputSchema as string), 'utf-8'),
      ) as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required, `${id}: motion schema must require transition`).toContain('transition');
      expect(schema.properties?.transition, `${id}: motion schema must define transition`).toBeTruthy();
    }
  });
});
