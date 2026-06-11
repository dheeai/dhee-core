/**
 * Bottom-up building (#147) — behavioral.
 *
 * Exercises the real writeNodeContent + applyPlanItemEdit against a
 * temp project, an in-memory bundle (via the loadBundleForProject seam),
 * a seeded walkState, and a seeded event log. Covers the keystone
 * guarantees:
 *   - per-item write without itemId is refused (the concept-car bug)
 *   - membership change via raw write_node_content is hard-blocked,
 *     but allowed through the viaPlanItemEdit path
 *   - adding an item preserves sibling instances + their files
 *   - removing an item clears ONLY that item's downstream
 *   - applyPlanItemEdit validates against itemSchema + id uniqueness
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNodeContent } from '../../src/dag/writeNodeContent.js';
import { applyPlanItemEdit } from '../../src/dag/planItems.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
import type { DagBundle } from '../../src/dag/schema.js';

let projectDir: string;

const BUNDLE: DagBundle = {
  id: 'bottom-up-test',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  goal: 'character_image',
  nodes: [
    {
      id: 'characters_plan',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'json', pattern: 'plans/characters_plan.json' },
      runner: { tool: 'llm.generate', config: {} },
      agentEditable: true,
      itemSchema: {
        type: 'object',
        required: ['id', 'name', 'description'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          name: { type: 'string' },
          description: { type: 'string', minLength: 3 },
        },
      },
    },
    {
      id: 'character_image_prompt',
      kind: 'collection',
      itemSource: 'characters_plan',
      itemKey: 'characters',
      inputs: [{ from: 'characters_plan', usage: 'input', scope: 'matching' }],
      outputs: { format: 'json', pattern: 'prompts/{{item_id}}.json' },
      runner: { tool: 'llm.generate', config: {} },
    },
    {
      id: 'character_image',
      kind: 'collection',
      itemSource: 'character_image_prompt',
      inputs: [{ from: 'character_image_prompt', usage: 'input', scope: 'matching' }],
      outputs: { format: 'image', pattern: 'images/{{item_id}}.png' },
      runner: { tool: 'comfy.tti', config: {} },
    },
  ],
} as unknown as DagBundle;

const loadBundleForProject = () => BUNDLE;

const char = (id: string, desc = 'a person') => ({ id, name: id, description: desc });

/** Seed plan file + walkState + event log for chars `ids`, with each
 * char's prompt + image completed (files on disk). */
function seed(ids: string[]): void {
  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
  mkdirSync(join(projectDir, 'images'), { recursive: true });
  writeFileSync(
    join(projectDir, 'plans/characters_plan.json'),
    JSON.stringify({ characters: ids.map((id) => char(id)) }, null, 2),
  );
  const nodes: Record<string, unknown> = {
    characters_plan: {
      status: 'completed',
      outputPath: 'plans/characters_plan.json',
      generation: { tool: 'llm.generate', toolVersion: '0.1.0' },
    },
  };
  const log = openEventLog(projectDir);
  log.append({
    kind: 'node.completed',
    actor: 'runner',
    branchId: 'main',
    payload: { nodeId: 'characters_plan', outputPath: 'plans/characters_plan.json', versionId: 'cp-1' },
  });
  for (const id of ids) {
    writeFileSync(join(projectDir, `prompts/${id}.json`), '{"imagePrompt":"x"}');
    writeFileSync(join(projectDir, `images/${id}.png`), 'PNG');
    nodes[`character_image_prompt:${id}`] = { status: 'completed', outputPath: `prompts/${id}.json`, generation: { tool: 'llm.generate' } };
    nodes[`character_image:${id}`] = { status: 'completed', outputPath: `images/${id}.png`, generation: { tool: 'comfy.tti' } };
    log.append({ kind: 'node.completed', actor: 'runner', branchId: 'main', payload: { nodeId: 'character_image_prompt', itemId: id, outputPath: `prompts/${id}.json`, versionId: `cip-${id}`, dependencies: [{ nodeId: 'characters_plan' }] } });
    log.append({ kind: 'node.completed', actor: 'runner', branchId: 'main', payload: { nodeId: 'character_image', itemId: id, outputPath: `images/${id}.png`, versionId: `ci-${id}`, dependencies: [{ nodeId: 'character_image_prompt', itemId: id }] } });
  }
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({ bundleSource: 'built-in:bottom-up-test', walkState: { nodes, lastInvalidatedIds: [] } }, null, 2),
  );
}

function walkStateNodes(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')).walkState.nodes;
}
function planIds(): string[] {
  return JSON.parse(readFileSync(join(projectDir, 'plans/characters_plan.json'), 'utf8')).characters.map((c: { id: string }) => c.id);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'bottom-up-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('writeNodeContent guards', () => {
  it('refuses a per-item node write with no itemId (concept-car bug)', () => {
    seed(['alpha']);
    const r = writeNodeContent({
      projectDir,
      nodeId: 'character_image',
      content: Buffer.from('PNG2'),
      loadBundleForProject,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/per-item node/i);
    // The junk '.png' path must not have been written.
    expect(existsSync(join(projectDir, 'images/.png'))).toBe(false);
  });

  it('hard-blocks a membership change made through raw write_node_content', () => {
    seed(['alpha', 'beta']);
    const r = writeNodeContent({
      projectDir,
      nodeId: 'characters_plan',
      content: Buffer.from(JSON.stringify({ characters: [char('alpha'), char('beta'), char('gamma')] })),
      confirm: true,
      loadBundleForProject,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/dhee_add_item|dhee_remove_item/);
  });

  it('allows a field edit (same membership) through write_node_content', () => {
    seed(['alpha', 'beta']);
    const r = writeNodeContent({
      projectDir,
      nodeId: 'characters_plan',
      content: Buffer.from(JSON.stringify({ characters: [char('alpha', 'EDITED desc'), char('beta')] })),
      confirm: true,
      loadBundleForProject,
    });
    expect(r.ok).toBe(true);
  });

  it('allows the membership change through the viaPlanItemEdit path', () => {
    seed(['alpha']);
    const r = writeNodeContent({
      projectDir,
      nodeId: 'characters_plan',
      content: Buffer.from(JSON.stringify({ characters: [char('alpha'), char('beta')] })),
      viaPlanItemEdit: true,
      confirm: true,
      loadBundleForProject,
    });
    expect(r.ok).toBe(true);
  });
});

describe('item-aware invalidation', () => {
  it('adding an item preserves sibling instances + their files', () => {
    seed(['alpha', 'beta']);
    const r = applyPlanItemEdit({ projectDir, nodeId: 'characters_plan', op: 'add', item: char('gamma'), loadBundleForProject });
    expect(r.ok).toBe(true);
    expect(planIds().sort()).toEqual(['alpha', 'beta', 'gamma']);
    // Siblings untouched: walkState entries + files survive.
    const ns = walkStateNodes();
    expect(ns['character_image:alpha']).toBeTruthy();
    expect(ns['character_image:beta']).toBeTruthy();
    expect(existsSync(join(projectDir, 'images/alpha.png'))).toBe(true);
    expect(existsSync(join(projectDir, 'images/beta.png'))).toBe(true);
  });

  it('removing an item clears ONLY that item’s downstream', () => {
    seed(['alpha', 'beta']);
    const r = applyPlanItemEdit({ projectDir, nodeId: 'characters_plan', op: 'remove', itemId: 'beta', loadBundleForProject });
    expect(r.ok).toBe(true);
    expect(planIds()).toEqual(['alpha']);
    const ns = walkStateNodes();
    // beta's downstream cleared from walkState…
    expect(ns['character_image:beta']).toBeUndefined();
    expect(ns['character_image_prompt:beta']).toBeUndefined();
    // …alpha preserved (walkState + file).
    expect(ns['character_image:alpha']).toBeTruthy();
    expect(existsSync(join(projectDir, 'images/alpha.png'))).toBe(true);
  });
});

describe('applyPlanItemEdit validation', () => {
  it('rejects an item that fails the itemSchema', () => {
    seed([]);
    const r = applyPlanItemEdit({ projectDir, nodeId: 'characters_plan', op: 'add', item: { id: 'Bad Id', name: 'x' }, loadBundleForProject });
    expect(r.ok).toBe(false);
  });

  it('rejects a duplicate id', () => {
    seed(['alpha']);
    const r = applyPlanItemEdit({ projectDir, nodeId: 'characters_plan', op: 'add', item: char('alpha'), loadBundleForProject });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/i);
  });

  it('rejects editing a non-agentEditable node', () => {
    seed(['alpha']);
    const r = applyPlanItemEdit({ projectDir, nodeId: 'character_image', op: 'remove', itemId: 'alpha', loadBundleForProject });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not agent-editable/i);
  });

  it('removing a non-existent item errors', () => {
    seed(['alpha']);
    const r = applyPlanItemEdit({ projectDir, nodeId: 'characters_plan', op: 'remove', itemId: 'ghost', loadBundleForProject });
    expect(r.ok).toBe(false);
  });
});
