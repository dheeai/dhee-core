/**
 * Pure helper: turn a shot_image_prompt JSON into the precise dep
 * list this shot actually consumes.
 *
 * Today the bundle declares scope='all' for shot_image's
 * character_image / setting_image inputs (the walker exposes every
 * item as a map). The runner then reads the prompt JSON's
 * `references[]` and picks only the items keyed by (id, type). The
 * walker, NOT knowing what the runner picked, stamps EVERY item as
 * a dependency on node.completed — giving the projection a wildly
 * over-broad blast-radius (hovering Kiyoko highlights every shot,
 * even ones where she doesn't appear).
 *
 * This helper extracts the ACTUAL dependency set. The runner returns
 * it as `metadata.dependencies`; the walker prefers it over its own
 * over-counted set.
 */

export interface ShotPromptShape {
  imagePrompt?: string;
  references?: Array<{ id?: string; type?: string }>;
  aspectRatio?: string;
}

export interface ShotReferenceInput {
  /** The shot's itemId (e.g. 'scene_1_shot_3'). Always recorded as the
   *  shot_image_prompt input dep. */
  promptItemId: string;
  prompt: ShotPromptShape | null;
}

export interface NodeDependency {
  nodeId: string;
  itemId?: string;
  role?: 'input' | 'context' | 'reference' | 'aggregate';
}

const TYPE_TO_NODE: Record<string, string> = {
  character: 'character_image',
  setting: 'setting_image',
};

export function extractShotReferences(opts: ShotReferenceInput): NodeDependency[] {
  const out: NodeDependency[] = [
    { nodeId: 'shot_image_prompt', itemId: opts.promptItemId, role: 'input' },
  ];
  const refs = opts.prompt?.references;
  if (!Array.isArray(refs)) return out;
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const id = typeof ref.id === 'string' ? ref.id.trim() : '';
    const type = typeof ref.type === 'string' ? ref.type.trim() : '';
    if (!id || !type) continue;
    const upstreamNode = TYPE_TO_NODE[type];
    if (!upstreamNode) continue;
    const key = `${upstreamNode}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ nodeId: upstreamNode, itemId: id, role: 'reference' });
  }
  return out;
}
