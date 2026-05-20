/**
 * Tests for `resetProjectStage` — the in-process replacement for
 * `pnpm tsx scripts/reset-project.ts`. Verifies the actual project.json
 * mutations, not just the return shape: nodes get reset, per-item
 * nodes get removed, references get cleaned, --clean wipes the graph.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resetProjectStage,
  ResetProjectError,
} from '../../src/server/runners/resetProjectStage.js';

let basePath: string;

beforeEach(() => {
  basePath = mkdtempSync(join(tmpdir(), 'dhee-reset-stage-'));
});

afterEach(() => {
  rmSync(basePath, { recursive: true, force: true });
});

interface NodeOpts {
  id: string;
  typeId: string;
  itemId?: string;
  status?: string;
  outputPath?: string;
  promptPath?: string;
  completedAt?: number;
  error?: string;
  isCollection?: boolean;
  dependencies?: string[];
  dependents?: string[];
  artifactId?: string;
}

function n(opts: NodeOpts) {
  return {
    id: opts.id,
    typeId: opts.typeId,
    ...(opts.itemId !== undefined ? { itemId: opts.itemId } : {}),
    status: opts.status ?? 'completed',
    displayName: opts.id,
    isExpensive: false,
    isCollection: opts.isCollection ?? false,
    dependencies: opts.dependencies ?? [],
    dependents: opts.dependents ?? [],
    ...(opts.outputPath !== undefined ? { outputPath: opts.outputPath } : {}),
    ...(opts.promptPath !== undefined ? { promptPath: opts.promptPath } : {}),
    ...(opts.completedAt !== undefined ? { completedAt: opts.completedAt } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ...(opts.artifactId !== undefined ? { artifactId: opts.artifactId } : {}),
  };
}

function makeProject(name: string, project: Record<string, unknown>): string {
  const dir = join(basePath, `${name}.dhee`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2));
  return dir;
}

function readProject(name: string): Record<string, unknown> & {
  executorState?: { nodes?: Record<string, unknown> };
  currentPhase?: string;
} {
  return JSON.parse(
    readFileSync(join(basePath, `${name}.dhee`, 'project.json'), 'utf8'),
  );
}

describe('resetProjectStage validation', () => {
  it('throws ResetProjectError on unknown stage', () => {
    makeProject('p', {
      executorState: { nodes: { x: n({ id: 'x', typeId: 'shot_image' }) } },
    });
    expect(() =>
      resetProjectStage({
        basePath,
        projectName: 'p',
        stage: 'totally-made-up',
      }),
    ).toThrow(ResetProjectError);
  });

  it('throws when project does not exist', () => {
    expect(() =>
      resetProjectStage({
        basePath,
        projectName: 'ghost',
        stage: 'shot_image',
      }),
    ).toThrow(/Project not found/);
  });

  it('throws when project has no executorState', () => {
    makeProject('empty', { title: 'Empty' });
    expect(() =>
      resetProjectStage({
        basePath,
        projectName: 'empty',
        stage: 'shot_image',
      }),
    ).toThrow(/No executor state found/);
  });

  it('throws when executorState has no nodes', () => {
    makeProject('empty', { executorState: { nodes: {} } });
    expect(() =>
      resetProjectStage({
        basePath,
        projectName: 'empty',
        stage: 'shot_image',
      }),
    ).toThrow(/No executor state found/);
  });
});

describe('resetProjectStage core mutations', () => {
  it('resets type-level nodes to pending and clears outputPath/promptPath/completedAt/error', () => {
    makeProject('p', {
      executorState: {
        nodes: {
          // A non-collection node that matches the reset type
          'final_video': n({
            id: 'final_video',
            typeId: 'final_video',
            status: 'completed',
            outputPath: '/abs/final.mp4',
            promptPath: '/abs/final-prompt.json',
            completedAt: 12345,
            error: 'should be cleared',
            artifactId: 'a-1',
          }),
        },
      },
    });

    const result = resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
    });

    expect(result.resetCount).toBeGreaterThanOrEqual(1);
    const project = readProject('p');
    const fv = project.executorState!.nodes!['final_video'] as Record<
      string,
      unknown
    >;
    expect(fv['status']).toBe('pending');
    expect(fv['outputPath']).toBeUndefined();
    expect(fv['promptPath']).toBeUndefined();
    expect(fv['completedAt']).toBeUndefined();
    expect(fv['error']).toBeUndefined();
    expect(fv['artifactId']).toBeUndefined();
  });

  it('removes per-item nodes whose typeId is in the reset set', () => {
    makeProject('p', {
      executorState: {
        nodes: {
          'final_video': n({
            id: 'final_video',
            typeId: 'final_video',
            status: 'completed',
          }),
          // Per-item node (has itemId) — should be REMOVED, not reset.
          'final_video:proj1': n({
            id: 'final_video:proj1',
            typeId: 'final_video',
            itemId: 'proj1',
            status: 'completed',
          }),
        },
      },
    });

    const result = resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
    });

    expect(result.removedCount).toBeGreaterThanOrEqual(1);
    const nodes = readProject('p').executorState!.nodes!;
    expect(nodes['final_video:proj1']).toBeUndefined();
  });

  it('clears stale references in OTHER nodes after removing per-item nodes', () => {
    makeProject('p', {
      executorState: {
        nodes: {
          // Upstream non-reset type that pointed at the removed per-item.
          'scene': n({
            id: 'scene',
            typeId: 'scene',
            status: 'completed',
            dependencies: [],
            dependents: ['final_video:proj1'],
          }),
          'final_video:proj1': n({
            id: 'final_video:proj1',
            typeId: 'final_video',
            itemId: 'proj1',
            dependencies: ['scene'],
            dependents: [],
          }),
        },
      },
    });

    resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
    });

    const nodes = readProject('p').executorState!.nodes!;
    const scene = nodes['scene'] as { dependents: string[] };
    expect(scene.dependents).not.toContain('final_video:proj1');
    // Phase 7 cleanup also dedupes/filters stale refs.
  });

  it('clears project.currentPhase on reset', () => {
    makeProject('p', {
      currentPhase: 'shot_video',
      executorState: {
        nodes: {
          'final_video': n({
            id: 'final_video',
            typeId: 'final_video',
            status: 'completed',
          }),
        },
      },
    });
    resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
    });
    expect(readProject('p').currentPhase).toBeUndefined();
  });

  it('persists changes to project.json on disk', () => {
    makeProject('p', {
      executorState: {
        nodes: {
          'final_video': n({
            id: 'final_video',
            typeId: 'final_video',
            status: 'completed',
            outputPath: '/abs/old.mp4',
          }),
        },
      },
    });
    // Verify a separate read sees the mutation.
    resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
    });
    const written = JSON.parse(
      readFileSync(join(basePath, 'p.dhee', 'project.json'), 'utf8'),
    ) as Record<string, unknown> & {
      executorState?: { nodes?: Record<string, Record<string, unknown>> };
    };
    expect(written.executorState!.nodes!['final_video']!['status']).toBe(
      'pending',
    );
  });
});

describe('resetProjectStage downstream cascade', () => {
  it('resetting an upstream stage cascades to dependent stages', () => {
    // shot_image_prompt → shot_image, shot_motion_directive, shot_video, final_video
    makeProject('p', {
      executorState: {
        nodes: {
          'shot_image_prompt': n({
            id: 'shot_image_prompt',
            typeId: 'shot_image_prompt',
            status: 'completed',
          }),
          'shot_image': n({
            id: 'shot_image',
            typeId: 'shot_image',
            status: 'completed',
          }),
          'shot_video': n({
            id: 'shot_video',
            typeId: 'shot_video',
            status: 'completed',
          }),
          'final_video': n({
            id: 'final_video',
            typeId: 'final_video',
            status: 'completed',
          }),
          // Upstream node that should NOT be reset.
          'scene': n({
            id: 'scene',
            typeId: 'scene',
            status: 'completed',
          }),
        },
      },
    });

    const result = resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'shot_image_prompt',
    });

    // resetTypes includes shot_image_prompt itself + downstream.
    expect(result.resetTypes).toContain('shot_image_prompt');
    expect(result.resetTypes).toContain('shot_image');
    expect(result.resetTypes).toContain('shot_video');
    expect(result.resetTypes).toContain('final_video');
    // Upstream NOT in reset set.
    expect(result.resetTypes).not.toContain('scene');

    const nodes = readProject('p').executorState!.nodes!;
    expect((nodes['scene'] as { status: string }).status).toBe('completed');
    // Downstream got reset (note collection types may have been
    // recreated as fresh placeholders, but non-collection types
    // like final_video stay reset-in-place).
    expect((nodes['final_video'] as { status: string }).status).toBe('pending');
  });
});

describe('resetProjectStage --clean', () => {
  it('wipes executorState entirely when clean=true', () => {
    makeProject('p', {
      executorState: {
        nodes: {
          'a': n({ id: 'a', typeId: 'final_video', status: 'completed' }),
          'b': n({ id: 'b', typeId: 'shot_image', status: 'completed' }),
        },
      },
    });

    resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
      clean: true,
    });

    const project = readProject('p');
    expect(project.executorState).toBeUndefined();
  });

  it('does NOT wipe executorState when clean is false (default)', () => {
    makeProject('p', {
      executorState: {
        nodes: {
          'final_video': n({
            id: 'final_video',
            typeId: 'final_video',
            status: 'completed',
          }),
        },
      },
    });
    resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
    });
    expect(readProject('p').executorState).toBeDefined();
  });

  it('reports the wipe in the log when clean=true', () => {
    makeProject('p', {
      executorState: {
        nodes: {
          'a': n({ id: 'a', typeId: 'final_video', status: 'completed' }),
          'b': n({ id: 'b', typeId: 'shot_image', status: 'completed' }),
        },
      },
    });

    const result = resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
      clean: true,
    });
    expect(result.log.some((l) => /--clean: wiped/.test(l))).toBe(true);
  });
});

describe('resetProjectStage observability', () => {
  it('forwards every log line to onLog and returns the same lines', () => {
    makeProject('p', {
      executorState: {
        nodes: {
          'final_video': n({
            id: 'final_video',
            typeId: 'final_video',
            status: 'completed',
            outputPath: '/abs/old.mp4',
          }),
        },
      },
    });
    const onLog = vi.fn();
    const result = resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
      onLog,
    });

    expect(onLog).toHaveBeenCalled();
    // Every log line should have been forwarded.
    expect(onLog).toHaveBeenCalledTimes(result.log.length);
    // Spot-check some specific log content.
    expect(result.log.some((l) => /Reset to stage: final_video/.test(l))).toBe(
      true,
    );
    expect(result.log.some((l) => /Final state:/.test(l))).toBe(true);
  });

  it('returns final node-count summary that matches the persisted graph', () => {
    makeProject('p', {
      executorState: {
        nodes: {
          'final_video': n({
            id: 'final_video',
            typeId: 'final_video',
            status: 'completed',
          }),
          // Upstream that won't be reset
          'scene': n({
            id: 'scene',
            typeId: 'scene',
            status: 'completed',
          }),
        },
      },
    });
    const result = resetProjectStage({
      basePath,
      projectName: 'p',
      stage: 'final_video',
    });
    const nodes = readProject('p').executorState!.nodes!;
    const total = Object.keys(nodes).length;
    expect(result.remainingNodes).toBe(total);
    expect(result.completedNodes + result.pendingNodes).toBeLessThanOrEqual(
      total,
    );
  });
});
