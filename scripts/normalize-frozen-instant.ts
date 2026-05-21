#!/usr/bin/env tsx
/**
 * One-shot: re-apply enforceFrozenInstant to every existing
 * shot_image_prompt JSON in a project. The assembler now normalizes
 * banned motion verbs deterministically, but prompts written before
 * the assembler was updated still carry the violations.
 *
 * Usage:
 *   pnpm tsx scripts/normalize-frozen-instant.ts <project>
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const [projectArg] = process.argv.slice(2);
if (!projectArg) {
  console.error('Usage: pnpm tsx scripts/normalize-frozen-instant.ts <project>');
  process.exit(1);
}
const projectRoot = resolve(process.cwd(), projectArg.endsWith('.kshana') ? projectArg : `${projectArg}.kshana`);
if (!existsSync(projectRoot)) { console.error(`Project not found: ${projectRoot}`); process.exit(1); }

const FROZEN_INSTANT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bbeginning to\s+/gi, ''],
  [/\bstarting to\s+/gi, ''],
  [/\bflickering\b/gi, 'flame-lit'],
  [/\bcrumbling\b/gi, 'crumbled'],
  [/\bfalling\b/gi, 'mid-fall'],
  [/\bstreaming\b/gi, 'streamed'],
  [/\bslipping\b/gi, 'mid-slip'],
  [/\bwalking\b/gi, 'mid-stride'],
  [/\brunning\b/gi, 'mid-stride'],
  [/\bsprinting\b/gi, 'mid-stride'],
  [/\bdashing\b/gi, 'mid-dash'],
  [/\bsmoldering\b/gi, 'smoke-stained'],
  [/\bdrifting\b/gi, 'suspended'],
  [/\bfloating\b/gi, 'suspended'],
  [/\bsliding\b/gi, 'mid-slide'],
  [/\bswinging\b/gi, 'mid-swing'],
  [/\blunging\b/gi, 'mid-lunge'],
  [/\bleaping\b/gi, 'mid-leap'],
  [/\bcharging\b/gi, 'mid-charge'],
  [/\bdodging\b/gi, 'angled aside'],
  [/\bstumbling\b/gi, 'mid-stumble'],
  [/\bscrambling\b/gi, 'mid-scramble'],
  [/\berupting\b/gi, 'risen'],
  [/\bexploding\b/gi, 'shattered'],
  [/\bdissolving\b/gi, 'partially dissolved'],
  [/\btransforming\b/gi, 'mid-transformation'],
  [/\bcollapsing\b/gi, 'partially collapsed'],
  [/\brecoiling\b/gi, 'recoiled'],
  [/\bfleeing\b/gi, 'mid-flight'],
  [/\bcrashing\b/gi, 'crashed'],
  [/\bapproaching\b/gi, 'closer'],
  [/\badvancing\b/gi, 'forward'],
  [/\breceding\b/gi, 'distant'],
  [/\bspinning\b/gi, 'mid-spin'],
  [/\bspewing\b/gi, 'mid-spew'],
];

function enforce(prose: string): string {
  let out = prose;
  for (const [p, r] of FROZEN_INSTANT_REPLACEMENTS) out = out.replace(p, r);
  return out.replace(/\s{2,}/g, ' ').trim();
}

const shotsDir = join(projectRoot, 'prompts/images/shots');
if (!existsSync(shotsDir)) { console.error('no shots dir'); process.exit(0); }

const files = readdirSync(shotsDir).filter(f => f.endsWith('.json') && !f.endsWith('.failed'));
let modified = 0;
let totalReplacements = 0;
for (const f of files) {
  const path = join(shotsDir, f);
  const j = JSON.parse(readFileSync(path, 'utf-8'));
  let changed = false;
  const ff = j.frames?.first_frame;
  const lf = j.frames?.last_frame;
  if (ff?.imagePrompt) {
    const before = ff.imagePrompt;
    const after = enforce(before);
    if (before !== after) {
      ff.imagePrompt = after;
      changed = true;
      // Count replacements roughly by counting "mid-" or "frame-lit" or stripped fragments
      for (const [p] of FROZEN_INSTANT_REPLACEMENTS) {
        const ms = before.match(p);
        if (ms) totalReplacements += ms.length;
      }
    }
  }
  if (lf?.imagePrompt) {
    const before = lf.imagePrompt;
    const after = enforce(before);
    if (before !== after) {
      lf.imagePrompt = after;
      changed = true;
      for (const [p] of FROZEN_INSTANT_REPLACEMENTS) {
        const ms = before.match(p);
        if (ms) totalReplacements += ms.length;
      }
    }
  }
  if (changed) {
    writeFileSync(path, JSON.stringify(j, null, 2));
    modified += 1;
  }
}
console.log(`normalized ${modified} files (${totalReplacements} replacements made)`);
