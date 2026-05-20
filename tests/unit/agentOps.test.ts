/**
 * Tests for the pure agent-control operations exposed via HTTP.
 *
 * These mirror the per-script logic in scripts/* but as pure functions
 * over a project file so they can be reused by HTTP route handlers and
 * tested without spawning child processes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  computeStatus,
  regenNodes,
  overrideNode,
  inspectNode,
} from '../../src/server/agentOps.js';
import type { ProjectFile, ExecutionNode, ExecutorState } from '../../scripts/cli-helpers.js';

function mkNode(over: Partial<ExecutionNode> & Pick<ExecutionNode, 'id' | 'typeId'>): ExecutionNode {
  return {
    status: 'pending',
    dependencies: [],
    dependents: [],
    ...over,
  } as ExecutionNode;
}

function mkProject(nodes: ExecutionNode[]): ProjectFile {
  const nodesById: Record<string, ExecutionNode> = {};
  for (const n of nodes) nodesById[n.id] = n;
  return {
    version: '1',
    id: 'test',
    title: 'Test Project',
    style: 'cinematic_realism',
    targetDuration: 60,
    inputType: 'story',
    templateId: 'narrative',
    currentPhase: 'in_progress',
    executorState: { nodes: nodesById, updatedAt: Date.now() } as ExecutorState,
  } as ProjectFile;
}

describe('agentOps.computeStatus', () => {
  it('returns counts grouped by status', () => {
    const project = mkProject([
      mkNode({ id: 'plot', typeId: 'plot', status: 'completed' }),
      mkNode({ id: 'story', typeId: 'story', status: 'completed' }),
      mkNode({ id: 'scene:scene_1', typeId: 'scene', status: 'pending' }),
      mkNode({ id: 'shot_image:scene_1_shot_1', typeId: 'shot_image', status: 'failed', error: 'boom' }),
    ]);
    const status = computeStatus(project);
    expect(status.counts.completed).toBe(2);
    expect(status.counts.pending).toBe(1);
    expect(status.counts.failed).toBe(1);
    expect(status.counts.running).toBe(0);
    expect(status.totalNodes).toBe(4);
  });

  it('rolls up counts per typeId', () => {
    const project = mkProject([
      mkNode({ id: 'shot_image:a', typeId: 'shot_image', status: 'completed' }),
      mkNode({ id: 'shot_image:b', typeId: 'shot_image', status: 'completed' }),
      mkNode({ id: 'shot_image:c', typeId: 'shot_image', status: 'pending' }),
    ]);
    const status = computeStatus(project);
    expect(status.byType['shot_image']).toEqual({ total: 3, completed: 2, pending: 1, failed: 0, running: 0, skipped: 0 });
  });

  it('returns failed nodes with error messages so callers can surface them', () => {
    const project = mkProject([
      mkNode({ id: 'shot_video:a', typeId: 'shot_video', status: 'failed', error: 'comfy timeout' }),
      mkNode({ id: 'shot_video:b', typeId: 'shot_video', status: 'completed' }),
    ]);
    const status = computeStatus(project);
    expect(status.failedNodes).toEqual([{ id: 'shot_video:a', error: 'comfy timeout' }]);
  });

  it('handles missing executorState gracefully', () => {
    const project = { ...mkProject([]), executorState: undefined as unknown as ExecutorState };
    const status = computeStatus(project);
    expect(status.totalNodes).toBe(0);
    expect(status.byType).toEqual({});
  });

  it('returns project metadata so callers do not have to re-parse project.json', () => {
    const project = mkProject([]);
    const status = computeStatus(project);
    expect(status.title).toBe('Test Project');
    expect(status.style).toBe('cinematic_realism');
    expect(status.targetDuration).toBe(60);
    expect(status.currentPhase).toBe('in_progress');
  });
});

describe('agentOps.regenNodes', () => {
  it('marks the named node as pending and clears its outputs/timestamps', () => {
    const project = mkProject([
      mkNode({
        id: 'shot_image_prompt:scene_1_shot_1',
        typeId: 'shot_image_prompt',
        status: 'completed',
        outputPath: 'prompts/x.json',
        completedAt: 1234,
        startedAt: 1000,
      }),
    ]);
    const result = regenNodes(project, ['scene_1_shot_1.prompt']);
    const node = project.executorState!.nodes['shot_image_prompt:scene_1_shot_1']!;
    expect(node.status).toBe('pending');
    expect(node.outputPath).toBeUndefined();
    expect(node.completedAt).toBeUndefined();
    expect(node.startedAt).toBeUndefined();
    expect(result.changed).toEqual(['shot_image_prompt:scene_1_shot_1']);
  });

  it('cascade=true also marks downstream dependents as pending', () => {
    const project = mkProject([
      mkNode({ id: 'a', typeId: 'a', status: 'completed', dependents: ['b'] }),
      mkNode({ id: 'b', typeId: 'b', status: 'completed', dependents: ['c'], dependencies: ['a'] }),
      mkNode({ id: 'c', typeId: 'c', status: 'completed', dependencies: ['b'] }),
    ]);
    const result = regenNodes(project, ['a'], { cascade: true });
    expect(result.changed).toEqual(['a', 'b', 'c']);
    expect(project.executorState!.nodes['b']!.status).toBe('pending');
    expect(project.executorState!.nodes['c']!.status).toBe('pending');
  });

  it('returns notFound for aliases that do not resolve', () => {
    const project = mkProject([mkNode({ id: 'real', typeId: 'real' })]);
    const result = regenNodes(project, ['ghost']);
    expect(result.notFound).toEqual(['ghost']);
    expect(result.changed).toEqual([]);
  });

  it('throws when project has no executorState — caller cannot regen what does not exist', () => {
    const project = { ...mkProject([]), executorState: undefined as unknown as ExecutorState };
    expect(() => regenNodes(project, ['anything'])).toThrow(/executorState/i);
  });
});

describe('agentOps.overrideNode', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'dhee-override-'));
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes content to the node outputPath and marks completed', () => {
    const project = mkProject([
      mkNode({
        id: 'character:elara',
        typeId: 'character',
        itemId: 'elara',
        status: 'pending',
        outputPath: 'characters/elara.md',
      }),
    ]);
    const result = overrideNode({ project, projectDir, alias: 'character:elara', content: '# Elara\n\nFighter.' });
    const filePath = join(projectDir, 'characters', 'elara.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('Fighter');
    const node = project.executorState!.nodes['character:elara']!;
    expect(node.status).toBe('completed');
    expect(node.outputPath).toBe('characters/elara.md');
    expect(node.completedAt).toBeDefined();
    expect(result.outputPath).toBe('characters/elara.md');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('derives a default outputPath when the node has none', () => {
    const project = mkProject([
      mkNode({ id: 'character:bren', typeId: 'character', itemId: 'bren' }),
    ]);
    const result = overrideNode({ project, projectDir, alias: 'character:bren', content: 'Bren.' });
    expect(result.outputPath).toBe('characters/bren.md');
    expect(existsSync(join(projectDir, result.outputPath))).toBe(true);
  });

  it('throws when alias does not resolve to a node', () => {
    const project = mkProject([mkNode({ id: 'real', typeId: 'real' })]);
    expect(() => overrideNode({ project, projectDir, alias: 'ghost', content: 'x' })).toThrow(/ghost/);
  });
});

describe('agentOps.inspectNode', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'dhee-inspect-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns node metadata and content for a text artifact', () => {
    mkdirSync(join(projectDir, 'characters'), { recursive: true });
    writeFileSync(join(projectDir, 'characters', 'elara.md'), '# Elara\nFighter.');
    const project = mkProject([
      mkNode({
        id: 'character:elara',
        typeId: 'character',
        itemId: 'elara',
        status: 'completed',
        outputPath: 'characters/elara.md',
      }),
    ]);
    const out = inspectNode(project, projectDir, 'character:elara');
    expect(out.node.id).toBe('character:elara');
    expect(out.node.status).toBe('completed');
    expect(out.content).toContain('Fighter');
    expect(out.binary).toBe(false);
    expect(out.exists).toBe(true);
  });

  it('marks binary artifacts so callers know not to send raw bytes back as text', () => {
    mkdirSync(join(projectDir, 'assets/images'), { recursive: true });
    writeFileSync(join(projectDir, 'assets/images/x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const project = mkProject([
      mkNode({
        id: 'shot_image:s1',
        typeId: 'shot_image',
        status: 'completed',
        outputPath: 'assets/images/x.png',
      }),
    ]);
    const out = inspectNode(project, projectDir, 'shot_image:s1');
    expect(out.binary).toBe(true);
    expect(out.exists).toBe(true);
    expect(out.content).toBeUndefined();
  });

  it('returns exists=false when node has outputPath but file is gone', () => {
    const project = mkProject([
      mkNode({
        id: 'character:a',
        typeId: 'character',
        status: 'completed',
        outputPath: 'characters/missing.md',
      }),
    ]);
    const out = inspectNode(project, projectDir, 'character:a');
    expect(out.exists).toBe(false);
  });

  it('throws when the alias does not resolve', () => {
    const project = mkProject([mkNode({ id: 'real', typeId: 'real' })]);
    expect(() => inspectNode(project, projectDir, 'ghost')).toThrow(/ghost/);
  });
});
