/**
 * dhee_present_bundle_choices — TDD coverage.
 *
 * A UI-signal tool: server-side it just echoes its inputs. The desktop
 * watches for this tool's tool_call event and renders the bundleIds
 * as clickable cards in chat. Click → desktop sends "Use <bundleId>"
 * as the next user message.
 *
 * Failure modes:
 *  1. Valid bundleIds → returns ok with bundleIds.
 *  2. Question recorded when provided.
 *  3. Empty bundleIds rejected (UI would have nothing to render).
 *  4. Output is parseable JSON in text content.
 *  5. Non-string entries in bundleIds rejected.
 *  6. Duplicates allowed but deduped in output (defensive).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePresentBundleChoicesTool } from '../../src/agent/pi/tools/dheePresentBundleChoices.js';

interface ToolLike {
  execute: (
    id: string,
    params: { bundleIds: string[]; question?: string },
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

describe('dhee_present_bundle_choices', () => {
  it('1. valid bundleIds → ok with the choices echoed back', async () => {
    const tool = makePresentBundleChoicesTool() as unknown as ToolLike;
    const r = await tool.execute('t', { bundleIds: ['narrative_prompt_relay', 'narrative_shot_by_shot'] });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.bundleIds).toEqual(['narrative_prompt_relay', 'narrative_shot_by_shot']);
    expect(parsed.kind).toBe('bundle_choices');
  });

  it('2. question recorded when provided', async () => {
    const tool = makePresentBundleChoicesTool() as unknown as ToolLike;
    const r = await tool.execute('t', { bundleIds: ['a'], question: 'Which fits your story?' });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.question).toBe('Which fits your story?');
  });

  it('3. empty bundleIds rejected', async () => {
    const tool = makePresentBundleChoicesTool() as unknown as ToolLike;
    const r = await tool.execute('t', { bundleIds: [] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/empty|at least one/i);
  });

  it('4. output is parseable JSON', async () => {
    const tool = makePresentBundleChoicesTool() as unknown as ToolLike;
    const r = await tool.execute('t', { bundleIds: ['x'] });
    expect(r.content[0].type).toBe('text');
    expect(() => JSON.parse(r.content[0].text)).not.toThrow();
  });

  it('5. non-string entries rejected', async () => {
    const tool = makePresentBundleChoicesTool() as unknown as ToolLike;
    const r = await tool.execute('t', { bundleIds: ['a', 123 as unknown as string] });
    expect(r.isError).toBe(true);
  });

  it('6. duplicates deduped', async () => {
    const tool = makePresentBundleChoicesTool() as unknown as ToolLike;
    const r = await tool.execute('t', { bundleIds: ['a', 'b', 'a'] });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.bundleIds).toEqual(['a', 'b']);
  });

  it('7. includes runtime support metadata for bundle choice cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dhee-bundle-choices-'));
    const savedUserDir = process.env['DHEE_USER_BUNDLES_DIR'];
    try {
      process.env['DHEE_USER_BUNDLES_DIR'] = dir;
      mkdirSync(join(dir, 'cloudy'), { recursive: true });
      writeFileSync(
        join(dir, 'cloudy', 'bundle.json'),
        JSON.stringify({
          id: 'cloudy',
          version: '0.1.0',
          displayName: 'Cloudy',
          summary: 'Cloud capable.',
          runtimeSupport: {
            modes: ['local', 'dhee_cloud'],
            providers: ['comfy'],
          },
        }),
      );

      const tool = makePresentBundleChoicesTool() as unknown as ToolLike;
      const r = await tool.execute('t', { bundleIds: ['cloudy'] });
      const parsed = JSON.parse(r.content[0].text);

      expect(parsed.bundles[0]).toMatchObject({
        id: 'cloudy',
        displayName: 'Cloudy',
        summary: 'Cloud capable.',
        runtimeSupport: {
          modes: ['local', 'dhee_cloud'],
          providers: ['comfy'],
        },
      });
    } finally {
      if (savedUserDir === undefined) delete process.env['DHEE_USER_BUNDLES_DIR'];
      else process.env['DHEE_USER_BUNDLES_DIR'] = savedUserDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
