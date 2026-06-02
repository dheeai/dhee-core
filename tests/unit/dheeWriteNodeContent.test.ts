/**
 * dhee_write_node_content — TDD coverage.
 *
 * The agent overrides a node's output content (e.g. rewrites
 * `shot_image_prompt:scene_1_shot_3` after the LLM produced something
 * the user doesn't want, or supplies a hand-edited image at
 * `shot_image:scene_1_shot_3.png`). The tool:
 *   1. Resolves outputPath from the bundle's outputs.pattern with
 *      item context expanded.
 *   2. Writes bytes.
 *   3. Marks the node as completed (generation.tool='user') in walkState
 *      so the walker treats it as done.
 *   4. Cascades: invalidates every downstream node so a subsequent
 *      dhee_run_bundle picks up the new content.
 *
 * Failure modes:
 *   1. Happy path (text): writes file, walkState[nodeId] completed
 *      with generation.tool='user'.
 *   2. Cascade: downstream nodes get cleared from walkState.
 *   3. Cascade: downstream artifacts deleted from disk.
 *   4. Collection node with itemId: pattern expands {{item_id}} +
 *      writes to nested path; walkState key is `node:item`.
 *   5. project.json missing → error.
 *   6. Unknown nodeId → error.
 *   7. Path traversal via pattern (../) → reject.
 *   8. Parent dir auto-created.
 *   9. node.completed event emitted with generation.tool='user'.
 *  10. node.invalidated events emitted for each downstream node.
 *  11. base64 payload writes binary bytes correctly.
 *  12. localFile payload copies bytes.
 *  13. Calling on a node that ISN'T in the bundle → error.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWriteNodeContentTool } from '../../src/agent/pi/tools/dheeWriteNodeContent.js';
import type { DagBundle, NodeDef } from '../../src/dag/schema.js';

interface ToolLike {
  execute: (
    id: string,
    params: {
      projectDir: string;
      nodeId: string;
      itemId?: string;
      payload: unknown;
      reason?: string;
      confirm?: boolean;
    },
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function setupProject(opts: { walkState?: object; bundleSource?: string } = {}): { projectDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'wnc-test-'));
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({
      name: 'T',
      bundleSource: opts.bundleSource ?? 'built-in:fake',
      walkState: opts.walkState ?? { nodes: {}, lastInvalidatedIds: [] },
    }),
    'utf8',
  );
  return { projectDir };
}

function node(
  id: string,
  pattern: string,
  format: 'md' | 'json' | 'image' | 'video' | 'audio' | 'text' = 'md',
  inputs: Array<{ from: string }> = [],
): NodeDef {
  return {
    id,
    kind: 'stage',
    inputs: inputs.map((i) => ({ from: i.from, usage: 'input' })),
    outputs: { format, pattern },
    runner: { tool: 'llm.generate', config: {} },
  } as unknown as NodeDef;
}

function fakeBundle(nodes: NodeDef[]): DagBundle {
  return {
    id: 'fake',
    version: '0.1.0',
    goal: nodes[nodes.length - 1]?.id ?? 'unused',
    nodes,
  } as unknown as DagBundle;
}

function readWalkState(projectDir: string): { nodes: Record<string, { status?: string; outputPath?: string; generation?: { tool?: string } } | undefined>; lastInvalidatedIds: string[] } {
  const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as { walkState?: { nodes?: Record<string, { status?: string; outputPath?: string; generation?: { tool?: string } } | undefined>; lastInvalidatedIds?: string[] } };
  return { nodes: pj.walkState?.nodes ?? {}, lastInvalidatedIds: pj.walkState?.lastInvalidatedIds ?? [] };
}

function readEvents(projectDir: string): Array<{ kind: string; payload: { nodeId?: string; generation?: { tool?: string }; reason?: string; outputPath?: string } }> {
  const p = join(projectDir, '.dhee/events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('dhee_write_node_content', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('1. happy path text: writes file + walkState marked completed (tool=user)', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () => fakeBundle([node('plot', 'plans/plot.md')]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      nodeId: 'plot',
      payload: { kind: 'text', content: '# rewritten plot' },
    });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(projectDir, 'plans/plot.md'), 'utf8')).toBe('# rewritten plot');
    const ws = readWalkState(projectDir);
    expect(ws.nodes.plot?.status).toBe('completed');
    expect(ws.nodes.plot?.outputPath).toBe('plans/plot.md');
    expect(ws.nodes.plot?.generation?.tool).toBe('user');
  });

  it('2. cascade: downstream node walkState entries are cleared', async () => {
    const { projectDir } = setupProject({
      walkState: {
        nodes: {
          plot: { status: 'completed', outputPath: 'plans/plot.md' },
          story: { status: 'completed', outputPath: 'plans/story.md' },
          scenes: { status: 'completed', outputPath: 'plans/scenes.json' },
        },
        lastInvalidatedIds: [],
      },
    });
    dirs.push(projectDir);
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/plot.md'), 'old');
    writeFileSync(join(projectDir, 'plans/story.md'), 'old story');
    writeFileSync(join(projectDir, 'plans/scenes.json'), '{}');

    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () =>
        fakeBundle([
          node('plot', 'plans/plot.md'),
          node('story', 'plans/story.md', 'md', [{ from: 'plot' }]),
          node('scenes', 'plans/scenes.json', 'json', [{ from: 'story' }]),
        ]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'plot',
      payload: { kind: 'text', content: 'new plot' },
    });
    const ws = readWalkState(projectDir);
    // plot is completed (user)
    expect(ws.nodes.plot?.status).toBe('completed');
    // story + scenes cleared (downstream)
    expect(ws.nodes.story).toBeUndefined();
    expect(ws.nodes.scenes).toBeUndefined();
  });

  it('3. cascade: downstream artifacts deleted from disk', async () => {
    const { projectDir } = setupProject({
      walkState: {
        nodes: {
          plot: { status: 'completed', outputPath: 'plans/plot.md' },
          story: { status: 'completed', outputPath: 'plans/story.md' },
        },
        lastInvalidatedIds: [],
      },
    });
    dirs.push(projectDir);
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/plot.md'), 'plot');
    writeFileSync(join(projectDir, 'plans/story.md'), 'story');

    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () =>
        fakeBundle([
          node('plot', 'plans/plot.md'),
          node('story', 'plans/story.md', 'md', [{ from: 'plot' }]),
        ]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'plot',
      payload: { kind: 'text', content: 'new plot' },
    });
    // plot still exists (user wrote it)
    expect(existsSync(join(projectDir, 'plans/plot.md'))).toBe(true);
    expect(readFileSync(join(projectDir, 'plans/plot.md'), 'utf8')).toBe('new plot');
    // story file removed (downstream invalidated)
    expect(existsSync(join(projectDir, 'plans/story.md'))).toBe(false);
  });

  it('4. collection node with itemId: pattern expands + walkState key is node:item', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () =>
        fakeBundle([
          node('shot_image_prompt', 'prompts/shots/{{item_id}}.json', 'json'),
        ]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'shot_image_prompt',
      itemId: 'scene_1_shot_3',
      payload: { kind: 'text', content: '{"imagePrompt":"new prompt"}' },
    });
    expect(existsSync(join(projectDir, 'prompts/shots/scene_1_shot_3.json'))).toBe(true);
    const ws = readWalkState(projectDir);
    expect(ws.nodes['shot_image_prompt:scene_1_shot_3']?.status).toBe('completed');
  });

  it('5. project.json missing → error', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'wnc-test-noproj-'));
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () => fakeBundle([node('plot', 'plans/plot.md')]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      nodeId: 'plot',
      payload: { kind: 'text', content: 'x' },
    });
    expect(r.isError).toBe(true);
  });

  it('6. unknown nodeId → error', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () => fakeBundle([node('plot', 'plans/plot.md')]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      nodeId: 'no_such_node',
      payload: { kind: 'text', content: 'x' },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown|not found/i);
  });

  it('7. path traversal via pattern rejected', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () => fakeBundle([node('evil', '../etc/passwd')]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      nodeId: 'evil',
      payload: { kind: 'text', content: 'hax' },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outside|traversal|escape/i);
  });

  it('8. parent dir auto-created', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () =>
        fakeBundle([node('deep', 'really/deep/nested/path.md')]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'deep',
      payload: { kind: 'text', content: 'a' },
    });
    expect(existsSync(join(projectDir, 'really/deep/nested/path.md'))).toBe(true);
  });

  it('9. node.completed event emitted with generation.tool=user', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () => fakeBundle([node('plot', 'plans/plot.md')]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'plot',
      payload: { kind: 'text', content: 'x' },
      reason: 'user wanted a darker tone',
    });
    const events = readEvents(projectDir);
    const completed = events.filter((e) => e.kind === 'node.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].payload?.nodeId).toBe('plot');
    expect(completed[0].payload?.generation?.tool).toBe('user');
  });

  it('10. node.invalidated events emitted for downstream', async () => {
    const { projectDir } = setupProject({
      walkState: {
        nodes: {
          plot: { status: 'completed', outputPath: 'plans/plot.md' },
          story: { status: 'completed', outputPath: 'plans/story.md' },
          scenes: { status: 'completed', outputPath: 'plans/scenes.json' },
        },
        lastInvalidatedIds: [],
      },
    });
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () =>
        fakeBundle([
          node('plot', 'plans/plot.md'),
          node('story', 'plans/story.md', 'md', [{ from: 'plot' }]),
          node('scenes', 'plans/scenes.json', 'json', [{ from: 'story' }]),
        ]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'plot',
      payload: { kind: 'text', content: 'x' },
    });
    const events = readEvents(projectDir);
    const inv = events.filter((e) => e.kind === 'node.invalidated');
    const ids = inv.map((e) => e.payload?.nodeId).sort();
    expect(ids).toEqual(['scenes', 'story']);
  });

  it('11. base64 payload writes binary bytes', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () =>
        fakeBundle([node('shot_image', 'shots/{{item_id}}.png', 'image')]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_2',
      payload: { kind: 'base64', contentBase64: png.toString('base64') },
    });
    const got = readFileSync(join(projectDir, 'shots/scene_1_shot_2.png'));
    expect([...got]).toEqual([...png]);
  });

  it('12. localFile payload copies bytes', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const srcDir = mkdtempSync(join(tmpdir(), 'wnc-src-'));
    dirs.push(srcDir);
    const src = join(srcDir, 'override.png');
    writeFileSync(src, Buffer.from('source-bytes'));
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () =>
        fakeBundle([node('shot_image', 'shots/{{item_id}}.png', 'image')]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'shot_image',
      itemId: 'scene_2_shot_1',
      payload: { kind: 'localFile', sourcePath: src },
    });
    const got = readFileSync(join(projectDir, 'shots/scene_2_shot_1.png'));
    expect(got.toString('utf8')).toBe('source-bytes');
  });

  it('14. preserves prior canonical → emits version.added with versionedPath', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    // Prior canonical render already on disk.
    writeFileSync(join(projectDir, 'plans/plot.md'), 'AUTO original plot');
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () => fakeBundle([node('plot', 'plans/plot.md')]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'plot',
      payload: { kind: 'text', content: 'NEW user plot' },
    });
    // Versioned sibling exists on disk + holds the old bytes.
    expect(existsSync(join(projectDir, 'plans/plot.v1.md'))).toBe(true);
    expect(readFileSync(join(projectDir, 'plans/plot.v1.md'), 'utf8')).toBe('AUTO original plot');
    // Canonical holds the new bytes.
    expect(readFileSync(join(projectDir, 'plans/plot.md'), 'utf8')).toBe('NEW user plot');
    // version.added event names the versioned path.
    const events = readEvents(projectDir);
    const added = events.filter((e) => e.kind === 'version.added');
    expect(added.length).toBeGreaterThanOrEqual(1);
    const plotPreservation = added.find((e) => (e.payload as { outputPath?: string }).outputPath?.endsWith('plans/plot.v1.md'));
    expect(plotPreservation).toBeDefined();
  });

  it('15. cascade preserves downstream artifacts → version.added events name each', async () => {
    const { projectDir } = setupProject({
      walkState: {
        nodes: {
          plot: { status: 'completed', outputPath: 'plans/plot.md' },
          story: { status: 'completed', outputPath: 'plans/story.md' },
        },
        lastInvalidatedIds: [],
      },
    });
    dirs.push(projectDir);
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/plot.md'), 'old plot');
    writeFileSync(join(projectDir, 'plans/story.md'), 'old story');

    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () =>
        fakeBundle([
          node('plot', 'plans/plot.md'),
          node('story', 'plans/story.md', 'md', [{ from: 'plot' }]),
        ]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      nodeId: 'plot',
      payload: { kind: 'text', content: 'new plot' },
    });
    // Downstream story preserved (not deleted) as story.v1.md.
    expect(existsSync(join(projectDir, 'plans/story.v1.md'))).toBe(true);
    expect(readFileSync(join(projectDir, 'plans/story.v1.md'), 'utf8')).toBe('old story');
    // A version.added event names story.v1.md.
    const added = readEvents(projectDir).filter((e) => e.kind === 'version.added');
    const storyPreserved = added.find((e) => (e.payload as { outputPath?: string }).outputPath?.endsWith('plans/story.v1.md'));
    expect(storyPreserved).toBeDefined();
  });

  it('16. BUG: per-instance cascade only — overriding shot_image_prompt:scene_1_shot_3 must NOT clear sibling shot walkState entries', async () => {
    // Real-world regression: user critiqued shot 3 via dhee_critique_node,
    // which writes shot_image_prompt:scene_1_shot_3 then cascades. The
    // pre-fix cascade was bare-node-id based, so it cleared ALL items
    // of every downstream node (shot_image:scene_1_shot_1..7 + scene_clip
    // + final_video). Result: user said "fix shot 3" but shots 6, 7 got
    // rerendered too. The fix uses cascadeInvalidationKeys (per-instance).

    const { projectDir } = setupProject({
      walkState: {
        nodes: {
          // Upstream — untouched.
          characters_plan: { status: 'completed', outputPath: 'plans/characters_plan.json' },
          // shot_image_prompt items: 1..7.
          'shot_image_prompt:scene_1_shot_1': { status: 'completed', outputPath: 'prompts/shot_image/scene_1_shot_1.json' },
          'shot_image_prompt:scene_1_shot_2': { status: 'completed', outputPath: 'prompts/shot_image/scene_1_shot_2.json' },
          'shot_image_prompt:scene_1_shot_3': { status: 'completed', outputPath: 'prompts/shot_image/scene_1_shot_3.json' },
          'shot_image_prompt:scene_1_shot_4': { status: 'completed', outputPath: 'prompts/shot_image/scene_1_shot_4.json' },
          'shot_image_prompt:scene_1_shot_5': { status: 'completed', outputPath: 'prompts/shot_image/scene_1_shot_5.json' },
          'shot_image_prompt:scene_1_shot_6': { status: 'completed', outputPath: 'prompts/shot_image/scene_1_shot_6.json' },
          'shot_image_prompt:scene_1_shot_7': { status: 'completed', outputPath: 'prompts/shot_image/scene_1_shot_7.json' },
          // shot_image items: 1..7.
          'shot_image:scene_1_shot_1': { status: 'completed', outputPath: 'assets/images/scene_1_shot_1.png' },
          'shot_image:scene_1_shot_2': { status: 'completed', outputPath: 'assets/images/scene_1_shot_2.png' },
          'shot_image:scene_1_shot_3': { status: 'completed', outputPath: 'assets/images/scene_1_shot_3.png' },
          'shot_image:scene_1_shot_4': { status: 'completed', outputPath: 'assets/images/scene_1_shot_4.png' },
          'shot_image:scene_1_shot_5': { status: 'completed', outputPath: 'assets/images/scene_1_shot_5.png' },
          'shot_image:scene_1_shot_6': { status: 'completed', outputPath: 'assets/images/scene_1_shot_6.png' },
          'shot_image:scene_1_shot_7': { status: 'completed', outputPath: 'assets/images/scene_1_shot_7.png' },
        },
        lastInvalidatedIds: [],
      },
    });
    dirs.push(projectDir);
    mkdirSync(join(projectDir, 'prompts/shot_image'), { recursive: true });
    mkdirSync(join(projectDir, 'assets/images'), { recursive: true });
    // Seed all the canonical artifacts on disk so preserveAsVersion has something to rename.
    for (const i of [1, 2, 3, 4, 5, 6, 7]) {
      writeFileSync(join(projectDir, `prompts/shot_image/scene_1_shot_${i}.json`), `{"old":${i}}`);
      writeFileSync(join(projectDir, `assets/images/scene_1_shot_${i}.png`), `IMG${i}`);
    }
    // Seed events.jsonl with per-instance deps so cascadeInvalidationKeys
    // has a graph to walk: shot_image:N consumes shot_image_prompt:N only.
    const { openEventLog } = await import('../../src/dag/eventLog/EventLog.js');
    const log = openEventLog(projectDir);
    for (const i of [1, 2, 3, 4, 5, 6, 7]) {
      log.append({
        kind: 'node.completed',
        actor: 'walker',
        branchId: 'main',
        payload: {
          nodeId: 'shot_image_prompt',
          itemId: `scene_1_shot_${i}`,
          versionId: `sip-${i}`,
          outputPath: `prompts/shot_image/scene_1_shot_${i}.json`,
          dependencies: [{ nodeId: 'characters_plan', role: 'context' }],
        },
      });
      log.append({
        kind: 'node.completed',
        actor: 'walker',
        branchId: 'main',
        payload: {
          nodeId: 'shot_image',
          itemId: `scene_1_shot_${i}`,
          versionId: `si-${i}`,
          outputPath: `assets/images/scene_1_shot_${i}.png`,
          dependencies: [{ nodeId: 'shot_image_prompt', itemId: `scene_1_shot_${i}`, role: 'input' }],
        },
      });
    }

    // Bundle: characters_plan -> shot_image_prompt -> shot_image
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () => {
        const bundle = fakeBundle([
          node('characters_plan', 'plans/characters_plan.json', 'json'),
          {
            ...node('shot_image_prompt', 'prompts/shot_image/{{item_id}}.json', 'json', [{ from: 'characters_plan' }]),
            kind: 'collection',
          } as unknown as NodeDef,
          {
            ...node('shot_image', 'assets/images/{{item_id}}.png', 'image', [{ from: 'shot_image_prompt' }]),
            kind: 'collection',
          } as unknown as NodeDef,
        ]);
        return bundle;
      },
    }) as unknown as ToolLike;

    // Override shot 3 only.
    await tool.execute('t', {
      projectDir,
      nodeId: 'shot_image_prompt',
      itemId: 'scene_1_shot_3',
      payload: { kind: 'text', content: '{"new":3}' },
    });

    const ws = readWalkState(projectDir);

    // shot 3's prompt is user-completed (just written).
    expect(ws.nodes['shot_image_prompt:scene_1_shot_3']?.status).toBe('completed');
    expect(ws.nodes['shot_image_prompt:scene_1_shot_3']?.generation?.tool).toBe('user');

    // shot 3's image MUST be cleared (downstream of the edit).
    expect(ws.nodes['shot_image:scene_1_shot_3']).toBeUndefined();

    // shots 1, 2, 4, 5, 6, 7 are SIBLINGS — not downstream of shot 3.
    // Their walkState entries MUST remain intact.
    for (const i of [1, 2, 4, 5, 6, 7]) {
      expect(
        ws.nodes[`shot_image_prompt:scene_1_shot_${i}`],
        `shot_image_prompt:scene_1_shot_${i} must NOT be cleared by an edit on shot 3`,
      ).toBeDefined();
      expect(
        ws.nodes[`shot_image:scene_1_shot_${i}`],
        `shot_image:scene_1_shot_${i} must NOT be cleared by an edit on shot 3`,
      ).toBeDefined();
    }

    // Same on disk: sibling artifacts must survive.
    for (const i of [1, 2, 4, 5, 6, 7]) {
      expect(
        existsSync(join(projectDir, `assets/images/scene_1_shot_${i}.png`)),
        `shot_image:scene_1_shot_${i}.png must survive an edit on shot 3`,
      ).toBe(true);
    }

    // Upstream entry untouched.
    expect(ws.nodes.characters_plan?.status).toBe('completed');
  });

  it('13. node not in bundle → error', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () => fakeBundle([node('plot', 'plans/plot.md')]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      nodeId: 'this_does_not_exist',
      payload: { kind: 'text', content: 'x' },
    });
    expect(r.isError).toBe(true);
  });

  // ── Blast-radius gate (disambiguate-mutation-tools) ─────────────────
  // A fan-out SOURCE node (scenes_plan: the shot_image_prompt collection
  // fans out over it) edited WITHOUT an itemId re-renders every shot.
  // That sledgehammer must require confirm; a per-item edit must not.

  function fanOutBundle(): DagBundle {
    return fakeBundle([
      node('scenes_plan', 'plans/scenes_plan.json', 'json'),
      {
        ...node('shot_image_prompt', 'prompts/shots/{{item_id}}.json', 'json', [{ from: 'scenes_plan' }]),
        kind: 'collection',
        itemSource: 'scenes_plan',
      } as unknown as NodeDef,
      {
        ...node('shot_image', 'assets/{{item_id}}.png', 'image', [{ from: 'shot_image_prompt' }]),
        kind: 'collection',
        itemSource: 'shot_image_prompt',
      } as unknown as NodeDef,
    ]);
  }

  it('17. overwriting a fan-out source (scenes_plan) without confirm → preview, NO write', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({ loadBundleForProject: fanOutBundle }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      nodeId: 'scenes_plan',
      payload: { kind: 'text', content: '{"scenes":[],"shots":[]}' },
    });
    // Informational preview, names the fan-out + steers to the item node.
    expect(r.content[0].text).toMatch(/re-render|fan out|every item/i);
    expect(r.content[0].text).toMatch(/shot_image_prompt/);
    expect(r.content[0].text).toMatch(/confirm=true/);
    // Nothing written.
    expect(existsSync(join(projectDir, 'plans/scenes_plan.json'))).toBe(false);
  });

  it('18. overwriting scenes_plan WITH confirm=true → writes', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({ loadBundleForProject: fanOutBundle }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      nodeId: 'scenes_plan',
      payload: { kind: 'text', content: '{"scenes":[],"shots":[]}' },
      confirm: true,
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(projectDir, 'plans/scenes_plan.json'))).toBe(true);
    expect(readWalkState(projectDir).nodes['scenes_plan']?.status).toBe('completed');
  });

  it('19. surgical per-item edit (shot_image_prompt + itemId) writes directly — no confirm needed', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({ loadBundleForProject: fanOutBundle }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      nodeId: 'shot_image_prompt',
      itemId: 'scene_1_shot_1',
      payload: { kind: 'text', content: '{"imagePrompt":"wide establishing shot"}' },
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(projectDir, 'prompts/shots/scene_1_shot_1.json'))).toBe(true);
    expect(readWalkState(projectDir).nodes['shot_image_prompt:scene_1_shot_1']?.status).toBe('completed');
  });

  it('20. a standalone leaf node (no downstream) writes directly', async () => {
    const { projectDir } = setupProject();
    dirs.push(projectDir);
    const tool = makeWriteNodeContentTool({
      loadBundleForProject: () => fakeBundle([node('plot', 'plans/plot.md')]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      nodeId: 'plot',
      payload: { kind: 'text', content: '# new plot' },
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(projectDir, 'plans/plot.md'))).toBe(true);
  });
});
