/**
 * ProjectionEngine — bridges the event log to the back-compat walkState
 * snapshot. Failure modes:
 *
 *   1. advance(event) appends and updates the walkState in project.json.
 *   2. Re-opening on the same project recomputes walkState from the log.
 *   3. listVersions/computeBranchTree/computeCostLedger expose lazy folds.
 *   4. walkState writer is idempotent w.r.t. project.json's other fields.
 *   5. Branch isolation: branch projection only reflects that branch's events.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openProjectionEngine } from '../../../src/dag/eventLog/ProjectionEngine.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'projeng-test-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('ProjectionEngine', () => {
  it('appendAndProject writes the walkState back-compat snapshot to project.json', () => {
    const eng = openProjectionEngine(projectDir);
    eng.appendAndProject({
      branchId: 'main',
      actor: 'walker',
      kind: 'bundle.bound',
      payload: { bundleSource: 'built-in:tiny', bundleVersion: '0.1.0', engineVersion: '0.1.0' },
    });
    eng.appendAndProject({
      branchId: 'main',
      actor: 'walker',
      kind: 'node.completed',
      payload: {
        nodeId: 'a',
        versionId: 'v1',
        outputPath: 'out/a.md',
        artifact: { format: 'md' },
      },
    });

    const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as {
      walkState?: { bundleSource?: string; nodes?: Record<string, { status?: string; outputPath?: string }> };
    };
    expect(pj.walkState?.bundleSource).toBe('built-in:tiny');
    expect(pj.walkState?.nodes?.['a']?.status).toBe('completed');
    expect(pj.walkState?.nodes?.['a']?.outputPath).toBe('out/a.md');
  });

  it('re-opening the engine reads existing events and the next append continues seq', () => {
    const eng1 = openProjectionEngine(projectDir);
    eng1.appendAndProject({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'a' } });
    eng1.appendAndProject({ branchId: 'main', actor: 'walker', kind: 'node.completed', payload: { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.md' } });

    const eng2 = openProjectionEngine(projectDir);
    const e = eng2.appendAndProject({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'b' } });
    expect(e.seq).toBe(3);

    const proj = eng2.projection();
    expect(proj.nodes['a']?.status).toBe('completed');
    expect(proj.nodes['b']?.status).toBe('in_progress');
  });

  it('preserves unrelated fields in project.json', () => {
    // Pre-existing project.json with custom fields
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
      id: 'proj-xyz',
      targetDuration: 30,
      goal: { status: 'in_progress' },
    }, null, 2));

    const eng = openProjectionEngine(projectDir);
    eng.appendAndProject({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'a' } });

    const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as {
      id?: string;
      targetDuration?: number;
      goal?: { status?: string };
      walkState?: { nodes?: Record<string, unknown> };
    };
    expect(pj.id).toBe('proj-xyz');
    expect(pj.targetDuration).toBe(30);
    expect(pj.goal?.status).toBe('in_progress');
    expect(pj.walkState?.nodes?.['a']).toBeDefined();
  });

  it('exposes lazy folds: listVersions, computeBranchTree, computeCostLedger', () => {
    const eng = openProjectionEngine(projectDir);
    eng.appendAndProject({ branchId: 'main', actor: 'walker', kind: 'node.completed', payload: { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.v1.md', generation: { tool: 't', toolVersion: '1', cached: false, costUsd: 0.05 } } });
    eng.appendAndProject({ branchId: 'main', actor: 'walker', kind: 'node.invalidated', payload: { nodeId: 'a' } });
    eng.appendAndProject({ branchId: 'main', actor: 'walker', kind: 'node.completed', payload: { nodeId: 'a', versionId: 'v2', outputPath: 'out/a.v2.md', generation: { tool: 't', toolVersion: '1', cached: false, costUsd: 0.05 } } });
    eng.appendAndProject({ branchId: 'main', actor: 'user', kind: 'branch.created', payload: { branchId: 'noir', label: 'noir grade', forkedFromEventId: 'e3', parentBranchId: 'main' } });

    const versions = eng.listVersions('a');
    expect(versions).toHaveLength(2);

    const tree = eng.computeBranchTree();
    expect(tree.branches.map((b) => b.branchId).sort()).toEqual(['main', 'noir']);

    const ledger = eng.computeCostLedger();
    expect(ledger.totalUsd).toBeCloseTo(0.10);
    expect(ledger.computeCount).toBe(2);
  });

  it('branch isolation: branch projection only reflects that branch', () => {
    const eng = openProjectionEngine(projectDir);
    eng.appendAndProject({ branchId: 'main', actor: 'walker', kind: 'node.completed', payload: { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.md' } });
    eng.appendAndProject({ branchId: 'feature', actor: 'walker', kind: 'node.completed', payload: { nodeId: 'b', versionId: 'v1', outputPath: 'out/b.md' } });

    const main = eng.projection();
    const feature = eng.projection({ branchId: 'feature' });

    expect(main.nodes['a']).toBeDefined();
    expect(main.nodes['b']).toBeUndefined();
    expect(feature.nodes['b']).toBeDefined();
  });
});
