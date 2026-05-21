/**
 * TDD tests for the empty-content guard. Failure modes (the real
 * things LLMs return that should be REJECTED before reaching disk):
 *
 *   FM1.  Literal empty string `""` → isEmpty=true, rawLength=0.
 *         The 2026-05-19 Soft Seinen scene_2_shot_2 incident — when
 *         a reasoning-model used all its budget on internal reasoning
 *         and emitted no visible content.
 *
 *   FM2.  Single space `" "` → isEmpty=true, rawLength=1.
 *         Trim catches this.
 *
 *   FM3.  Single newline `"\n"` → isEmpty=true. Same as above —
 *         observed when a chat completion returns just the leading
 *         newline before a streaming abort.
 *
 *   FM4.  Whitespace soup `"   \n\n\t  \n"` → isEmpty=true.
 *         Belt-and-suspenders.
 *
 *   FM5.  Real text `"Camera pushes in slowly."` → isEmpty=false.
 *         The happy path — must NOT trip the guard.
 *
 *   FM6.  Real text with leading/trailing whitespace
 *         `"\n  Real content.  \n"` → isEmpty=false. The LLM's
 *         own newlines around output are common; we strip them in
 *         the trim check but the content itself is substantive.
 *
 *   FM7.  Empty JSON object string `"{}"` → isEmpty=false.
 *         The guard is dumber than JSON parsers on purpose — it only
 *         catches "nothing was returned". Whether `{}` is a valid
 *         payload for a given node type is the JSON validator's
 *         responsibility, not this guard's.
 *
 *   FM8.  Empty array string `"[]"` → isEmpty=false. Same reasoning.
 *
 *   FM9.  Single non-whitespace character `"."` → isEmpty=false.
 *         Whatever's there might be garbage, but it's not nothing —
 *         downstream validation (JSON / schema / business rules) can
 *         decide whether to accept it.
 *
 * Failure-reason builder tests:
 *
 *   RM1. rawLength=0 → message says "empty response (0 chars)".
 *   RM2. rawLength>0 but trimmed=0 → message says "only whitespace"
 *        + both lengths.
 *   RM3. The message mentions the nodeId verbatim so executor.log is
 *        grep-friendly.
 *   RM4. The message tells the user how to recover ("invalidate this
 *        node and re-run").
 */
import { describe, expect, it } from 'vitest';
import {
  buildEmptyContentFailureReason,
  checkEmptyContent,
} from '../../src/core/planner/checkEmptyContent.js';

describe('checkEmptyContent', () => {
  it('FM1: literal empty string → isEmpty=true, rawLength=0', () => {
    const r = checkEmptyContent('');
    expect(r.isEmpty).toBe(true);
    expect(r.rawLength).toBe(0);
    expect(r.trimmedLength).toBe(0);
  });

  it('FM2: single space → isEmpty=true', () => {
    const r = checkEmptyContent(' ');
    expect(r.isEmpty).toBe(true);
    expect(r.rawLength).toBe(1);
    expect(r.trimmedLength).toBe(0);
  });

  it('FM3: single newline → isEmpty=true', () => {
    const r = checkEmptyContent('\n');
    expect(r.isEmpty).toBe(true);
    expect(r.rawLength).toBe(1);
    expect(r.trimmedLength).toBe(0);
  });

  it('FM4: whitespace soup → isEmpty=true', () => {
    const r = checkEmptyContent('   \n\n\t  \n');
    expect(r.isEmpty).toBe(true);
    expect(r.rawLength).toBeGreaterThan(0);
    expect(r.trimmedLength).toBe(0);
  });

  it('FM5: real text → isEmpty=false', () => {
    const r = checkEmptyContent('Camera pushes in slowly.');
    expect(r.isEmpty).toBe(false);
    expect(r.trimmedLength).toBe('Camera pushes in slowly.'.length);
  });

  it('FM6: real text with leading/trailing whitespace → isEmpty=false', () => {
    const r = checkEmptyContent('\n  Real content.  \n');
    expect(r.isEmpty).toBe(false);
    expect(r.trimmedLength).toBe('Real content.'.length);
  });

  it('FM7: empty JSON object string → isEmpty=false (JSON validity is not this guard\'s job)', () => {
    const r = checkEmptyContent('{}');
    expect(r.isEmpty).toBe(false);
    expect(r.trimmedLength).toBe(2);
  });

  it('FM8: empty array string → isEmpty=false', () => {
    const r = checkEmptyContent('[]');
    expect(r.isEmpty).toBe(false);
    expect(r.trimmedLength).toBe(2);
  });

  it('FM9: single non-whitespace character → isEmpty=false', () => {
    const r = checkEmptyContent('.');
    expect(r.isEmpty).toBe(false);
    expect(r.trimmedLength).toBe(1);
  });
});

describe('buildEmptyContentFailureReason', () => {
  it('RM1: rawLength=0 → message says "empty response (0 chars)"', () => {
    const msg = buildEmptyContentFailureReason(
      'shot_motion_directive:scene_2_shot_2',
      { isEmpty: true, rawLength: 0, trimmedLength: 0 },
    );
    expect(msg).toMatch(/empty response.*0 chars/i);
  });

  it('RM2: rawLength>0, trimmed=0 → message says "only whitespace" + both lengths', () => {
    const msg = buildEmptyContentFailureReason(
      'shot_motion_directive:scene_2_shot_2',
      { isEmpty: true, rawLength: 5, trimmedLength: 0 },
    );
    expect(msg).toMatch(/only whitespace/i);
    expect(msg).toContain('5 chars raw');
    expect(msg).toContain('0 after trim');
  });

  it('RM3: message includes the nodeId verbatim (grep-friendly executor.log)', () => {
    const msg = buildEmptyContentFailureReason(
      'shot_motion_directive:scene_2_shot_2',
      { isEmpty: true, rawLength: 0, trimmedLength: 0 },
    );
    expect(msg).toContain('shot_motion_directive:scene_2_shot_2');
  });

  it('RM4: message tells the user how to recover (invalidate + re-run)', () => {
    const msg = buildEmptyContentFailureReason(
      'world_style:bharata',
      { isEmpty: true, rawLength: 0, trimmedLength: 0 },
    );
    expect(msg).toMatch(/invalidate.*re-?run/i);
  });
});
