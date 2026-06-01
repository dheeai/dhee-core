/**
 * dhee_list_bundles — TDD coverage.
 *
 * The tool reads <REPO_ROOT>/src/dag/bundles/ and returns one entry
 * per built-in bundle so the pi-agent can introspect what pipelines
 * are available before pinning a project.
 *
 * Failure modes:
 *   1. Empty bundles dir → empty list (no crash).
 *   2. Three bundles → three entries with id + description + version.
 *   3. Subdir missing bundle.json → skipped, no crash.
 *   4. bundle.json with malformed JSON → skipped, no crash; other
 *      bundles in the same dir still appear.
 *   5. Single-file `<id>.json` bundle alongside directory bundles
 *      → included.
 *   6. Result is sorted alphabetically by id (stable ordering for the
 *      agent's reasoning).
 *   7. bundle.json with no `description` field → description defaults
 *      to empty string (don't crash; description is optional metadata).
 *   8. The tool's contract returns `text` content with a JSON-encoded
 *      array the agent can parse.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeListBundlesTool } from '../../src/agent/pi/tools/dheeListBundles.js';

function setupBundlesDir(layout: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), 'dhee-bundles-test-'));
  for (const [path, contents] of Object.entries(layout)) {
    const full = join(root, path);
    const parent = full.slice(0, full.lastIndexOf('/'));
    mkdirSync(parent, { recursive: true });
    if (contents !== null) writeFileSync(full, contents, 'utf8');
  }
  return root;
}

async function callTool(bundlesDir: string) {
  const tool = makeListBundlesTool({ bundlesDir: () => bundlesDir });
  const r = await (tool as { execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }).execute('test-call', {});
  return r;
}

describe('dhee_list_bundles', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('1. empty bundles dir → empty array', async () => {
    const dir = setupBundlesDir({});
    made.push(dir);
    const r = await callTool(dir);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toEqual([]);
  });

  it('2. three bundles → three entries with id/description/version', async () => {
    const dir = setupBundlesDir({
      'narrative_prompt_relay/bundle.json': JSON.stringify({ id: 'narrative_prompt_relay', version: '0.1.0', description: 'Full narrative pipeline with relay.' }),
      'narrative_qwen_chain_relay/bundle.json': JSON.stringify({ id: 'narrative_qwen_chain_relay', version: '0.1.0', description: 'Qwen-chained narrative pipeline.' }),
      'narrative_shot_by_shot/bundle.json': JSON.stringify({ id: 'narrative_shot_by_shot', version: '0.1.0', description: 'Per-shot FL2V narrative pipeline.' }),
    });
    made.push(dir);
    const r = await callTool(dir);
    const parsed = JSON.parse(r.content[0].text) as Array<{ id: string; version: string; description: string }>;
    expect(parsed).toHaveLength(3);
    const ids = parsed.map((b) => b.id);
    expect(ids).toContain('narrative_prompt_relay');
    expect(ids).toContain('narrative_qwen_chain_relay');
    expect(ids).toContain('narrative_shot_by_shot');
    expect(parsed[0].description.length).toBeGreaterThan(0);
    expect(parsed[0].version).toBe('0.1.0');
  });

  it('3. subdir missing bundle.json → skipped', async () => {
    const dir = setupBundlesDir({
      'good/bundle.json': JSON.stringify({ id: 'good', version: '0.1.0', description: 'real' }),
      'empty_subdir/.gitkeep': '',
    });
    made.push(dir);
    const r = await callTool(dir);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.map((b: { id: string }) => b.id)).toEqual(['good']);
  });

  it('4. malformed bundle.json → skipped, others survive', async () => {
    const dir = setupBundlesDir({
      'broken/bundle.json': '{ not valid json',
      'good/bundle.json': JSON.stringify({ id: 'good', version: '0.1.0', description: 'real' }),
    });
    made.push(dir);
    const r = await callTool(dir);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.map((b: { id: string }) => b.id)).toEqual(['good']);
  });

  it('5. single-file <id>.json bundle is included', async () => {
    const dir = setupBundlesDir({
      'ltx_prompt_relay.json': JSON.stringify({ id: 'ltx_prompt_relay', version: '0.1.0', description: 'flat file bundle' }),
      'dir_bundle/bundle.json': JSON.stringify({ id: 'dir_bundle', version: '0.1.0', description: 'dir bundle' }),
    });
    made.push(dir);
    const r = await callTool(dir);
    const parsed = JSON.parse(r.content[0].text);
    const ids = parsed.map((b: { id: string }) => b.id).sort();
    expect(ids).toEqual(['dir_bundle', 'ltx_prompt_relay']);
  });

  it('6. results are sorted alphabetically by id', async () => {
    const dir = setupBundlesDir({
      'zebra/bundle.json': JSON.stringify({ id: 'zebra', version: '0.1.0', description: 'z' }),
      'alpha/bundle.json': JSON.stringify({ id: 'alpha', version: '0.1.0', description: 'a' }),
      'middle/bundle.json': JSON.stringify({ id: 'middle', version: '0.1.0', description: 'm' }),
    });
    made.push(dir);
    const r = await callTool(dir);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.map((b: { id: string }) => b.id)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('7. missing description → defaults to empty string (no crash)', async () => {
    const dir = setupBundlesDir({
      'no_desc/bundle.json': JSON.stringify({ id: 'no_desc', version: '0.1.0' }),
    });
    made.push(dir);
    const r = await callTool(dir);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toEqual([{ id: 'no_desc', version: '0.1.0', description: '' }]);
  });

  it('8. tool output is parseable JSON in `text` content', async () => {
    const dir = setupBundlesDir({
      'one/bundle.json': JSON.stringify({ id: 'one', version: '0.1.0', description: 'd' }),
    });
    made.push(dir);
    const r = await callTool(dir);
    expect(r.content[0].type).toBe('text');
    expect(() => JSON.parse(r.content[0].text)).not.toThrow();
  });
});
