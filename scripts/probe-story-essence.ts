#!/usr/bin/env tsx
/**
 * Probe `extractStoryEssence` on a project's source story.
 *
 * Reads `<project>.dhee/original_input.md` (or chapters/.../story.md if
 * the input was an idea), calls the focused essence extractor, and
 * prints the resulting JSON. Does NOT modify any project state.
 *
 *   pnpm tsx scripts/probe-story-essence.ts <project-name>
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LLMClient } from '../src/core/llm/index.js';
import { buildRouterFromEnv } from '../src/core/llm/router.js';
import { extractStoryEssence } from '../src/core/planner/storyEssenceExtractor.js';

async function main(): Promise<void> {
  const projectName = process.argv[2];
  if (!projectName) {
    console.error('Usage: pnpm tsx scripts/probe-story-essence.ts <project-name> [--duration <sec>]');
    process.exit(1);
  }
  const durIdx = process.argv.indexOf('--duration');
  const targetDurationSec = durIdx >= 0 ? parseInt(process.argv[durIdx + 1] ?? '', 10) : NaN;

  const dirName = projectName.endsWith('.dhee') ? projectName : `${projectName}.dhee`;
  const projectDir = resolve(dirName);
  if (!existsSync(projectDir)) {
    console.error(`Project not found: ${projectDir}`);
    process.exit(1);
  }

  // Read project.json for goal duration if --duration not passed.
  let durationToUse: number | undefined = Number.isFinite(targetDurationSec) && targetDurationSec > 0 ? targetDurationSec : undefined;
  if (durationToUse === undefined) {
    const projJsonPath = join(projectDir, 'project.json');
    if (existsSync(projJsonPath)) {
      try {
        const proj = JSON.parse(readFileSync(projJsonPath, 'utf-8')) as Record<string, unknown>;
        const goal = proj['goal'] as { preferences?: { duration?: number } } | undefined;
        if (typeof goal?.preferences?.duration === 'number') {
          durationToUse = goal.preferences.duration;
        }
      } catch { /* ignore */ }
    }
  }

  // Prefer a generated story.md; fall back to original_input.md.
  let storyPath = join(projectDir, 'chapters', 'chapter_1', 'plans', 'story.md');
  if (!existsSync(storyPath)) {
    storyPath = join(projectDir, 'original_input.md');
  }
  if (!existsSync(storyPath)) {
    console.error(`No story content found at chapters/chapter_1/plans/story.md or original_input.md`);
    process.exit(1);
  }
  const storyContent = readFileSync(storyPath, 'utf-8');
  console.log(`Reading: ${storyPath} (${storyContent.length} chars)`);
  console.log(`Target duration: ${durationToUse !== undefined ? `${durationToUse}s` : '(unspecified)'}`);

  const router = buildRouterFromEnv(projectDir);
  const llm: LLMClient = router.getClient('structured.story_essence');
  const startedAt = Date.now();
  console.log(`Calling extractStoryEssence with model purpose 'structured.story_essence' …`);
  try {
    const essence = await extractStoryEssence(storyContent, llm, {
      ...(durationToUse !== undefined ? { targetDurationSec: durationToUse } : {}),
    });
    const elapsedMs = Date.now() - startedAt;
    console.log(`\n--- Story Essence (${elapsedMs} ms) ---`);
    console.log(JSON.stringify(essence, null, 2));
  } catch (err) {
    console.error(`Essence extraction failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
