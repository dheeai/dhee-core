/**
 * Gated-run narration integration (issue #133) — drives the REAL
 * production runner singleton (which wires `executeRunTo` →
 * runProjectViaBundle → walker) through the `dhee_run_bundle` tool
 * against a project whose stop-after-each-collection gate is ON.
 *
 * This is the full blocking-path seam, no stubs in the middle:
 *   tool → singleton.dispatch → executeRunTo → runProjectViaBundle →
 *   walker gate → ExecutorGated outcome → runner stamps the terminal
 *   `completed` event → dheeRunBundle's gate branch → buildGateRunResult.
 *
 * The bug it pins: before the fix the tool returned a generic "Bundle
 * run completed", the agent saw the downstream stages produced nothing,
 * and confabulated a ComfyUI-misconfig cause. Now the tool result states
 * the real (gated) reason, names what's pending, and steers toward
 * resume — so the agent narrates correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getBackgroundTaskRunner,
  __resetBackgroundTaskRunnerForTesting,
} from '../../src/server/runners/backgroundTaskRunnerSingleton.js';
import { makeRunBundleTool } from '../../src/agent/pi/tools/dheeRunBundle.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { Runner } from '../../src/dag/schema.js';

interface ToolLike {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

/** Item-aware stub: upstream emits the fan-out items; the rest write a stub file. */
function fanRunner(): Runner {
  return {
    describe: () => ({
      id: 'test.fan',
      displayName: 'fan',
      description: 'test',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      const out = ctx.node.outputs.pattern.replace(/\{\{item_id\}\}/g, ctx.itemId ?? '');
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(
        abs,
        ctx.node.id === 'upstream'
          ? JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] })
          : 'x',
      );
      return { ok: true, outputPath: out };
    },
  };
}

describe('gated-run narration — dhee_run_bundle × real runner singleton', () => {
  let projectDir: string;
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    __resetBackgroundTaskRunnerForTesting();
    __resetGlobalRegistryForTesting();
    getGlobalRegistry().register(
      { tool: 'test.fan', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      fanRunner(),
    );

    tmpHome = mkdtempSync(join(tmpdir(), 'gated-home-'));
    origHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;

    // A user-scheme bundle: upstream(stage) → fanout(collection) → final(goal).
    const bundleDir = join(tmpHome, '.kshana/bundles', 'test_gate_e2e');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, 'bundle.json'),
      JSON.stringify({
        id: 'test_gate_e2e',
        version: '0.1.0',
        engineCompat: '>=0.1.0',
        goal: 'final',
        dependencies: { runners: { 'test.fan': '>=0.1.0' } },
        nodes: [
          {
            id: 'upstream',
            kind: 'stage',
            inputs: [],
            outputs: { format: 'json', pattern: 'upstream.json' },
            runner: { tool: 'test.fan', config: {} },
          },
          {
            id: 'fanout',
            kind: 'collection',
            itemSource: 'upstream',
            inputs: [{ from: 'upstream', usage: 'input' }],
            outputs: { format: 'json', pattern: 'fanout/{{item_id}}.json' },
            runner: { tool: 'test.fan', config: {} },
          },
          {
            id: 'final',
            kind: 'stage',
            inputs: [{ from: 'fanout', usage: 'context' }],
            outputs: { format: 'video', pattern: 'final.mp4' },
            runner: { tool: 'test.fan', config: {} },
          },
        ],
      }),
    );

    projectDir = mkdtempSync(join(tmpdir(), 'gated-proj-'));
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        bundleSource: 'user:test_gate_e2e',
        // The per-project flag the desktop's "Stop after each collection" toggle writes.
        features: { gateAfterCollections: true },
      }),
    );
  });

  afterEach(() => {
    __resetBackgroundTaskRunnerForTesting();
    __resetGlobalRegistryForTesting();
    if (origHome !== undefined) process.env['HOME'] = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns the gate reason (not a generic completion) and steers off the ComfyUI confabulation', async () => {
    const runner = getBackgroundTaskRunner();
    const tool = makeRunBundleTool({
      getBackgroundTaskRunner: () => runner as never,
    }) as unknown as ToolLike;

    const out = await tool.execute('t', { projectDir });

    // A gated pause is a successful, intentional stop — NOT an error.
    expect(out.isError).toBeFalsy();
    const text = out.content[0]!.text;
    // The real reason, named explicitly:
    expect(text).toMatch(/paused/i);
    expect(text).toContain('fanout'); // the collection it gated after
    expect(text).toMatch(/gateAfterCollections|stop after each collection/i);
    // What's still pending behind the gate (resolved through the full stack):
    expect(text).toContain('final');
    // It must NOT read as a finished run…
    expect(text).not.toMatch(/run completed \(taskId/i);
    // …and must steer the agent off the confabulation, toward resume.
    expect(text).toMatch(/ComfyUI/);
    expect(text).toMatch(/not a failure/i);
    expect(text).toMatch(/resume/i);
  });
});
