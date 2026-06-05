/**
 * chunkDeps — chunk-aware dependency narrowing for collection instances
 * that split one scene's shots across multiple chunks (scene_clip via
 * `chunkBy`).
 *
 * The bug this fixes: scene_clip declares `shot_image` and
 * `shot_motion_directive` as `scope: 'all'`, so the walker's generic
 * dep-recording stamps EVERY shot as a dependency of EVERY chunk. The
 * cascade-invalidator (cascadeInvalidationKeys) then treats a single
 * shot edit as invalidating all chunks — e.g. editing shot 3 needlessly
 * re-renders the chunk that only holds shots 5-6. An LTX chunk only
 * truly consumes the shots inside its own `shotRange`.
 *
 * Narrowing the recorded dependency set to the chunk's member shots keeps
 * cascade-invalidation surgical. Consumers that aren't chunks (no
 * shotRange) and dependencies that aren't shot-keyed (characters,
 * settings, stages) record everything, exactly as before.
 *
 * `parseShotNumber` mirrors the shot-id parsing the walker already uses
 * for `scope: 'previousN'` so the two stay consistent.
 */

/** Parse the shot number from a shot itemId like 'scene_1_shot_3' → 3. */
export function parseShotNumber(itemId: string | undefined): number | undefined {
  if (!itemId) return undefined;
  const m = itemId.match(/(?:^|_)shot_(\d+)$/);
  return m ? parseInt(m[1]!, 10) : undefined;
}

/**
 * Should a dependency on `depItemId` be recorded for a consumer instance
 * whose chunk covers `shotRange` (inclusive [start, end] shot numbers)?
 *
 *   - No `shotRange` (the consumer isn't a chunk) → true (record all).
 *   - `depItemId` isn't a shot id (a character / setting / stage dep, or a
 *     bare nodeId) → true (don't drop non-shot deps).
 *   - Otherwise → true iff the shot number falls within the chunk range.
 */
export function depBelongsToChunk(
  shotRange: readonly [number, number] | undefined,
  depItemId: string | undefined,
): boolean {
  if (!shotRange) return true;
  const shot = parseShotNumber(depItemId);
  if (shot === undefined) return true;
  return shot >= shotRange[0] && shot <= shotRange[1];
}
