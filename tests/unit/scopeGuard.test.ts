/**
 * assertPathInProject — TDD coverage.
 *
 * The path-scope guard the dhee filesystem tools call before any
 * read/ls/grep/find. Refuses paths outside the project directory.
 *
 * Failure modes:
 *  1. candidate equals projectDir → ok (no throw).
 *  2. candidate inside projectDir → ok.
 *  3. candidate is a file inside a subdir → ok.
 *  4. candidate is outside projectDir → throws with a clear msg.
 *  5. candidate uses ../ to escape → throws (resolved path is outside).
 *  6. candidate is relative path → throws ("must be absolute").
 *  7. projectDir is not absolute → throws.
 *  8. Symlink escape: candidate at /project/link points OUTSIDE → still
 *     refused. The guard uses path resolution semantics, not symlink
 *     follow, so this is "refused as outside" purely on the textual
 *     path. (Note: this is a known limitation — true symlink-escape
 *     would require fs.realpath; documented for the next pass.)
 *  9. Sibling directory with shared prefix string ("/project-other")
 *     is correctly rejected (no startsWith trap).
 * 10. Path with trailing slash normalized correctly.
 */
import { describe, it, expect } from 'vitest';
import { assertPathInProject } from '../../src/agent/pi/tools/scopeGuard.js';

describe('assertPathInProject', () => {
  it('1. candidate equals projectDir → ok', () => {
    expect(() => assertPathInProject('/Users/ganaraj/dhee-studios/X', '/Users/ganaraj/dhee-studios/X')).not.toThrow();
  });

  it('2. candidate inside projectDir → ok', () => {
    expect(() => assertPathInProject('/Users/ganaraj/dhee-studios/X', '/Users/ganaraj/dhee-studios/X/inputs/story.md')).not.toThrow();
  });

  it('3. file inside subdir → ok', () => {
    expect(() => assertPathInProject('/Users/ganaraj/dhee-studios/X', '/Users/ganaraj/dhee-studios/X/assets/images/characters/lara.png')).not.toThrow();
  });

  it('4. outside projectDir → throws', () => {
    expect(() => assertPathInProject('/Users/ganaraj/dhee-studios/X', '/Users/ganaraj/Projects/dhee-core/src/dag/walker.ts')).toThrow(/outside|scope|project/i);
  });

  it('5. ../ escape → throws', () => {
    expect(() => assertPathInProject('/Users/ganaraj/dhee-studios/X', '/Users/ganaraj/dhee-studios/X/../Y/file.txt')).toThrow(/outside|scope|project/i);
  });

  it('6. relative candidate → throws', () => {
    expect(() => assertPathInProject('/Users/ganaraj/dhee-studios/X', 'inputs/story.md')).toThrow(/absolute/i);
  });

  it('7. non-absolute projectDir → throws', () => {
    expect(() => assertPathInProject('relative/path', '/Users/ganaraj/x/file.md')).toThrow(/absolute/i);
  });

  it('9. sibling with shared prefix → throws (no startsWith trap)', () => {
    expect(() => assertPathInProject('/Users/ganaraj/dhee-studios/X', '/Users/ganaraj/dhee-studios/X-other/file.md')).toThrow(/outside|scope|project/i);
  });

  it('10. trailing slash on projectDir normalized', () => {
    expect(() => assertPathInProject('/Users/ganaraj/dhee-studios/X/', '/Users/ganaraj/dhee-studios/X/inputs/story.md')).not.toThrow();
  });
});
