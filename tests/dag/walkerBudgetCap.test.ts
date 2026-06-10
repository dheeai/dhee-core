/**
 * budgetCapUsd — the walker's paid-spend backstop.
 *
 * Behavior pinned here:
 *   (a) No cap (default): a walk runs straight to the goal regardless of
 *       spend (control).
 *   (b) Local-only ($0) walks never trip, even with a tiny cap.
 *   (c) Cap crossed mid-fan-out: the walk halts BEFORE the next paid
 *       instance, reports `budgetExceeded` (ok:true), leaves the goal
 *       unrun, and overshoots by at most one instance's cost.
 *   (d) Seed carries across resumes: a second walk seeds spend from the
 *       event log, so re-running WITHOUT raising the cap re-trips
 *       immediately and does no new work (no wasted spend).
 *   (e) Resume after raising the cap cache-skips completed work and
 *       reaches the goal.
 *   (f) A budget halt emits a `budget.exceeded` event for the audit log.
 *
 * Bundle shape: upstream(stage) → fanout(collection, items a/b/c) →
 * final(stage, goal). Each instance stamps a configurable costUsd.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner } from '../../src/dag/schema.js';

let ran: string[] = [];

/**
 * Records each (node[:item]) it runs and stamps a per-node costUsd from
 * `config.costUsd` (default 0) onto result.metadata — the field the
 * walker tallies for the budget cap.
 */
function costingRunner(): Runner {
  return {
    describe: () => ({
      id: 'stub.cost',
      displayName: 'cost',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      ran.push(ctx.itemId ? `${ctx.node.id}:${ctx.itemId}` : ctx.node.id);
      const out = ctx.node.outputs.pattern.replace(/\{\{item_id\}\}/g, ctx.itemId ?? '');
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      const content =
        ctx.node.id === 'upstream'
          ? JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
          : 'x';
      writeFileSync(abs, content);
      const costUsd = (ctx.node.runner.config as { costUsd?: number }).costUsd ?? 0;
      return { ok: true, outputPath: out, metadata: { costUsd } };
    },
  };
}

let projectDir: string;
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'budget-cap-'));
  ran = [];
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.cost', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    costingRunner(),
  );
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

/** Each instance costs $2. upstream + 3 fan-out items + final = 5 calls = $10. */
function bundle(costUsd: number): DagBundle {
  return {
    id: 'budget',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'final',
    nodes: [
      {
        id: 'upstream',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'upstream.json' },
        runner: { tool: 'stub.cost', config: { costUsd } },
      },
      {
        id: 'fanout',
        kind: 'collection',
        itemSource: 'upstream',
        inputs: [{ from: 'upstream', usage: 'input' }],
        outputs: { format: 'json', pattern: 'fanout/{{item_id}}.json' },
        runner: { tool: 'stub.cost', config: { costUsd } },
      },
      {
        id: 'final',
        kind: 'stage',
        inputs: [{ from: 'fanout', usage: 'context' }],
        outputs: { format: 'video', pattern: 'final.mp4' },
        runner: { tool: 'stub.cost', config: { costUsd } },
      },
    ],
  };
}

describe('budgetCapUsd', () => {
  it('(a) no cap: runs straight to the goal regardless of spend', async () => {
    const r = await walkBundle({
      projectDir,
      bundle: bundle(2),
      bundleSource: 'built-in:budget',
    });
    expect(r.ok).toBe(true);
    expect(r.budgetExceeded).toBeUndefined();
    expect(r.goal?.outputRel).toBe('final.mp4');
    expect(ran).toContain('final');
  });

  it('(b) local-only ($0) walks never trip, even with a tiny cap', async () => {
    const r = await walkBundle({
      projectDir,
      bundle: bundle(0), // every instance costs $0
      bundleSource: 'built-in:budget',
      budgetCapUsd: 0.01,
    });
    expect(r.ok).toBe(true);
    expect(r.budgetExceeded).toBeUndefined();
    expect(r.goal?.outputRel).toBe('final.mp4');
  });

  it('(c) halts before the next paid instance once spend reaches the cap', async () => {
    // Each instance $2, cap $3. upstream→$2, fanout:a→$4 (≥3) → halt
    // before fanout:b. Overshoot is one instance ($4 vs $3 cap).
    const r = await walkBundle({
      projectDir,
      bundle: bundle(2),
      bundleSource: 'built-in:budget',
      budgetCapUsd: 3,
    });
    expect(r.ok).toBe(true); // an intentional pause, not a failure
    expect(r.goal).toBeUndefined();
    expect(r.budgetExceeded).toBeDefined();
    expect(r.budgetExceeded?.capUsd).toBe(3);
    expect(r.budgetExceeded?.spentUsd).toBe(4);
    expect(r.budgetExceeded?.nextNodeId).toBe('fanout');
    expect(r.budgetExceeded?.itemId).toBe('b');
    // upstream + fanout:a ran; fanout:b/c and final did NOT.
    expect(ran).toEqual(['upstream', 'fanout:a']);
  });

  it('(d) re-running without raising the cap re-trips immediately (seed from log)', async () => {
    const first = await walkBundle({
      projectDir,
      bundle: bundle(2),
      bundleSource: 'built-in:budget',
      budgetCapUsd: 3,
    });
    expect(first.budgetExceeded?.spentUsd).toBe(4);

    // Resume with the SAME cap. Seed reads $4 from the event log → the
    // pre-flight check halts before fanout:b without running anything.
    ran = [];
    const second = await walkBundle({
      projectDir,
      bundle: bundle(2),
      bundleSource: 'built-in:budget',
      budgetCapUsd: 3,
    });
    expect(second.budgetExceeded).toBeDefined();
    expect(second.budgetExceeded?.spentUsd).toBe(4); // seeded, no new spend
    expect(ran).toEqual([]); // nothing new ran — no wasted spend
  });

  it('(e) resume after raising the cap reaches the goal', async () => {
    const first = await walkBundle({
      projectDir,
      bundle: bundle(2),
      bundleSource: 'built-in:budget',
      budgetCapUsd: 3,
    });
    expect(first.budgetExceeded).toBeDefined();

    // Raise the cap well above total spend. Completed work cache-skips;
    // the remaining pending instances run through to the goal.
    ran = [];
    const second = await walkBundle({
      projectDir,
      bundle: bundle(2),
      bundleSource: 'built-in:budget',
      budgetCapUsd: 100,
    });
    expect(second.ok).toBe(true);
    expect(second.budgetExceeded).toBeUndefined();
    expect(second.goal?.outputRel).toBe('final.mp4');
    // Only the previously-unrun instances ran on resume.
    expect(ran.sort()).toEqual(['fanout:b', 'fanout:c', 'final']);
  });

  it('(f) a budget halt emits a budget.exceeded event', async () => {
    await walkBundle({
      projectDir,
      bundle: bundle(2),
      bundleSource: 'built-in:budget',
      budgetCapUsd: 3,
    });
    const events = [...openEventLog(projectDir).read()];
    const budgetEvents = events.filter((e) => e.kind === 'budget.exceeded');
    expect(budgetEvents).toHaveLength(1);
    const payload = budgetEvents[0].payload as {
      capUsd: number;
      spentUsd: number;
      nextNodeId: string;
      itemId?: string;
    };
    expect(payload.capUsd).toBe(3);
    expect(payload.spentUsd).toBe(4);
    expect(payload.nextNodeId).toBe('fanout');
    expect(payload.itemId).toBe('b');
  });
});
