/**
 * Phase 1: Generate first-frame image prompts for each test shot under
 * both conditions (CURRENT guide vs PROPOSED guide).
 *
 * Re-uses dhee's real LLM client (via buildRouterFromEnv → HEAVY tier)
 * so the model + provider exactly match production for
 * `content.shot_image_prompt`. Only the guide markdown swaps.
 *
 * Output: results/prompts/<shotId>__<condition>.json
 *   { shotId, condition, system, user, llmResponse, timestamp }
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildRouterFromEnv } from '../../src/core/llm/router.js';
import { SHOTS, type ShotFixture, type Reference } from './fixtures.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(SCRIPT_DIR, 'results', 'prompts');
const CURRENT_GUIDE_PATH = path.join(
  SCRIPT_DIR,
  '..',
  '..',
  'prompts',
  'skills',
  'defaults',
  'shot_image_prompt_guide.md',
);

type Condition = string;

// Project worldStyle — production reads plans/world_style.md and passes it
// as the <world_style> block in the user message. Harness must match.
const WORLD_STYLE_PATH = '/Users/ganaraj/dhee-studios/Ruby V3/plans/world_style.md';

// CLI args: --variant <name> --shot <shotId>
function parseArgs() {
  const args = process.argv.slice(2);
  const out: { variant?: string; shot?: string; condition?: Condition } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--variant' && args[i + 1]) out.variant = args[++i];
    else if (args[i] === '--shot' && args[i + 1]) out.shot = args[++i];
    else if (args[i] === '--condition' && args[i + 1]) out.condition = args[++i];
  }
  return out;
}

/** Replicates `buildFirstFramePrompt` from shotImagePipeline.ts exactly,
 *  except the guide is injected (not loaded from disk) so we can swap it.
 *  Now also includes worldStyle for production parity. */
function buildFirstFramePrompt(args: {
  guide: string;
  shotDescription: string;
  cameraWork: string;
  mode: ShotFixture['generationMode'];
  references: Reference[];
  worldStyle?: string;
}): { system: string; user: string } {
  const { guide, shotDescription, cameraWork, mode, references, worldStyle } = args;
  const system =
    `You write a single image prompt paragraph. Output ONLY the paragraph — no JSON, no labels.\n\n${guide}\n\n---\n\nThis call is for the FIRST FRAME in mode "${mode}". Follow the matching first-frame section above.`;

  const refList =
    references.length > 0
      ? `References available:\n${references
          .map(r => `- image ${r.imageNumber}: ${r.type} (ref_id: "${r.refId}")`)
          .join('\n')}`
      : 'No references — describe everything from text only.';

  let user =
    `Shot description: ${shotDescription}\n` +
    `Camera: ${cameraWork}\n` +
    `Mode: ${mode}\n\n` +
    `${refList}`;

  if (worldStyle) {
    user += `\n\n<world_style>\n${worldStyle}\n</world_style>`;
  }

  user += `\n\nWrite the image prompt paragraph. Output ONLY the paragraph.`;

  return { system, user };
}

async function callLLM(llm: any, system: string, user: string): Promise<string> {
  const options: any = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  };
  const chunks: string[] = [];
  for await (const chunk of llm.generateStream(options)) {
    if (chunk.content) chunks.push(chunk.content);
  }
  return chunks.join('');
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const argv = parseArgs();
  const variantName = argv.variant ?? 'proposed';
  const PROPOSED_GUIDE_PATH = path.join(SCRIPT_DIR, `${variantName}_guide.md`);

  if (!existsSync(CURRENT_GUIDE_PATH)) throw new Error(`current guide missing: ${CURRENT_GUIDE_PATH}`);
  if (!existsSync(PROPOSED_GUIDE_PATH)) throw new Error(`proposed guide missing: ${PROPOSED_GUIDE_PATH}`);

  const currentGuide = readFileSync(CURRENT_GUIDE_PATH, 'utf-8');
  const proposedGuide = readFileSync(PROPOSED_GUIDE_PATH, 'utf-8');
  const worldStyle = existsSync(WORLD_STYLE_PATH) ? readFileSync(WORLD_STYLE_PATH, 'utf-8') : undefined;
  console.log(`[harness] worldStyle: ${worldStyle ? `${worldStyle.length} chars` : 'MISSING'}`);

  // buildRouterFromEnv needs a projectDir for .llm-routing.json file lookup.
  // The Ruby V3 project has none so this falls through to env-only routing,
  // which is what we want — uses LLM_TIER_HEAVY_* from .env.
  const router = buildRouterFromEnv(process.cwd());
  const llm = router.getClient('content.shot_image_prompt');

  console.log(
    `[harness] Using router: enabled=${router.isEnabled()}. Resolved model for content.shot_image_prompt:`,
    router.resolveConfig('content.shot_image_prompt').model,
  );

  const conditions: Array<[Condition, string]> = [
    ['current', currentGuide],
    [variantName, proposedGuide],
  ];
  const shotFilter = argv.shot;
  const conditionFilter = argv.condition;

  for (const shot of SHOTS) {
    if (shotFilter && shot.shotId !== shotFilter) continue;
    for (const [condition, guide] of conditions) {
      if (conditionFilter && condition !== conditionFilter) continue;
      const outPath = path.join(RESULTS_DIR, `${shot.shotId}__${condition}.json`);
      if (existsSync(outPath)) {
        console.log(`[skip] ${shot.shotId} ${condition} (exists)`);
        continue;
      }
      const { system, user } = buildFirstFramePrompt({
        guide,
        shotDescription: shot.shotDescription,
        cameraWork: shot.cameraWork,
        mode: shot.generationMode,
        references: shot.references,
        worldStyle,
      });
      console.log(`[llm] ${shot.shotId} ${condition} …`);
      const t0 = Date.now();
      let llmResponse = '';
      try {
        llmResponse = await callLLM(llm, system, user);
      } catch (err: any) {
        console.error(`[ERR] ${shot.shotId} ${condition}:`, err.message);
        continue;
      }
      const elapsed = Date.now() - t0;
      console.log(
        `[ok ] ${shot.shotId} ${condition} (${elapsed}ms, ${llmResponse.length} chars)`,
      );
      writeFileSync(
        outPath,
        JSON.stringify(
          { shotId: shot.shotId, condition, system, user, llmResponse, elapsedMs: elapsed, timestamp: Date.now() },
          null,
          2,
        ),
      );
    }
  }

  console.log('[done] All prompts written to', RESULTS_DIR);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
