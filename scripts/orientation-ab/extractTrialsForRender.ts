/**
 * Bridge: take the trial outputs already produced by generateAndGrade.ts
 * (in results/live_guide_prompts/*.json) and emit per-trial render-ready
 * prompt JSONs into results/prompts/ in the format renderPrompts.ts expects.
 *
 * No new LLM calls. Just unpacks the existing trials[] arrays.
 *
 * Output: results/prompts/<shotId>__live_tN.json with shape:
 *   { shotId, condition: "live_tN", llmResponse, passedAutoGrader, failures }
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TRIALS_DIR = path.join(SCRIPT_DIR, 'results', 'live_guide_prompts');
const RENDER_PROMPTS_DIR = path.join(SCRIPT_DIR, 'results', 'prompts');

function main() {
  if (!existsSync(TRIALS_DIR)) throw new Error(`Trials dir missing: ${TRIALS_DIR}. Run generateAndGrade.ts first.`);
  mkdirSync(RENDER_PROMPTS_DIR, { recursive: true });

  let emitted = 0;
  for (const f of readdirSync(TRIALS_DIR).sort()) {
    if (!f.endsWith('.json') || f === 'summary.json') continue;
    const raw = JSON.parse(readFileSync(path.join(TRIALS_DIR, f), 'utf-8'));
    if (!raw.trials || !Array.isArray(raw.trials)) {
      console.warn(`[skip] ${f}: no trials[] array`);
      continue;
    }
    const shotId = raw.shotId;
    for (let i = 0; i < raw.trials.length; i++) {
      const t = raw.trials[i];
      const condition = `live_t${i + 1}`;
      const outPath = path.join(RENDER_PROMPTS_DIR, `${shotId}__${condition}.json`);
      writeFileSync(
        outPath,
        JSON.stringify(
          {
            shotId,
            condition,
            llmResponse: t.prose,
            passedAutoGrader: t.failures.length === 0,
            failures: t.failures,
          },
          null,
          2,
        ),
      );
      emitted++;
      console.log(`[ok] ${path.basename(outPath)}  ${t.failures.length === 0 ? '✓' : '✗ ' + t.failures.join(', ')}`);
    }
  }
  console.log(`\n[done] ${emitted} prompts written to ${RENDER_PROMPTS_DIR}`);
  console.log(`\nNow render with:`);
  console.log(`  COMFYUI_BASE_URL=https://comfyui.share.zrok.io COMFY_MODE=local npx tsx scripts/orientation-ab/renderPrompts.ts --condition live_t1`);
  console.log(`(repeat for live_t2, live_t3 — or omit --condition to render all)`);
}

main();
