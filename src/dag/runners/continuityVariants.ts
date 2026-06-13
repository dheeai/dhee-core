/**
 * `continuity.state_variants` — deterministic variant manifest runner.
 *
 * Reads the continuity ledger (continuity_plan) + the cast (characters_plan)
 * and enumerates the distinct character APPEARANCE variants that each need
 * their own minted reference image (see enumerateStateVariants — props /
 * posture are excluded, so the count is bounded by real wardrobe/condition
 * changes). Each variant is enriched with the character's name + base
 * description so the downstream edit-prompt LLM can write "same person, now
 * <appearance>" without re-reading characters_plan per item.
 *
 * Output JSON: { variants: [{ id, charId, refKey, facets, characterName?,
 * baseDescription? }] }. The minting collection fans out over `variants`.
 *
 * No LLM, no network — a pure projection written to disk; the inputs arrive
 * via ctx.inputs (declared bundle inputs), not direct file reads.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Runner, RunnerContext, RunnerResult, RunnerDescription } from '../schema.js';
import { enumerateStateVariants } from './characterState.js';

interface CharacterMeta {
  name?: string;
  description?: string;
}

function loadCharacterMeta(value: unknown): Map<string, CharacterMeta> {
  const map = new Map<string, CharacterMeta>();
  const chars = (value as { characters?: unknown } | undefined)?.characters;
  if (!Array.isArray(chars)) return map;
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    if (typeof r['id'] !== 'string') continue;
    const meta: CharacterMeta = {};
    if (typeof r['name'] === 'string') meta.name = r['name'];
    if (typeof r['description'] === 'string') meta.description = r['description'];
    map.set(r['id'], meta);
  }
  return map;
}

export function createContinuityVariantsRunner(): Runner {
  const describe = (): RunnerDescription => ({
    id: 'continuity.state_variants',
    displayName: 'Continuity State Variants',
    description:
      'Deterministically enumerates the distinct character appearance variants (outfit / condition / hair) from the continuity ledger that each need a minted reference image, enriched with the character name + base description. No LLM or network.',
    capabilities: ['planning', 'json-generation'],
    modalities: { input: ['text'], output: ['text'] },
    configSchema: {
      type: 'object',
      required: ['outputPath'],
      properties: {
        outputPath: { type: 'string' },
        continuityInput: { type: 'string' },
        charactersInput: { type: 'string' },
      },
    },
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const cfg = ctx.node.runner.config as Record<string, unknown>;
    const outputPath = cfg['outputPath'];
    if (typeof outputPath !== 'string') {
      return { ok: false, error: 'continuity.state_variants: config.outputPath (string) is required' };
    }
    const continuityInput = typeof cfg['continuityInput'] === 'string' ? cfg['continuityInput'] : 'continuity_plan';
    const charactersInput = typeof cfg['charactersInput'] === 'string' ? cfg['charactersInput'] : 'characters_plan';

    const variants = enumerateStateVariants(ctx.inputs[continuityInput]);
    const meta = loadCharacterMeta(ctx.inputs[charactersInput]);

    const enriched = variants.map((v) => {
      const m = meta.get(v.charId);
      return {
        id: v.id,
        charId: v.charId,
        refKey: v.refKey,
        facets: v.facets,
        ...(m?.name ? { characterName: m.name } : {}),
        ...(m?.description ? { baseDescription: m.description } : {}),
      };
    });

    const outAbs = resolve(ctx.projectDir, outputPath);
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, `${JSON.stringify({ variants: enriched }, null, 2)}\n`);

    return {
      ok: true,
      outputPath,
      metadata: { generationTool: 'continuity.state_variants', variantCount: enriched.length },
    };
  }

  return { describe, run };
}

export const continuityVariantsRunner = createContinuityVariantsRunner();
