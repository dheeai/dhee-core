/**
 * Diagnostic: confirm root cause is "LLM trusts shotDescription over guide".
 *
 * Test: re-run scene-2-shot-1 with the CURRENT guide but the
 * shotDescription pre-edited to remove face cues. If the LLM now produces
 * back-to-camera prose, the fix lives upstream at scene_breakdown — not
 * at the shot_image_prompt guide.
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildRouterFromEnv } from '../../src/core/llm/router.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Allow swapping the guide via env var: GUIDE=proposed_v3 → load proposed_v3_guide.md
const GUIDE_NAME = process.env['GUIDE'] ?? 'current';
const CURRENT_GUIDE_PATH =
  GUIDE_NAME === 'current'
    ? path.join(SCRIPT_DIR, '..', '..', 'prompts', 'skills', 'defaults', 'shot_image_prompt_guide.md')
    : path.join(SCRIPT_DIR, `${GUIDE_NAME}_guide.md`);
const WORLD_STYLE_PATH = '/Users/ganaraj/dhee-studios/Ruby V3/plans/world_style.md';
const OUT_PATH = path.join(
  SCRIPT_DIR,
  'results',
  'prompts',
  `scene-2-shot-1__diagnostic__${GUIDE_NAME}__${process.argv[2] ?? 'pre_edited'}.json`,
);

async function main() {
  const guide = readFileSync(CURRENT_GUIDE_PATH, 'utf-8');
  const worldStyle = existsSync(WORLD_STYLE_PATH) ? readFileSync(WORLD_STYLE_PATH, 'utf-8') : '';

  // Two variants:
  // (A) explicit back-to-camera direction in description
  // (B) face cues stripped but NO back-to-camera language — pure default test
  const variant = process.argv[2] ?? 'pre_edited';
  const preEditedDescription =
    variant === 'face_cues_stripped_only'
      ? // Removed "exchange a final look of shared determination" — kept everything else neutral
        'Ruby and Angel arrive at the weathered pawn shop facade, both stopped at the sidewalk under the harsh midday sun. Heat shimmer distorts the air around them.'
      : // Original pre_edited: explicit back-to-camera intent
        "Ruby and Angel approach the weathered pawn shop facade from the sidewalk, walking up to the entrance from behind the camera's perspective. The harsh midday sun beats down. Heat shimmer distorts the air between them and the facade.";

  const system = `You write a single image prompt paragraph. Output ONLY the paragraph — no JSON, no labels.\n\n${guide}\n\n---\n\nThis call is for the FIRST FRAME in mode "image_text_to_image". Follow the matching first-frame section above.`;

  const refList = [
    '- image 1: setting (ref_id: "setting_image:pawn_shop_exterior")',
    '- image 2: character (ref_id: "character_image:ruby")',
    '- image 3: character (ref_id: "character_image:angel")',
  ].join('\n');

  const user =
    `Shot description: ${preEditedDescription}\n` +
    `Camera: Medium wide shot, eye-level, static, heat haze visible, deep focus\n` +
    `Mode: image_text_to_image\n\n` +
    `References available:\n${refList}\n\n` +
    `<world_style>\n${worldStyle}\n</world_style>\n\n` +
    `Write the image prompt paragraph. Output ONLY the paragraph.`;

  const router = buildRouterFromEnv(process.cwd());
  const llm = router.getClient('content.shot_image_prompt');

  const chunks: string[] = [];
  for await (const chunk of llm.generateStream({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  })) {
    if (chunk.content) chunks.push(chunk.content);
  }
  const response = chunks.join('');
  console.log('=== diagnostic prompt (current guide + pre-edited description) ===');
  console.log(response);
  console.log('===');

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        shotId: 'scene-2-shot-1',
        condition: 'diagnostic_pre_edited',
        system,
        user,
        llmResponse: response,
        timestamp: Date.now(),
        note: 'shotDescription pre-edited to remove face cues; guide unchanged (current).',
      },
      null,
      2,
    ),
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
