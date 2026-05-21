/**
 * Helpers for deciding when a scene-level collection node should be fanned
 * out into per-shot children.
 *
 * History: persisted graph state could end up with `isCollection: false` on a
 * scene-scoped parent (e.g. `shot_motion_directive:scene_1`) even though the
 * template defines the type as a collection. The expansion pass in
 * ExecutorAgent used to gate on the stored flag and so silently skipped
 * these nodes, producing one scene-wide motion prompt that got reused across
 * every shot. Treat the template as authoritative.
 */
import type { ArtifactTypeDefinition, VideoTemplate } from '../templates/types.js';
import type { ExecutionNode } from './types.js';

export const SHOT_EXPANDABLE_TYPE_IDS = [
  'shot_breakdown',
  'shot_image_prompt',
  'shot_motion_directive',
  'shot_image',
  'shot_video',
] as const;

export function isShotExpandableType(typeId: string): boolean {
  return (SHOT_EXPANDABLE_TYPE_IDS as readonly string[]).includes(typeId);
}

/**
 * Returns true for a node that represents a scene-scoped collection parent
 * for one of the shot_* types (itemId looks like `scene_N`, template marks
 * the type as a collection). The stored `node.isCollection` is ignored so
 * that stale saved state cannot block re-expansion.
 */
export function shouldExpandSceneCollectionToShots(
  node: ExecutionNode,
  template: Pick<VideoTemplate, 'artifactTypes'>,
): boolean {
  if (!node.itemId) return false;
  if (!isShotExpandableType(node.typeId)) return false;
  const typeDef = template.artifactTypes[node.typeId] as ArtifactTypeDefinition | undefined;
  if (!typeDef?.isCollection) return false;
  // Scene-scoped parent: itemId is `scene_N`, not `scene_N_shot_M`.
  if (/_shot_\d+/.test(node.itemId)) return false;
  return true;
}
