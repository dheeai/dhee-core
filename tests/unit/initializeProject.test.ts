/**
 * initializeProject — coverage for the pre-agent project bootstrap
 * that the Production Slate screen calls when the user clicks ROLL.
 *
 * Failure modes:
 *   1. Happy path: writes project.json + inputs/story.md, sets project-kind
 *      fields from caller inputs, applies bundle defaults where caller
 *      omitted.
 *   2. Caller-supplied story content is written verbatim to the bundle's
 *      declared file path.
 *   3. Caller-supplied project-kind values override bundle defaults.
 *   4. Missing required file-kind input → ok:false with an error naming
 *      the input id; project.json NOT written.
 *   5. Empty-string for required file-kind treated as missing → error.
 *   6. projectDir doesn't exist → ok:false (caller's responsibility to
 *      create the folder first).
 *   7. projectDir already contains project.json → ok:false, refuses
 *      overwrite.
 *   8. Unknown bundle id → ok:false.
 *   9. Bundle with no inputs[] → still writes project.json successfully.
 *  10. Nested project-kind field (dot-path) writes deep into project.json.
 *  11. Optional description recorded when provided.
 *  12. createdAt is an ISO string.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProject } from '../../src/dag/initializeProject.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
import { projectWalkState } from '../../src/dag/eventLog/projectWalkState.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'dhee-init-test-'));
}

describe('initializeProject', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('1. happy path: writes project.json + inputs/story.md with all values', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const result = initializeProject({
      projectDir,
      name: 'My Cinematic Project',
      bundleId: 'narrative_prompt_relay',
      inputs: {
        story_input: 'A young engineer discovers a glitch.',
        targetDuration: 120,
        style: 'noir',
        aspect: '21:9',
      },
    });
    expect(result.ok).toBe(true);
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.name).toBe('My Cinematic Project');
    expect(project.bundleSource).toBe('built-in:narrative_prompt_relay');
    expect(project.targetDuration).toBe(120);
    expect(project.style).toBe('noir');
    expect(project.aspect).toBe('21:9');
  });

  it('1b. budgetCapUsd is stamped into features only when valid (> 0)', () => {
    // Valid cap → stamped.
    const withCap = tmpDir();
    made.push(withCap);
    initializeProject({
      projectDir: withCap,
      name: 'Capped',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
      budgetCapUsd: 5,
    });
    const capped = JSON.parse(readFileSync(join(withCap, 'project.json'), 'utf8'));
    expect(capped.features.budgetCapUsd).toBe(5);
    expect(capped.features.gateAfterCollections).toBe(true);

    // Omitted → no budgetCapUsd field (headless projects stay uncapped).
    const noCap = tmpDir();
    made.push(noCap);
    initializeProject({
      projectDir: noCap,
      name: 'Uncapped',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
    });
    const uncapped = JSON.parse(readFileSync(join(noCap, 'project.json'), 'utf8'));
    expect(uncapped.features.budgetCapUsd).toBeUndefined();

    // Invalid (≤ 0) → not stamped.
    const zeroCap = tmpDir();
    made.push(zeroCap);
    initializeProject({
      projectDir: zeroCap,
      name: 'Zero',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
      budgetCapUsd: 0,
    });
    const zero = JSON.parse(readFileSync(join(zeroCap, 'project.json'), 'utf8'));
    expect(zero.features.budgetCapUsd).toBeUndefined();
  });

  it('2. story content written verbatim to bundle.inputs[].path', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const story = 'A detective walks into the room. "You\'re late," she says.';
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_shot_by_shot',
      inputs: {
        story_input: story,
        targetDuration: 30,
        style: 'cinematic_realism',
        aspect: '16:9',
      },
    });
    expect(readFileSync(join(projectDir, 'inputs', 'story.md'), 'utf8')).toBe(story);
  });

  it('3. caller values override bundle defaults', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    // narrative_prompt_relay default targetDuration=60. Pass 180.
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a', targetDuration: 180 },
    });
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.targetDuration).toBe(180);
  });

  it('3b. bundle defaults applied when caller omits project-kind value', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' }, // no duration/style/aspect
    });
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.targetDuration).toBe(60);
    expect(project.style).toBe('cinematic_realism');
    expect(project.aspect).toBe('16:9');
  });

  it('4. missing required file-kind input → ok:false + project.json not written', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { targetDuration: 60 }, // story_input missing
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('story_input');
    }
    expect(existsSync(join(projectDir, 'project.json'))).toBe(false);
  });

  it('5. empty string for required file-kind → error', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: '' },
    });
    expect(result.ok).toBe(false);
  });

  it('6. projectDir does not exist → ok:false', () => {
    const result = initializeProject({
      projectDir: '/nonexistent/path/that/never/was',
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('does not exist');
    }
  });

  it('7. projectDir already has project.json → refuses overwrite', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    writeFileSync(join(projectDir, 'project.json'), '{}', 'utf8');
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('already exists');
    }
  });

  it('8. unknown bundle id → ok:false', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'nonexistent_bundle',
      inputs: { story_input: 'a' },
    });
    expect(result.ok).toBe(false);
  });

  it('11. optional description recorded when provided', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      description: 'A test thing',
      inputs: { story_input: 'a' },
    });
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.description).toBe('A test thing');
  });

  it('13. custom (non-preset) allowCustom values pass through verbatim', () => {
    // The desktop "Other…" affordance (allowCustom inputs) supplies values
    // outside the declared options: a free-form style phrase, an arbitrary
    // duration, a non-listed resolution. applyBundleInputs must write them
    // as-is (no option whitelist) — that's the contract the UI relies on.
    const projectDir = tmpDir();
    made.push(projectDir);
    const customStyle =
      'luminous storybook anime, Studio Colorido register, soft cel shading, painterly foliage';
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: {
        story_input: 'a',
        style: customStyle, // not one of the 5 preset options
        targetDuration: 95, // not 30/60/120/180
        resolution: 2160, // not 480/720/1080
      },
    });
    expect(result.ok).toBe(true);
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.style).toBe(customStyle);
    expect(project.targetDuration).toBe(95);
    expect(project.resolution).toBe(2160);
  });

  it('14. style_guide input is written verbatim to plans/world_style.md', () => {
    // Tier 2: a provided art-direction guide lands at the world_style
    // node's OUTPUT path. On the next walk, llm.generate's
    // skip-if-output-exists (covered in llmGenerate.test.ts) returns it
    // without calling the LLM → the user's guide IS the style bible,
    // verbatim, and every downstream visual prompt reads it.
    const projectDir = tmpDir();
    made.push(projectDir);
    const guide =
      '# Aesthetic\nLuminous storybook anime, Studio Colorido register.\n\n## Palette\nWarm saffron-amber-emerald.';
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a', style_guide: guide },
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(projectDir, 'plans', 'world_style.md'), 'utf8')).toBe(guide);
  });

  it('15. style_guide omitted → plans/world_style.md is NOT pre-written (LLM generates it)', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
    });
    expect(existsSync(join(projectDir, 'plans', 'world_style.md'))).toBe(false);
  });

  it('16. a file-input that pre-populates a node output marks that node completed', () => {
    // style_guide writes plans/world_style.md, which IS the world_style
    // node's output. Init must record world_style as completed so the
    // FIRST walk uses it verbatim instead of running the runner and
    // overwriting it. The walker reads completion from the event-log
    // projection, so we assert on that (not just project.json walkState).
    const projectDir = tmpDir();
    made.push(projectDir);
    const guide = '# Aesthetic\nLuminous storybook anime, Studio Colorido register.';
    const r = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a', style_guide: guide },
    });
    expect(r.ok).toBe(true);

    // File written verbatim.
    expect(readFileSync(join(projectDir, 'plans', 'world_style.md'), 'utf8')).toBe(guide);

    // project.json walkState (legacy callers).
    const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(pj.walkState?.nodes?.world_style?.status).toBe('completed');
    expect(pj.walkState?.nodes?.world_style?.outputPath).toBe('plans/world_style.md');

    // The event-log projection the walker actually reads → world_style completed.
    const ws = projectWalkState([...openEventLog(projectDir).read()]);
    expect(ws.nodes['world_style']?.status).toBe('completed');
    expect(ws.bundleSource).toBe('built-in:narrative_prompt_relay');
  });

  it('17. with NO pre-populating file-input, nothing is pre-completed', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' }, // no style_guide
    });
    const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(pj.walkState?.nodes?.world_style).toBeUndefined();
    // No event log written when nothing was pre-completed.
    expect(existsSync(join(projectDir, '.dhee', 'events.jsonl'))).toBe(false);
  });

  it('12. createdAt is an ISO date string', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
    });
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(typeof project.createdAt).toBe('string');
    expect(new Date(project.createdAt as string).toISOString()).toBe(project.createdAt);
  });
});
