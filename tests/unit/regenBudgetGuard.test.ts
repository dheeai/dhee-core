/**
 * REGEN BUDGET GUARD — regression spec for the credit-burn incident.
 *
 * Field incident (2026-06-04): the agent drove ~12 regenerations of the
 * same node in a loop, each one a paid runner invocation, burning a
 * paying customer's credits before anyone noticed. `reviewLoopMax` caps
 * the WALKER's internal re-walks, but nothing caps the AGENT calling
 * dhee_regenerate_node over and over.
 *
 * This spec encodes the intended fix as a CONTRACT on the regenerate
 * tool. It is written test-first and is EXPECTED TO FAIL until the guard
 * is implemented in pass 2:
 *
 *   makeRegenerateNodeTool({ runProjectViaBundle, maxRegensPerKey? })
 *
 *   - The tool tracks regen attempts per (projectDir, nodeId[:itemId])
 *     for the life of the tool instance (one chat session).
 *   - Once a key exceeds its cap, further regens of THAT key return
 *     isError and DO NOT invoke runProjectViaBundle (no paid call).
 *   - A sane DEFAULT cap exists even when maxRegensPerKey is unset, so
 *     the 12x incident cannot recur silently.
 *   - Caps are per-key: exhausting one node does not block another.
 *   - The refusal message is actionable (mentions the limit).
 *
 * Pass 2: implement the counter + cap and these go green.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeRegenerateNodeTool } from '../../src/agent/pi/tools/dheeRegenerateNode.js';

interface ToolLike {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

const made: string[] = [];
afterEach(() => {
  made.splice(0).forEach((d) => existsSync(d) && rmSync(d, { recursive: true, force: true }));
});

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regen-budget-'));
  made.push(dir);
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({
      name: 'x',
      bundleSource: 'built-in:narrative_qwen_chain_relay',
      walkState: {
        nodes: {
          story: { status: 'completed', outputPath: 'plans/story.md' },
          'shot_image:scene_1_shot_3': {
            status: 'completed',
            outputPath: 'assets/3.png',
            itemId: 'scene_1_shot_3',
          },
        },
      },
    }),
  );
  return dir;
}

describe('regenerate budget guard (credit-burn regression)', () => {
  it('honors an explicit per-key cap: the (cap+1)th regen is refused and makes NO paid call', async () => {
    const dir = tmpProject();
    const runProjectViaBundle = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeRegenerateNodeTool({
      runProjectViaBundle,
      maxRegensPerKey: 3,
    } as never) as unknown as ToolLike;

    // First 3 are allowed.
    for (let i = 0; i < 3; i++) {
      const out = await tool.execute('t', { projectDir: dir, nodeId: 'story' });
      expect(out.isError).toBeFalsy();
    }
    expect(runProjectViaBundle).toHaveBeenCalledTimes(3);

    // The 4th must be refused — and must NOT reach the paid runner.
    const refused = await tool.execute('t', { projectDir: dir, nodeId: 'story' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/limit|cap|budget|too many|maximum/i);
    expect(runProjectViaBundle).toHaveBeenCalledTimes(3); // unchanged
  });

  it('enforces a sane DEFAULT cap so the ~12x incident cannot recur', async () => {
    const dir = tmpProject();
    const runProjectViaBundle = vi.fn().mockResolvedValue({ ok: true });
    // No maxRegensPerKey supplied — rely on the built-in default.
    const tool = makeRegenerateNodeTool({ runProjectViaBundle }) as unknown as ToolLike;

    let refusedAt = -1;
    for (let i = 1; i <= 20; i++) {
      const out = await tool.execute('t', { projectDir: dir, nodeId: 'story' });
      if (out.isError) {
        refusedAt = i;
        break;
      }
    }
    // The agent must be stopped well before the 12x real-world blowout.
    expect(refusedAt).toBeGreaterThan(0);
    expect(refusedAt).toBeLessThanOrEqual(12);
  });

  it('caps are per-key: exhausting one node does not block a different node', async () => {
    const dir = tmpProject();
    const runProjectViaBundle = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeRegenerateNodeTool({
      runProjectViaBundle,
      maxRegensPerKey: 2,
    } as never) as unknown as ToolLike;

    // Burn through story's budget.
    await tool.execute('t', { projectDir: dir, nodeId: 'story' });
    await tool.execute('t', { projectDir: dir, nodeId: 'story' });
    const storyRefused = await tool.execute('t', { projectDir: dir, nodeId: 'story' });
    expect(storyRefused.isError).toBe(true);

    // A different key still has its full budget.
    const other = await tool.execute('t', {
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
    });
    expect(other.isError).toBeFalsy();
  });
});
