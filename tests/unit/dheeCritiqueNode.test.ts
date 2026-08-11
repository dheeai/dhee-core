/**
 * dhee_critique_node — apply an editorial critique to an LLM node.
 *
 * Zero prior direct coverage. We cover the guards that run BEFORE any
 * side effect (the safe, dispatch-free paths): missing/malformed
 * project.json, no bundleSource, unknown node, non-llm node, and the
 * two-phase PREVIEW (confirm omitted → cascade impact, no mutation).
 *
 * The confirm=true apply path dispatches the bundle (a heavy walk) and
 * is exercised via runProjectViaBundle injection in the regen/critique
 * integration suites — here we deliberately stay on the pure guard +
 * preview surface so the test is fast and deterministic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeCritiqueNodeTool } from '../../src/agent/pi/tools/dheeCritiqueNode.js';

// narrative_qwen_chain_relay was archived (#200); narrative_prompt_relay is the
// surviving bundle and has the same shape this needs: llm nodes, a non-llm node,
// and a downstream cascade.
const BUNDLE = 'built-in:narrative_prompt_relay';
const LLM_NODE = 'story'; // runner: llm.generate
const NON_LLM_NODE = 'shot_image'; // runner: comfy.qwen_edit_chain

interface ToolLike {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean; details?: Record<string, unknown> }>;
}

const made: string[] = [];
afterEach(() => {
  made.splice(0).forEach((d) => existsSync(d) && rmSync(d, { recursive: true, force: true }));
});

function tmpProject(project: Record<string, unknown> | string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'critique-'));
  made.push(dir);
  if (project !== null) {
    writeFileSync(
      join(dir, 'project.json'),
      typeof project === 'string' ? project : JSON.stringify(project),
    );
  }
  return dir;
}

// No runProjectViaBundle — the only paths that reach dispatch require
// confirm=true, which these tests never set.
const tool = () => makeCritiqueNodeTool() as unknown as ToolLike;

describe('dhee_critique_node (guards + preview)', () => {
  it('errors when project.json is missing', async () => {
    const dir = tmpProject(null);
    const out = await tool().execute('t', { projectDir: dir, nodeId: LLM_NODE, critique: 'darker' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/project\.json not found/i);
  });

  it('errors when project.json declares no bundleSource', async () => {
    const dir = tmpProject({ name: 'x' });
    const out = await tool().execute('t', { projectDir: dir, nodeId: LLM_NODE, critique: 'darker' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/bundleSource/i);
  });

  it('errors on an unknown node id', async () => {
    const dir = tmpProject({ name: 'x', bundleSource: BUNDLE });
    const out = await tool().execute('t', {
      projectDir: dir,
      nodeId: 'totally_made_up_node',
      critique: 'darker',
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/unknown node/i);
  });

  it('refuses to critique a non-llm node and points upstream', async () => {
    const dir = tmpProject({ name: 'x', bundleSource: BUNDLE });
    const out = await tool().execute('t', {
      projectDir: dir,
      nodeId: NON_LLM_NODE,
      critique: 'fix the hands',
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/not llm/i);
    expect(out.content[0].text).toMatch(/upstream/i);
  });

  it('previews the cascade without mutating when confirm is omitted', async () => {
    const dir = tmpProject({ name: 'x', bundleSource: BUNDLE });
    const out = await tool().execute('t', {
      projectDir: dir,
      nodeId: LLM_NODE,
      critique: 'darker, rainier mood',
    });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/preview/i);
    expect(out.details?.preview).toBe(true);
    expect(Array.isArray(out.details?.affectedNodes)).toBe(true);
    // Nothing has rendered yet → no already-generated artifact at risk →
    // agent is told it may proceed without asking the user.
    expect(out.details?.realImpactCount).toBe(0);
    expect(out.details?.confirmationRecommended).toBe(false);
    // The project.json must be byte-identical: preview is side-effect-free.
    const after = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(after.pendingCritiques).toBeUndefined();
  });
});
