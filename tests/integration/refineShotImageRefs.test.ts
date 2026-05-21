/**
 * Integration test for ExecutorAgent.refineShotImageRefs (the multi-turn
 * shot_image_prompt seam — turn 2).
 *
 * Why this exists: the seam itself is ~230 lines of orchestration inside
 * a private method on ExecutorAgent. The pure helpers it composes
 * (`parseTurn2RefsJson`, `buildTurn2UserMessage`,
 * `applyShotImageManifestPostPass`) have dedicated unit tests. The
 * orchestration — building the menu from completed image nodes, reading
 * .md descriptions, issuing the 4-message LLM call, propagating
 * `expandCollection` for new refs, writing `derivedFrom` onto cascaded
 * image nodes, stitching refs back into both frames — was previously
 * only validated by real project runs.
 *
 * These tests exercise the method directly against a real ExecutorAgent
 * (real narrative template, real DependencyGraphExecutor, real
 * filesystem) with a mocked LLM client. The method is private; we reach
 * it via `(agent as any).refineShotImageRefs(...)`. That's deliberate —
 * the public surface (validateJsonOutput) wraps it, but exercising the
 * method directly isolates the contract under test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ExecutorAgent } from '../../src/core/planner/ExecutorAgent.js';
import { narrativeTemplate } from '../../src/templates/narrative.js';
import type { ExecutionNode } from '../../src/core/planner/types.js';
import type { GenericProjectFile } from '../../src/core/templates/types.js';
import type { Message } from '../../src/core/llm/types.js';
import type { Reference } from '../../src/core/planner/shotImagePipeline.js';
import { MockLLMClient } from './MockLLMClient.js';

// ── Shared fixture builders ────────────────────────────────────────────────

/**
 * A pristine turn-1 JSON the LLM might return for a 2-character shot.
 * Both frames have placeholder references[]; turn-2 is what we test.
 */
const TURN1_JSON = JSON.stringify({
  shotNumber: 1,
  frames: {
    first_frame: {
      imagePrompt: 'Ruby and Angel approach the pawn shop facade at midday.',
      generationMode: 'image_text_to_image',
      references: [
        { imageNumber: 1, type: 'setting', refId: 'setting_image:pawn_shop_exterior' },
        { imageNumber: 2, type: 'character', refId: 'character_image:ruby' },
      ],
    },
    last_frame: {
      imagePrompt: 'Ruby pushes the door open as Angel watches from her shoulder.',
      generationMode: 'edit_first_frame',
      references: [
        { imageNumber: 1, type: 'setting', refId: 'setting_image:pawn_shop_exterior' },
        { imageNumber: 2, type: 'character', refId: 'character_image:ruby' },
      ],
    },
  },
  negativePrompt: 'cartoon, anime',
  aspectRatio: '16:9',
});

/**
 * Build a fresh temp project directory with the .md files turn-2 reads.
 * narrative.ts paths: characters/{name}.md, settings/{name}.md, objects/{name}.md.
 */
function makeTempProject(opts?: {
  characters?: Record<string, string>;
  settings?: Record<string, string>;
  objects?: Record<string, string>;
}): string {
  const dir = join(tmpdir(), `kshana-refine-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'characters'), { recursive: true });
  mkdirSync(join(dir, 'settings'), { recursive: true });
  mkdirSync(join(dir, 'objects'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  for (const [name, body] of Object.entries(opts?.characters ?? {})) {
    writeFileSync(join(dir, 'characters', `${name}.md`), body, 'utf-8');
  }
  for (const [name, body] of Object.entries(opts?.settings ?? {})) {
    writeFileSync(join(dir, 'settings', `${name}.md`), body, 'utf-8');
  }
  for (const [name, body] of Object.entries(opts?.objects ?? {})) {
    writeFileSync(join(dir, 'objects', `${name}.md`), body, 'utf-8');
  }
  return dir;
}

function minimalProject(): GenericProjectFile {
  return {
    version: '3.0',
    id: 'refine-int-test',
    title: 'Refine Int Test',
    templateId: 'narrative',
    templateVersion: '1.0.0',
    style: 'cinematic_realism',
    inputType: 'idea',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    artifacts: {},
    assets: [],
    contextStore: {},
  } as GenericProjectFile;
}

/**
 * Build a real ExecutorAgent against the narrative template and route ALL
 * LLM purposes to the provided mock. We don't call agent.run() — only the
 * private refineShotImageRefs method under test.
 */
function makeAgent(projectDir: string, mock: MockLLMClient): ExecutorAgent {
  const project = minimalProject();
  const goal = {
    targetArtifacts: ['final_video'],
    preferences: {},
    description: 'Integration test',
  };
  const agent = new ExecutorAgent(mock as unknown as import('../../src/core/llm/LLMClient.js').LLMClient, {
    template: narrativeTemplate,
    project,
    projectDir,
    goal,
  });
  // Route every llmFor(purpose) → mock. The router would otherwise build
  // an env-driven client we don't want firing in tests.
  (agent as unknown as { llmFor: (..._a: unknown[]) => unknown }).llmFor = () => mock;
  return agent;
}

type ItemSpec = string | { itemId: string; completed?: boolean };

/**
 * Materialize image nodes in one shot per upstream type. expandCollection
 * deletes the type-level node after expansion (see
 * DependencyGraphExecutor.expandCollection line ~569), so we have to
 * batch ALL items per type into a single call — calling it twice for
 * the same type is a silent no-op.
 *
 * Item entries:
 *   - bare string → expanded AND force-completed (the common case)
 *   - `{ itemId, completed: false }` → expanded but left pending (used
 *     by the "menu skips pending" test)
 */
function seedImageRefs(
  agent: ExecutorAgent,
  refs: { characters?: ItemSpec[]; settings?: ItemSpec[]; objects?: ItemSpec[] },
): void {
  const executor = (agent as unknown as {
    executor: import('../../src/core/planner/DependencyGraphExecutor.js').DependencyGraphExecutor;
  }).executor;
  const groups: Array<[
    'character' | 'setting' | 'object',
    'character_image' | 'setting_image' | 'object_image',
    ItemSpec[],
  ]> = [
    ['character', 'character_image', refs.characters ?? []],
    ['setting', 'setting_image', refs.settings ?? []],
    ['object', 'object_image', refs.objects ?? []],
  ];
  for (const [upstreamTypeId, imageTypeId, items] of groups) {
    if (items.length === 0) continue;
    const normalized = items.map(it =>
      typeof it === 'string' ? { itemId: it, completed: true } : { completed: true, ...it },
    );
    executor.expandCollection(
      upstreamTypeId,
      normalized.map(it => ({ itemId: it.itemId, name: it.itemId })),
    );
    for (const it of normalized) {
      const imageNodeId = `${imageTypeId}:${it.itemId}`;
      const node = executor.getNode(imageNodeId);
      if (!node) throw new Error(`expected image node ${imageNodeId} after expansion`);
      // Force-set: markCompleted() requires deps satisfied. Test-only
      // shortcut. Completed nodes appear in the turn-2 menu (filter is
      // status === 'completed' at shotImagePipeline.ts:106); pending
      // ones are excluded by design.
      if (it.completed) node.status = 'completed';
    }
  }
}

/**
 * Build the shot_image_prompt node we'll pass to refineShotImageRefs.
 * narrative.ts: `shot_image_prompt:scene_<n>_shot_<m>`.
 */
function buildShotImagePromptNode(itemId = 'scene_1_shot_1'): ExecutionNode {
  return {
    id: `shot_image_prompt:${itemId}`,
    typeId: 'shot_image_prompt',
    itemId,
    displayName: `Shot Image Prompt ${itemId}`,
    status: 'in_progress',
    dependencies: [],
    dependents: [],
    isCollection: false,
    isExpensive: false,
  } as unknown as ExecutionNode;
}

/** Call the private method under test. */
async function refine(
  agent: ExecutorAgent,
  node: ExecutionNode,
  turn1Content: string,
): Promise<string | null> {
  type RefineFn = (
    node: ExecutionNode,
    system: string,
    user: string,
    turn1: string,
    toolCallId: string | undefined,
    toolName: string,
  ) => Promise<string | null>;
  const refineFn = (agent as unknown as { refineShotImageRefs: RefineFn }).refineShotImageRefs;
  return refineFn.call(
    agent,
    node,
    'SYSTEM-PROMPT',
    'USER-PROMPT',
    turn1Content,
    undefined,
    'test_tool',
  );
}

// ── Cleanup tracking ──────────────────────────────────────────────────────

const dirsToCleanup: string[] = [];

afterEach(() => {
  while (dirsToCleanup.length > 0) {
    const d = dirsToCleanup.pop()!;
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('refineShotImageRefs — menu building', () => {
  it('includes only completed image nodes, skips pending lazy refs', async () => {
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby\nRed-haired thief.', angel: '# Angel\nLookout.' },
      settings: { pawn_shop_exterior: '# Pawn shop\nWeathered facade.' },
    });
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby', { itemId: 'angel', completed: false }], settings: ['pawn_shop_exterior'] });

    let capturedMenuJson = '';
    mock.expect({
      match: (msgs) => msgs.length === 4, // [system, user, assistant, user]
      capture: (msgs) => { capturedMenuJson = msgs[3]?.content ?? ''; },
      response: {
        content: JSON.stringify({
          references: [
            { refId: 'setting_image:pawn_shop_exterior', type: 'setting', imageNumber: 1, status: 'existing' },
            { refId: 'character_image:ruby', type: 'character', imageNumber: 2, status: 'existing' },
          ],
        }),
      },
    });

    await refine(agent, buildShotImagePromptNode(), TURN1_JSON);

    expect(capturedMenuJson).toContain('"setting_image:pawn_shop_exterior"');
    expect(capturedMenuJson).toContain('"character_image:ruby"');
    // Angel is pending — must not appear in the menu the LLM sees.
    expect(capturedMenuJson).not.toContain('"character_image:angel"');
  });

  it('reads .md descriptions and trims to 600 chars', async () => {
    const longDescription = 'Ruby is ' + 'a red-haired thief. '.repeat(50); // ~1010 chars
    const projectDir = makeTempProject({
      characters: { ruby: `# Ruby\n${longDescription}` },
    });
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby'] });

    let capturedMenuJson = '';
    mock.expect({
      match: (msgs) => msgs.length === 4,
      capture: (msgs) => { capturedMenuJson = msgs[3]?.content ?? ''; },
      response: { content: JSON.stringify({ references: [
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, status: 'existing' },
        { refId: 'setting_image:something', type: 'setting', imageNumber: 1, status: 'new', newRefDescription: 'street' },
      ] }) },
    });

    await refine(agent, buildShotImagePromptNode(), TURN1_JSON);

    // Find Ruby's description block in the menu JSON.
    const menuMatch = capturedMenuJson.match(/"description":\s*"([^"]+)…"/);
    expect(menuMatch).not.toBeNull();
    // Trimmed body should be <= 600 chars; the "…" suffix indicates truncation.
    expect(menuMatch![1]!.length).toBeLessThanOrEqual(600);
  });
});

describe('refineShotImageRefs — happy path', () => {
  it('stitches turn-2 refs into BOTH first_frame and last_frame identically', async () => {
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby', angel: '# Angel' },
      settings: { pawn_shop_exterior: '# Pawn shop' },
    });
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby', 'angel'], settings: ['pawn_shop_exterior'] });

    const refinedPayload = {
      references: [
        { refId: 'setting_image:pawn_shop_exterior', type: 'setting', imageNumber: 1, status: 'existing' },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, status: 'existing' },
        { refId: 'character_image:angel', type: 'character', imageNumber: 3, status: 'existing' },
      ],
    };
    mock.expect({
      match: () => true,
      response: { content: JSON.stringify(refinedPayload) },
    });

    const result = await refine(agent, buildShotImagePromptNode(), TURN1_JSON);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as {
      frames: {
        first_frame: { references: Reference[] };
        last_frame: { references: Reference[] };
      };
    };
    expect(parsed.frames.first_frame.references).toHaveLength(3);
    expect(parsed.frames.last_frame.references).toHaveLength(3);
    // Identical refs in both frames — this is the post-condition the
    // `turn2Succeeded` gate in validateJsonOutput depends on.
    expect(parsed.frames.first_frame.references).toEqual(
      parsed.frames.last_frame.references,
    );
    // Ref content matches what turn-2 returned (modulo parseTurn2RefsJson's
    // canonicalization — refIds were already canonical).
    expect(parsed.frames.first_frame.references.map(r => r.refId).sort()).toEqual([
      'character_image:angel',
      'character_image:ruby',
      'setting_image:pawn_shop_exterior',
    ]);
  });

  it('calls LLM with [system, user, assistant(turn1), user(turn2)] in order', async () => {
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby' },
      settings: { pawn_shop_exterior: '# Pawn shop' },
    });
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby'], settings: ['pawn_shop_exterior'] });

    let captured: Message[] = [];
    mock.expect({
      match: () => true,
      capture: (msgs) => { captured = msgs; },
      response: { content: JSON.stringify({ references: [
        { refId: 'setting_image:pawn_shop_exterior', type: 'setting', imageNumber: 1, status: 'existing' },
      ] }) },
    });

    await refine(agent, buildShotImagePromptNode(), TURN1_JSON);

    expect(captured).toHaveLength(4);
    expect(captured[0]?.role).toBe('system');
    expect(captured[0]?.content).toBe('SYSTEM-PROMPT');
    expect(captured[1]?.role).toBe('user');
    expect(captured[1]?.content).toBe('USER-PROMPT');
    expect(captured[2]?.role).toBe('assistant');
    expect(captured[2]?.content).toBe(TURN1_JSON);
    expect(captured[3]?.role).toBe('user');
    // Turn-2 user message contains the existing-refs menu.
    expect(captured[3]?.content).toContain('Existing reference menu');
  });
});

describe('refineShotImageRefs — expandCollection for new refs', () => {
  it('proposes new setting with derivedFrom → writes derivedFrom metadata onto the cascaded image node', async () => {
    // Note: this test exercises the derivedFrom wiring on a FRESH collection
    // expansion (the 'setting' type hasn't been pre-expanded). Once a
    // collection has been expanded, the type-level node is deleted
    // (DependencyGraphExecutor.expandCollection line ~569) and subsequent
    // calls for the same type are silent no-ops — which means a NEW ref
    // proposed by turn-2 AFTER another shot already expanded the type can't
    // be materialized at all. That's a real production gap (see comment at
    // ExecutorAgent.refineShotImageRefs:6451 "Phase C-lite"); not what this
    // test covers. Here we verify the happy path: when the cascade CAN run,
    // derivedFrom metadata is correctly written onto the new image node.
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby', angel: '# Angel' },
    });
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby', 'angel'] });
    // Setting is NOT pre-expanded — turn-2 will trigger the first expansion.

    mock.expect({
      match: () => true,
      response: { content: JSON.stringify({
        references: [
          {
            refId: 'setting_image:pawn_shop_exterior_reverse',
            type: 'setting',
            imageNumber: 1,
            status: 'new',
            newRefDescription: 'The pawn shop interior wall opposite the entrance.',
            derivedFrom: 'pawn_shop_exterior',
          },
          { refId: 'character_image:ruby', type: 'character', imageNumber: 2, status: 'existing', side: 'A' },
          { refId: 'character_image:angel', type: 'character', imageNumber: 3, status: 'existing', side: 'B' },
        ],
      }) },
    });

    const result = await refine(agent, buildShotImagePromptNode(), TURN1_JSON);
    expect(result).not.toBeNull();

    // The cascaded image node must exist and carry the derivedFrom marker.
    const executor = (agent as unknown as {
      executor: import('../../src/core/planner/DependencyGraphExecutor.js').DependencyGraphExecutor;
    }).executor;
    const newImageNode = executor.getNode('setting_image:pawn_shop_exterior_reverse');
    expect(newImageNode).toBeDefined();
    // normalizeDerivedFromRefId coerces bare itemId → canonical image refId.
    expect(newImageNode!.metadata?.['derivedFrom']).toBe('setting_image:pawn_shop_exterior');
    expect(newImageNode!.metadata?.['description']).toContain('pawn shop interior');
  });

  it('expandCollection throwing on already-existing item is caught and processing continues', async () => {
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby' },
      settings: { pawn_shop_exterior: '# Pawn shop' },
    });
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby'], settings: ['pawn_shop_exterior'] });

    // Force expandCollection to throw for the new ref so we can verify
    // the orchestration logs-and-continues rather than crashing.
    const executor = (agent as unknown as {
      executor: import('../../src/core/planner/DependencyGraphExecutor.js').DependencyGraphExecutor;
    }).executor;
    const originalExpand = executor.expandCollection.bind(executor);
    let throwCount = 0;
    type ExpandFn = typeof originalExpand;
    type ExpandItems = Parameters<ExpandFn>[1];
    const wrapped: ExpandFn = (typeId, items: ExpandItems) => {
      if (items.some((i) => i.itemId === 'phantom_setting')) {
        throwCount++;
        throw new Error('synthetic — item already exists');
      }
      return originalExpand(typeId, items);
    };
    (executor as unknown as { expandCollection: ExpandFn }).expandCollection = wrapped;

    mock.expect({
      match: () => true,
      response: { content: JSON.stringify({
        references: [
          {
            refId: 'setting_image:phantom_setting',
            type: 'setting',
            imageNumber: 1,
            status: 'new',
            newRefDescription: 'A phantom setting that already exists.',
          },
          { refId: 'character_image:ruby', type: 'character', imageNumber: 2, status: 'existing' },
        ],
      }) },
    });

    // Should NOT throw. The result should still come back stitched.
    const result = await refine(agent, buildShotImagePromptNode(), TURN1_JSON);
    expect(throwCount).toBe(1);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as { frames: { first_frame: { references: Reference[] } } };
    expect(parsed.frames.first_frame.references.map(r => r.refId)).toContain(
      'character_image:ruby',
    );
  });
});

describe('refineShotImageRefs — fallback paths', () => {
  it('turn-1 not JSON → returns null without calling LLM', async () => {
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby' },
    });
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby'] });

    const result = await refine(agent, buildShotImagePromptNode(), 'this is not JSON');
    expect(result).toBeNull();
    expect(mock.getCallHistory()).toHaveLength(0);
  });

  it('cold start (no completed image nodes) → returns null without calling LLM', async () => {
    const projectDir = makeTempProject({});
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    // No image nodes expanded/completed — menu will be empty.

    const result = await refine(agent, buildShotImagePromptNode(), TURN1_JSON);
    expect(result).toBeNull();
    expect(mock.getCallHistory()).toHaveLength(0);
  });

  it('turn-2 returns empty content → returns null', async () => {
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby' },
      settings: { pawn_shop_exterior: '# Pawn shop' },
    });
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby'], settings: ['pawn_shop_exterior'] });

    mock.expect({ match: () => true, response: { content: '' } });

    const result = await refine(agent, buildShotImagePromptNode(), TURN1_JSON);
    expect(result).toBeNull();
  });

  it('turn-2 valid JSON but parseTurn2RefsJson rejects (no setting + has character) → returns null', async () => {
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby' },
      settings: { pawn_shop_exterior: '# Pawn shop' },
    });
    dirsToCleanup.push(projectDir);
    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby'], settings: ['pawn_shop_exterior'] });

    // Invalid: no setting at slot 1, but a character ref is present.
    // parseTurn2RefsJson returns [] on this — refineShotImageRefs then bails.
    mock.expect({
      match: () => true,
      response: { content: JSON.stringify({
        references: [
          { refId: 'character_image:ruby', type: 'character', imageNumber: 1, status: 'existing' },
        ],
      }) },
    });

    const result = await refine(agent, buildShotImagePromptNode(), TURN1_JSON);
    expect(result).toBeNull();
  });
});

describe('refineShotImageRefs — OTS hint', () => {
  it('shot brief perspective=ots → turn-2 user message contains Side A/B interlock guidance', async () => {
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby', angel: '# Angel' },
      settings: { pawn_shop_exterior: '# Pawn shop' },
    });
    dirsToCleanup.push(projectDir);
    // Write the shot brief file shotBriefSuggestsOts reads:
    //   prompts/videos/scenes/scene_<n>.shots/<m>.json
    const briefDir = join(projectDir, 'prompts/videos/scenes/scene_1.shots');
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, '1.json'), JSON.stringify({
      shotNumber: 1,
      perspective: 'ots',
      cameraWork: 'over the shoulder of Ruby',
    }), 'utf-8');

    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby', 'angel'], settings: ['pawn_shop_exterior'] });

    let turn2User = '';
    mock.expect({
      match: () => true,
      capture: (msgs) => { turn2User = msgs[3]?.content ?? ''; },
      response: { content: JSON.stringify({ references: [
        { refId: 'setting_image:pawn_shop_exterior', type: 'setting', imageNumber: 1, status: 'existing' },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, status: 'existing', side: 'A' },
        { refId: 'character_image:angel', type: 'character', imageNumber: 3, status: 'existing', side: 'B' },
      ] }) },
    });

    await refine(agent, buildShotImagePromptNode('scene_1_shot_1'), TURN1_JSON);

    // The OTS-flagged turn-2 user message carries the Side A/B interlock
    // guidance the buildTurn2UserMessage helper inserts under otsHint.
    expect(turn2User).toContain('Side A');
    expect(turn2User).toContain('Side B');
    expect(turn2User).toContain('_reverse');
  });

  it('no OTS markers → turn-2 user message has no Side A/B interlock guidance', async () => {
    const projectDir = makeTempProject({
      characters: { ruby: '# Ruby' },
      settings: { pawn_shop_exterior: '# Pawn shop' },
    });
    dirsToCleanup.push(projectDir);
    // No shot brief file → shotBriefSuggestsOts returns false.

    const mock = new MockLLMClient();
    const agent = makeAgent(projectDir, mock);
    seedImageRefs(agent, { characters: ['ruby'], settings: ['pawn_shop_exterior'] });

    let turn2User = '';
    mock.expect({
      match: () => true,
      capture: (msgs) => { turn2User = msgs[3]?.content ?? ''; },
      response: { content: JSON.stringify({ references: [
        { refId: 'setting_image:pawn_shop_exterior', type: 'setting', imageNumber: 1, status: 'existing' },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, status: 'existing' },
      ] }) },
    });

    await refine(agent, buildShotImagePromptNode(), TURN1_JSON);

    expect(turn2User).not.toContain('Side A (camera at one end');
    expect(turn2User).not.toContain('reverse setting');
  });
});
