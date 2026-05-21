/**
 * Tests for `buildOutputContractBlock` — the hard post-anchor we splice
 * onto the Stage A / Stage B LLM user prompts to keep the model from
 * pulling example characters out of the loaded skill guides.
 *
 * Pinning the contract's contents here (and its no-op for other node
 * types) so a future refactor doesn't silently drop the directive.
 */
import { describe, expect, it } from 'vitest';
import { buildOutputContractBlock } from '../../src/core/planner/buildOutputContractBlock.js';

describe('buildOutputContractBlock', () => {
  it('emits the contract for scene_shot_plan (Stage A)', () => {
    const block = buildOutputContractBlock('scene_shot_plan');
    expect(block).toContain('<output_contract>');
    expect(block).toContain('</output_contract>');
    // The directive's load-bearing claim: only the scene script + available_refs are sources.
    expect(block).toMatch(/explicitly named in the scene script above/);
    expect(block).toMatch(/matching refId in <available_refs>/);
    // The escape hatch: prose, never invented refIds.
    expect(block).toMatch(/describe it in prose/);
    // The "ignore the guide examples" framing — without this the model
    // happily borrows names from the demonstration content.
    expect(block).toMatch(/Examples, demonstration tables, and placeholder tokens/);
  });

  it('emits the contract for shot_breakdown (Stage B)', () => {
    const block = buildOutputContractBlock('shot_breakdown');
    expect(block).toContain('<output_contract>');
    expect(block).toMatch(/explicitly named in the scene script above/);
  });

  it('is a no-op for node types outside Stage A/B', () => {
    // The contract is specifically about character/setting/object refs
    // being grounded in the scene script. Other node types (e.g.
    // shot_image_prompt — which uses visual references via a different
    // pipeline) shouldn't carry this directive.
    expect(buildOutputContractBlock('shot_image_prompt')).toBe('');
    expect(buildOutputContractBlock('shot_motion_directive')).toBe('');
    expect(buildOutputContractBlock('scene')).toBe('');
    expect(buildOutputContractBlock('plot')).toBe('');
    expect(buildOutputContractBlock('character_image')).toBe('');
    expect(buildOutputContractBlock('')).toBe('');
  });

  it('leads with a double newline so it concatenates cleanly onto upstream blocks', () => {
    // The production prompt builder appends this block verbatim; it
    // must own its own leading whitespace so neighboring blocks don't
    // smush against it.
    expect(buildOutputContractBlock('scene_shot_plan').startsWith('\n\n')).toBe(true);
  });
});
