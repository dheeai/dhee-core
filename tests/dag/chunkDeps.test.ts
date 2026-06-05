/**
 * Unit tests for chunk-aware dependency narrowing (src/dag/chunkDeps.ts).
 *
 * These pin the decision a chunked scene_clip instance makes when the
 * walker records its scope='all' shot dependencies: a chunk depends only
 * on the shots inside its own range, so cascade-invalidation doesn't
 * re-roll sibling chunks when an unrelated shot changes.
 */
import { describe, it, expect } from 'vitest';
import { parseShotNumber, depBelongsToChunk } from '../../src/dag/chunkDeps.js';

describe('parseShotNumber', () => {
  it('extracts the shot number from canonical shot ids', () => {
    expect(parseShotNumber('scene_1_shot_3')).toBe(3);
    expect(parseShotNumber('scene_12_shot_7')).toBe(7);
    expect(parseShotNumber('shot_5')).toBe(5);
  });

  it('returns undefined for non-shot ids and empty input', () => {
    expect(parseShotNumber('scene_1_chunk_2')).toBeUndefined();
    expect(parseShotNumber('observatory_interior')).toBeUndefined();
    expect(parseShotNumber('sela')).toBeUndefined();
    expect(parseShotNumber(undefined)).toBeUndefined();
    expect(parseShotNumber('')).toBeUndefined();
  });

  it('does not match a shot-like substring that is not the suffix', () => {
    // 'shot_3_extra' is not a canonical shot id — anchored regex rejects it.
    expect(parseShotNumber('scene_1_shot_3_extra')).toBeUndefined();
  });
});

describe('depBelongsToChunk', () => {
  it('records every dep when the consumer is not a chunk (no shotRange)', () => {
    expect(depBelongsToChunk(undefined, 'scene_1_shot_1')).toBe(true);
    expect(depBelongsToChunk(undefined, 'scene_1_shot_99')).toBe(true);
    expect(depBelongsToChunk(undefined, 'sela')).toBe(true);
  });

  it('records shots inside the chunk range and drops shots outside it', () => {
    // Chunk covering shots 1..4 (e.g. scene_1_chunk_1).
    expect(depBelongsToChunk([1, 4], 'scene_1_shot_1')).toBe(true);
    expect(depBelongsToChunk([1, 4], 'scene_1_shot_4')).toBe(true);
    expect(depBelongsToChunk([1, 4], 'scene_1_shot_5')).toBe(false);
    expect(depBelongsToChunk([1, 4], 'scene_1_shot_6')).toBe(false);

    // The sibling chunk covering shots 5..6 (the one that was wrongly
    // re-rolled when shot 3 changed).
    expect(depBelongsToChunk([5, 6], 'scene_1_shot_3')).toBe(false);
    expect(depBelongsToChunk([5, 6], 'scene_1_shot_5')).toBe(true);
    expect(depBelongsToChunk([5, 6], 'scene_1_shot_6')).toBe(true);
  });

  it('keeps non-shot deps even for a chunked consumer (characters/settings/stages)', () => {
    // A chunk might still legitimately reference cross-collection items
    // by id; those aren't shot-keyed, so they must not be dropped.
    expect(depBelongsToChunk([5, 6], 'observatory_interior')).toBe(true);
    expect(depBelongsToChunk([5, 6], 'sela')).toBe(true);
    expect(depBelongsToChunk([5, 6], undefined)).toBe(true);
  });

  it('is inclusive on both ends of the range', () => {
    expect(depBelongsToChunk([3, 3], 'scene_1_shot_3')).toBe(true);
    expect(depBelongsToChunk([3, 3], 'scene_1_shot_2')).toBe(false);
    expect(depBelongsToChunk([3, 3], 'scene_1_shot_4')).toBe(false);
  });
});
