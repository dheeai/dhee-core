/**
 * Integration test for the `illustrated_story_animated` bundle's
 * `scenes_plan` split (scene_outline → scene_detail → scenes_plan via
 * `plan.assemble`) — verifies the REAL bundle.json wiring, the REAL
 * prompt/schema files on disk, and the REAL `plan.assemble` runner, all
 * driven through the walker with a MOCK `llm.generate` client (no real
 * model calls; see the repo's model-authorization rules).
 *
 * The node definitions under test (`scene_outline`, `scene_detail`,
 * `scenes_plan`, `shot_image_prompt`) and the bundle's `narration` input
 * declaration are read directly out of the real
 * `~/.kshana/bundles/illustrated_story_animated/bundle.json` — not
 * hand-copied — so this test tracks the actual bundle wiring and fails if
 * it drifts. Upstream context nodes (`story`, `story_bible`, `art_style`)
 * are trivial in-memory stubs; they aren't what's under test here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import { __resetGlobalRegistryForTesting, getGlobalRegistry } from '../../src/dag/runners/registry.js';
import '../../src/dag/runners/index.js'; // side-effect: bootstraps real 'plan.assemble' etc. (re-registered fresh below anyway)
import { createLlmGenerateRunner } from '../../src/dag/runners/llmGenerate.js';
import { planAssembleRunner } from '../../src/dag/runners/planAssemble.js';
// NOTE: `plan.assemble_keyframes` (the runner the bundle's scenes_plan node now
// uses) lives in the EXTERNAL dhee-runner-plan-keyframes package, which is only
// present via a local symlink. It is loaded dynamically in beforeEach so this file
// still parses where the package is absent, and the suite skips instead of erroring.
import type { DagBundle, NodeDef, Runner, RunnerContext } from '../../src/dag/schema.js';

const BUNDLE_DIR =
  process.env['DHEE_ILLUSTRATED_STORY_BUNDLE_DIR'] ??
  join(homedir(), '.kshana', 'bundles', 'illustrated_story_animated');

/**
 * This file drives the REAL external bundle plus the REAL external
 * `plan.assemble_keyframes` runner, so it can only run where both are
 * installed. On CI (and any clone without them) it SKIPS rather than fails —
 * a machine-specific integration test must not be reported as a broken engine.
 * Properly, it belongs in the bundle's own repo; see dheeai/dhee-core#192.
 */
const CAN_RUN = existsSync(join(BUNDLE_DIR, 'bundle.json'));

function loadRealBundleJson(): { nodes: NodeDef[]; inputs: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(BUNDLE_DIR, 'bundle.json'), 'utf-8'));
}

function realNode(id: string): NodeDef {
  const real = loadRealBundleJson();
  const node = real.nodes.find((n) => (n as unknown as { id: string }).id === id);
  if (!node) throw new Error(`bundle.json has no node '${id}' — has the real bundle wiring changed?`);
  return node as unknown as NodeDef;
}

function realNarrationInput(): Record<string, unknown> {
  const real = loadRealBundleJson();
  const input = real.inputs.find((i) => i['id'] === 'narration');
  if (!input) throw new Error("bundle.json has no top-level 'narration' input declared anymore");
  return input;
}

/**
 * A real top-level bundle input, by id. `scene_outline` reads `target_duration`
 * as context, and unlike `director_screenplay` it is a bundle INPUT rather than
 * a node — so it has to be declared here, not stubbed as a producer stage.
 */
function realBundleInput(id: string): Record<string, unknown> {
  const real = loadRealBundleJson();
  const input = real.inputs.find((i) => i['id'] === id);
  if (!input) throw new Error(`bundle.json no longer declares a top-level '${id}' input`);
  return input;
}

/** A trivial context-producing stub stage — writes fixed content, ignores its own inputs. */
function makeStubProducer(content: string): Runner {
  return {
    describe: () => ({
      id: 'stub',
      displayName: 'stub',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx: RunnerContext) {
      const out = ctx.node.outputs.pattern;
      const abs = resolve(ctx.projectDir, out);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return { ok: true, outputPath: out };
    },
  };
}

const OUTLINE = {
  title: 'The Midnight Chime (mock)',
  sections: [
    {
      id: 'scene_1',
      heading: 'A Silent Workshop',
      mode: 'narration',
      brief: 'A candle gutters over the great silent clock as midnight approaches.',
      emotion: 'quiet dread',
      entities: ['workshop', 'great_clock'],
    },
    {
      id: 'scene_2',
      heading: 'The Unexpected Arrival',
      mode: 'dialogue',
      brief: 'The old clockmaker turns as the door creaks open on a bitter night.',
      emotion: 'unease',
      entities: ['old_clockmaker', 'daughter'],
    },
    {
      id: 'scene_3',
      heading: 'Winding the Time',
      mode: 'narration',
      brief: 'Two sets of hands turn the great brass key together as dawn breaks.',
      emotion: 'acceptance',
      entities: ['old_clockmaker', 'daughter', 'great_clock'],
    },
  ],
};

const FRAGMENTS: Record<string, unknown> = {
  scene_1: {
    section: {
      id: 'scene_1',
      heading: 'A Silent Workshop',
      text:
        'In a dark workshop, a single candle guttered on the workbench, and the great unfinished clock stood ' +
        'silent as midnight crept closer. The shadows pressed inward, swallowing the corners of the cramped ' +
        'little room where gears and springs lay scattered across the floorboards.',
      caption: 'Midnight, the workbench',
      sceneBrief:
        'A thick pillar candle flame flickers and gutters on a scarred workbench, casting long shadows over the silent face of the great clock.',
      mode: 'narration',
      emotion: 'quiet dread',
      entities: ['workshop', 'great_clock'],
    },
    shots: [
      {
        id: 'scene_1_shot_1',
        scene: 1,
        shotNumber: 1,
        duration: 6,
        description:
          'A single pillar candle flame gutters and sputters in a draft, casting dancing shadows across a massive dark clock face.',
        cameraWork: 'slow push-in on the candle',
        characterPresence: 'none',
      },
    ],
  },
  scene_2: {
    section: {
      id: 'scene_2',
      heading: 'The Unexpected Arrival',
      text:
        'The old clockmaker heard the door creak on its hinges and looked up, his eyes wet with surprise. The ' +
        'cold night air made the single flame dance wildly, illuminating the deep lines of his weathered face ' +
        'as he realized who stood in the threshold of his lonely workshop.',
      caption: 'Midnight, the doorway',
      sceneBrief:
        'The workshop door heaves open against the wind, and the old clockmaker turns his head toward the entrance with wide, watery eyes.',
      mode: 'dialogue',
      emotion: 'unease',
      entities: ['old_clockmaker', 'daughter'],
    },
    shots: [
      {
        id: 'scene_2_shot_1',
        scene: 2,
        shotNumber: 1,
        duration: 5,
        description:
          "The old clockmaker's face turns sharply toward the sound of the door, his eyes widening with sudden recognition.",
        cameraWork: 'medium close-up',
        dialogue: 'You came back.',
        speaker: 'old_clockmaker',
        emotion: 'wet, surprised',
        characterPresence: 'character',
      },
    ],
  },
  scene_3: {
    section: {
      id: 'scene_3',
      heading: 'Winding the Time',
      text:
        'Together they turned the heavy brass key, and the great clock shuddered to life and began to chime as ' +
        'the first light of the new year spilled through the frosted window. The heavy, rhythmic ticking filled ' +
        'the room, marking the beginning of a shared future.',
      caption: 'New Year, the great clock',
      sceneBrief:
        'Two sets of hands grasp the large, ornate brass winding key and turn it with a heavy click, waking the massive internal gears of the great clock.',
      mode: 'narration',
      emotion: 'acceptance',
      entities: ['old_clockmaker', 'daughter', 'great_clock'],
    },
    shots: [
      {
        id: 'scene_3_shot_1',
        scene: 3,
        shotNumber: 1,
        duration: 7,
        description:
          'A weathered hand and a younger gloved hand grip the heavy brass key together, twisting it deep into the mechanism.',
        cameraWork: 'tight close-up on hands and key',
        characterPresence: 'none',
      },
    ],
  },
};

const MOCK_SHOT_IMAGE_PROMPT = {
  imagePrompt:
    'A cinematic photoreal film still: a weathered hand grips an ornate brass key, twisting it deep into a ' +
    'massive clock mechanism, warm amber light spilling across scattered gears and springs, shallow depth of field.',
  // shot_image_prompt.schema.json requires `references` (1-2 entries, PRIMARY
  // first) — references[0] is the grounded-edit base, references[1] the second
  // image slot. Each entry needs id + type ('character' | 'keyframe') + appearsAs.
  references: [
    { id: 'old_clockmaker', type: 'character', appearsAs: 'weathered elderly clockmaker, apron' },
  ],
  aspectRatio: '3:2',
  generationMode: 'text_to_image',
};

interface CapturedRequest {
  messages: { role: string; content: string }[];
}

let capturedRequests: CapturedRequest[];
let sceneDetailStartOrder: string[];
let sceneDetailInFlight: number;
let sceneDetailMaxInFlight: number;
const SCENE_DETAIL_DELAY_MS = 20;

function makeMockLlmClient() {
  return {
    async generate(opts: { messages: { role: string; content: string }[] }) {
      capturedRequests.push({ messages: opts.messages });
      const joined = opts.messages.map((m) => m.content).join('\n');

      if (joined.includes('SKELETON of an')) {
        return { content: JSON.stringify(OUTLINE) };
      }

      if (joined.includes('SECOND pass, filling in FULL detail')) {
        const m = joined.match(/This call is for scene id: (scene_\d+)/);
        const sceneId = m?.[1];
        if (!sceneId) throw new Error(`mock llm client: could not find scene id in scene_detail prompt: ${joined.slice(0, 300)}`);
        sceneDetailStartOrder.push(sceneId);
        sceneDetailInFlight++;
        sceneDetailMaxInFlight = Math.max(sceneDetailMaxInFlight, sceneDetailInFlight);
        await new Promise((r) => setTimeout(r, SCENE_DETAIL_DELAY_MS));
        sceneDetailInFlight--;
        const fragment = FRAGMENTS[sceneId];
        if (!fragment) throw new Error(`mock llm client: no canned fragment for '${sceneId}'`);
        return { content: JSON.stringify(fragment) };
      }

      if (joined.includes('the EDIT instruction for ONE SHOT')) {
        return { content: JSON.stringify(MOCK_SHOT_IMAGE_PROMPT) };
      }

      throw new Error(`mock llm client: unrecognized prompt (no known marker matched): ${joined.slice(0, 300)}`);
    },
    getModel: () => 'mock-model',
  };
}

let projectDir: string;

function makeTestBundle(goal: string): DagBundle {
  return {
    id: 'illustrated_story_animated-scenes-plan-split-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal,
    inputs: [
      realNarrationInput(),
      realBundleInput('target_duration'),
    ] as unknown as DagBundle['inputs'],
    nodes: [
      {
        id: 'story',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'md', pattern: 'plans/story.md' },
        runner: { tool: 'stub.story', config: {} },
      },
      {
        // `scene_outline` gained a `director_screenplay` context input in the
        // bundle; stubbed here like story/story_bible/art_style so this test
        // stays about the scenes_plan SPLIT topology, not screenplay authoring.
        id: 'director_screenplay',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'md', pattern: 'plans/director_screenplay.md' },
        runner: { tool: 'stub.director_screenplay', config: {} },
      },
      {
        id: 'story_bible',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/story_bible.json' },
        runner: { tool: 'stub.story_bible', config: {} },
      },
      {
        id: 'art_style',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'md', pattern: 'plans/art_style.md' },
        runner: { tool: 'stub.art_style', config: {} },
      },
      realNode('scene_outline'),
      realNode('scene_detail'),
      realNode('scenes_plan'),
      {
        // `shot_image_prompt` also reads `character_state` (a stage) and
        // `shot_motion_directive_draft` (a collection over scenes_plan.shots).
        // Both stubbed — this test is about the scenes_plan split, not them.
        id: 'character_state',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/character_state.json' },
        runner: { tool: 'stub.character_state', config: {} },
      },
      {
        id: 'shot_motion_directive_draft',
        kind: 'collection',
        itemSource: 'scenes_plan',
        itemKey: 'shots',
        inputs: [],
        outputs: { format: 'json', pattern: 'prompts/motion/{{item_id}}.json' },
        runner: { tool: 'stub.motion_draft', config: {} },
      } as unknown as NodeDef,
      realNode('shot_image_prompt'),
    ],
  };
}

function writeProjectJson(narration: boolean): void {
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ id: 'p1', name: 'Test', narration }));
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'istory-anim-split-'));
  capturedRequests = [];
  sceneDetailStartOrder = [];
  sceneDetailInFlight = 0;
  sceneDetailMaxInFlight = 0;

  __resetGlobalRegistryForTesting();
  const reg = getGlobalRegistry();
  reg.register(
    { tool: 'stub.story', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeStubProducer('Once upon a midnight, a clockmaker worked alone.'),
  );
  reg.register(
    { tool: 'stub.story_bible', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeStubProducer(JSON.stringify({ characters: [{ id: 'old_clockmaker' }, { id: 'daughter' }] })),
  );
  reg.register(
    { tool: 'stub.art_style', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeStubProducer('Cinematic photoreal, filmic lighting, shallow depth of field.'),
  );
  reg.register(
    { tool: 'stub.director_screenplay', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeStubProducer('INT. CLOCKMAKER’S WORKSHOP — NIGHT. He winds the last gear.'),
  );
  reg.register(
    { tool: 'llm.generate', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    createLlmGenerateRunner({ clientFactory: () => makeMockLlmClient() }),
  );
  reg.register(
    { tool: 'plan.assemble', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    planAssembleRunner,
  );
  reg.register(
    { tool: 'stub.character_state', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeStubProducer(JSON.stringify({ old_clockmaker: { mood: 'weary' }, daughter: { mood: 'hopeful' } })),
  );
  reg.register(
    { tool: 'stub.motion_draft', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeStubProducer(JSON.stringify({ motion: 'slow push-in', intensity: 'subtle' })),
  );
  const planKeyframes = (await import('dhee-runner-plan-keyframes')) as {
    runners: Array<{ manifest: Parameters<typeof reg.register>[0]; runner: Parameters<typeof reg.register>[1] }>;
  };
  for (const { manifest, runner } of planKeyframes.runners) {
    reg.register(manifest, runner);
  }
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

describe.skipIf(!CAN_RUN)('illustrated_story_animated — scenes_plan split (scene_outline → scene_detail → plan.assemble)', () => {
  it('fans scene_detail out to one instance per outline scene, runs them in parallel (concurrency:4), and assembles a schema-valid scenes_plan.json', async () => {
    writeProjectJson(true);

    const result = await walkBundle({
      projectDir,
      bundle: makeTestBundle('scenes_plan'),
      bundleDir: BUNDLE_DIR,
    });

    expect(result.ok).toBe(true);

    // scene_detail fanned out to exactly the 3 outline scenes.
    expect(sceneDetailStartOrder.sort()).toEqual(['scene_1', 'scene_2', 'scene_3']);
    // concurrency:4 (from the real bundle.json) with only 3 items saturates at 3, in parallel (>1).
    expect(sceneDetailMaxInFlight).toBeGreaterThan(1);
    expect(sceneDetailMaxInFlight).toBeLessThanOrEqual(3);

    // scenes_plan (plan.assemble) declared schemas/scenes_plan.schema.json as its
    // outputSchema — an ok:true result already proves ajv validation passed.
    const plan = JSON.parse(readFileSync(join(projectDir, 'plans/scenes_plan.json'), 'utf-8'));

    expect(plan.title).toBe('The Midnight Chime (mock)');
    expect(plan.sections.map((s: { id: string }) => s.id)).toEqual(['scene_1', 'scene_2', 'scene_3']);
    expect(plan.shots.map((s: { id: string }) => s.id)).toEqual(['scene_1_shot_1', 'scene_2_shot_1', 'scene_3_shot_1']);

    // Computed (not LLM-generated) derived id arrays.
    expect(plan.narration_section_ids).toEqual(['scene_1', 'scene_3']);
    expect(plan.character_shot_ids).toEqual(['scene_2_shot_1']);
    expect(plan.none_shot_ids).toEqual(['scene_1_shot_1', 'scene_3_shot_1']);

    // Trimmed schema: no vestigial kicker/subtitle/section-level dialogue.
    expect(plan.subtitle).toBeUndefined();
    expect(plan.sections[0].kicker).toBeUndefined();
    expect(plan.sections[1].dialogue).toBeUndefined();
  });

  it('propagates the wired narration input: false forces narration_section_ids to []', async () => {
    writeProjectJson(false);

    const result = await walkBundle({
      projectDir,
      bundle: makeTestBundle('scenes_plan'),
      bundleDir: BUNDLE_DIR,
    });

    expect(result.ok).toBe(true);
    const plan = JSON.parse(readFileSync(join(projectDir, 'plans/scenes_plan.json'), 'utf-8'));
    expect(plan.narration_section_ids).toEqual([]);
    // Unaffected by narration: mode classification and shot partitioning stand.
    expect(plan.sections.map((s: { id: string }) => s.id)).toEqual(['scene_1', 'scene_2', 'scene_3']);
    expect(plan.character_shot_ids).toEqual(['scene_2_shot_1']);
  });

  it('a downstream node reading sections/shots (shot_image_prompt) resolves against the assembled plan', async () => {
    writeProjectJson(true);

    const result = await walkBundle({
      projectDir,
      bundle: makeTestBundle('shot_image_prompt'),
      bundleDir: BUNDLE_DIR,
    });

    expect(result.ok).toBe(true);

    // One shot_image_prompt instance per shot in the assembled plan.
    for (const shotId of ['scene_1_shot_1', 'scene_2_shot_1', 'scene_3_shot_1']) {
      const written = JSON.parse(readFileSync(join(projectDir, `prompts/shots/${shotId}.json`), 'utf-8'));
      expect(written.imagePrompt).toEqual(MOCK_SHOT_IMAGE_PROMPT.imagePrompt);
    }

    // The shot_image_prompt calls actually received the assembled plan's
    // sections/shots content (not stale or empty) — confirmed via the
    // captured request text carrying the assembled shot descriptions.
    const shotPromptRequests = capturedRequests.filter((r) =>
      r.messages.some((m) => m.content.includes('the EDIT instruction for ONE SHOT')),
    );
    expect(shotPromptRequests.length).toBe(3);
    const allText = shotPromptRequests.map((r) => r.messages.map((m) => m.content).join('\n')).join('\n---\n');
    expect(allText).toContain('scene_2_shot_1');
    expect(allText).toContain('You came back.');
  });
});
