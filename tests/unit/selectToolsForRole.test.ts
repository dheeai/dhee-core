import { describe, it, expect } from 'vitest';
import { selectToolsForRole } from '../../src/agent/pi/selectToolsForRole.js';

const fixtureTools = [
  { name: 'dhee_status' },
  { name: 'dhee_list_items' },
  { name: 'dhee_run_to' },
  { name: 'dhee_render_scene_bundle' },
  { name: 'dhee_audit_fidelity' },
  { name: 'dhee_regen' },
  { name: 'dhee_read_artifact' },
  { name: 'dhee_show_shot' },
];

// Pass-through pin: until the background task runner lands, every
// session sees every tool. Stripping long tools per-role broke the
// user's natural-language workflow ("regen shot 1", "rerun the shot
// images stage", etc.) because those are also dhee_run_to /
// dhee_regen calls — just not full-pipeline ones. The role type
// is retained for the upcoming dispatch-tool refactor; this helper
// is a no-op for now.

describe('selectToolsForRole', () => {
  it("returns the full tool list for 'interactive' (no stripping)", () => {
    const result = selectToolsForRole(fixtureTools, 'interactive');
    expect(result.map((t) => t.name)).toEqual(fixtureTools.map((t) => t.name));
  });

  it("returns the full tool list for 'background'", () => {
    const result = selectToolsForRole(fixtureTools, 'background');
    expect(result.map((t) => t.name)).toEqual(fixtureTools.map((t) => t.name));
  });

  it('returns the full tool list when role is undefined', () => {
    const result = selectToolsForRole(fixtureTools, undefined);
    expect(result.map((t) => t.name)).toEqual(fixtureTools.map((t) => t.name));
  });

  it('returns a fresh array (does not leak the input)', () => {
    const input: { name: string }[] = [{ name: 'dhee_status' }];
    const out = selectToolsForRole(input, 'background');
    expect(out).not.toBe(input);
    out.push({ name: 'sneaky_mutation' });
    expect(input.length).toBe(1);
  });

  it('tolerates an empty tool list', () => {
    expect(selectToolsForRole([], 'interactive')).toEqual([]);
    expect(selectToolsForRole([], 'background')).toEqual([]);
  });
});
