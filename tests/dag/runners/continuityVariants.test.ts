/**
 * Phase 2 — continuity.state_variants runner.
 *
 * Deterministically enumerates the distinct character APPEARANCE variants
 * (from the continuity ledger) that each need their own minted reference
 * image, enriched with the character's name + base description from
 * characters_plan. This JSON is the itemSource the minting collection fans
 * out over. No LLM, no network — pure projection written to disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createContinuityVariantsRunner } from '../../../src/dag/runners/continuityVariants.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

const LEDGER = {
  characters: [
    {
      id: 'mira',
      events: [
        { atShot: 'scene_2_shot_1', facets: { condition: 'soaked, dripping', hair: 'loose, wet' } },
        { atShot: 'scene_3_shot_1', facets: { condition: 'soaked, streaked with mud' } },
        // props-only change → must NOT add a 3rd variant
        { atShot: 'scene_3_shot_4', facets: { props: ['lit torch'] } },
      ],
    },
  ],
};
const CHARS = {
  characters: [{ id: 'mira', name: 'Mira', description: 'A cave diver in a sleek black wetsuit, hair in a tight braid.' }],
};

let projectDir: string;
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'cv-proj-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function makeCtx(inputs: Record<string, unknown>): RunnerContext {
  const node: NodeDef = {
    id: 'character_state_variants',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'json', pattern: 'plans/state_variants.json' },
    runner: { tool: 'continuity.state_variants', config: { outputPath: 'plans/state_variants.json' } },
  };
  return { projectDir, node, inputs, log: () => {} } as RunnerContext;
}

function readVariants(rel: string): { variants: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(projectDir, rel), 'utf8'));
}

describe('continuity.state_variants runner', () => {
  it('enumerates appearance variants and enriches with name + base description', async () => {
    const runner = createContinuityVariantsRunner();
    const result = await runner.run(makeCtx({ continuity_plan: LEDGER, characters_plan: CHARS }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { variants } = readVariants(result.outputPath);

    // mira diverges in appearance twice (soaked, then soaked+muddy); the
    // props-only event collapses → exactly 2 variants.
    expect(variants).toHaveLength(2);
    for (const v of variants) {
      expect(v['charId']).toBe('mira');
      expect(String(v['id']).startsWith('mira__')).toBe(true);
      expect(v['refKey']).not.toBe('base');
      expect(v['characterName']).toBe('Mira');
      expect(String(v['baseDescription'])).toContain('cave diver');
      // appearance facets only — never props/posture.
      expect(v['facets']).not.toHaveProperty('props');
    }
    // The muddy variant carries the condition change.
    expect(variants.some((v) => String((v['facets'] as Record<string, unknown>)['condition']).includes('mud'))).toBe(true);
  });

  it('writes an empty manifest when there is no continuity plan', async () => {
    const runner = createContinuityVariantsRunner();
    const result = await runner.run(makeCtx({ characters_plan: CHARS }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readVariants(result.outputPath).variants).toEqual([]);
  });

  it('still enumerates variants when characters_plan is missing (no enrichment)', async () => {
    const runner = createContinuityVariantsRunner();
    const result = await runner.run(makeCtx({ continuity_plan: LEDGER }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { variants } = readVariants(result.outputPath);
    expect(variants).toHaveLength(2);
    expect(variants[0]).not.toHaveProperty('characterName');
  });
});
