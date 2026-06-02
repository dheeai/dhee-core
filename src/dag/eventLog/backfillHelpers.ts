/**
 * Pure helpers extracted from scripts/backfillEvents.ts so they can
 * be unit-tested without spinning up a bundle / project on disk.
 *
 * Two responsibilities:
 *   1. `deriveDeps` — given a bundle's input declarations + the set
 *      of completed instances per bundle node + an optional
 *      content-aware reference map, return the dependency edges that
 *      should be stamped on a `node.completed` event.
 *   2. `extractRefs` — parse a shot-prompt JSON file's content and
 *      pull out the (id, type) references. Supports both shapes the
 *      narrative bundles emit:
 *        - flat: `references: [{ id, type }]`
 *        - nested: `frames.<frame>.references: [{ refId, type }]`
 *          where refId is `<stageId>:<itemId>`.
 *   3. `synthesizeMissingPromptEntries` — for legacy projects where
 *      `character_image_prompt` / `setting_image_prompt` /
 *      `shot_image_last_frame_prompt` don't exist (the legacy
 *      executor did the prompt LLM call inline as part of the image
 *      stage), mint synthetic entries so the bundle's matching-scope
 *      edges connect upstream → image cleanly in the dep graph.
 */
import type { DagBundle } from '../schema.js';
import type { NodeDependency } from './events.js';

export interface InstanceEntry {
  itemId: string | undefined;
  outputPath?: string;
  /** Marks entries added by synthesizeMissingPromptEntries. */
  synthetic?: boolean;
}

export interface ContentRef {
  id: string;
  type: string;
}

export type ReferenceMap = Map<string, ContentRef[]>;
export type EntriesByBundleNode = Map<string, InstanceEntry[]>;

// ── deriveDeps ────────────────────────────────────────────────────────

/**
 * For one downstream instance, walk the bundle's
 * `nodes[downstream].inputs[]` and emit one or more `NodeDependency`
 * entries per declared input, according to scope:
 *
 *   - stage upstream → 1 dep (single instance)
 *   - scope: 'matching' → 1 dep if same-itemId upstream exists
 *   - scope: 'previousN' → up to N priors by `_shot_N` itemId order
 *   - scope: 'all' / default → 1 dep per upstream instance, narrowed
 *     by content-aware refs when provided for `character_image` /
 *     `setting_image` style upstreams
 */
export function deriveDeps(
  bundle: DagBundle,
  downstreamNodeId: string,
  downstreamItemId: string | undefined,
  entriesByBundleNode: EntriesByBundleNode,
  referenceMap: ReferenceMap = new Map(),
): NodeDependency[] {
  const node = bundle.nodes.find((n) => n.id === downstreamNodeId);
  if (!node) return [];
  const deps: NodeDependency[] = [];
  for (const inp of node.inputs ?? []) {
    const upstream = bundle.nodes.find((n) => n.id === inp.from);
    if (!upstream) continue;
    const upInstances = entriesByBundleNode.get(inp.from) ?? [];
    if (upInstances.length === 0) continue;
    const scope = (inp.scope ?? 'any') as 'matching' | 'all' | 'previousN' | 'any';
    const role = inp.usage as NodeDependency['role'];

    if (upstream.kind === 'stage') {
      deps.push({ nodeId: inp.from, ...(role ? { role } : {}) });
      continue;
    }

    if (scope === 'matching') {
      const match = upInstances.find((u) => u.itemId === downstreamItemId);
      if (match) {
        deps.push({
          nodeId: inp.from,
          ...(match.itemId !== undefined ? { itemId: match.itemId } : {}),
          ...(role ? { role } : {}),
        });
      }
      continue;
    }

    if (scope === 'previousN') {
      const n = (inp as { n?: number }).n ?? 5;
      const dnShot = parseShotNumber(downstreamItemId);
      if (dnShot === undefined) continue;
      const priors = upInstances
        .map((u) => ({ itemId: u.itemId, shot: parseShotNumber(u.itemId) }))
        .filter((u) => u.shot !== undefined && u.shot < dnShot)
        .sort((a, b) => b.shot! - a.shot!)
        .slice(0, n);
      for (const p of priors) {
        deps.push({
          nodeId: inp.from,
          ...(p.itemId !== undefined ? { itemId: p.itemId } : {}),
          ...(role ? { role } : {}),
        });
      }
      continue;
    }

    // scope='all' / default — narrow via referenceMap if available
    const downstreamKey = downstreamItemId ? `${downstreamNodeId}:${downstreamItemId}` : downstreamNodeId;
    const refs = referenceMap.get(downstreamKey);
    let chosen = upInstances;
    if (refs && refs.length > 0) {
      const expectedType = inp.from.includes('character')
        ? 'character'
        : inp.from.includes('setting')
          ? 'setting'
          : null;
      if (expectedType) {
        const allowed = new Set(refs.filter((r) => r.type === expectedType).map((r) => r.id));
        if (allowed.size > 0) chosen = upInstances.filter((u) => u.itemId !== undefined && allowed.has(u.itemId));
      }
    }
    for (const u of chosen) {
      deps.push({
        nodeId: inp.from,
        ...(u.itemId !== undefined ? { itemId: u.itemId } : {}),
        ...(role ? { role } : {}),
      });
    }
  }
  return deps;
}

function parseShotNumber(id: string | undefined): number | undefined {
  if (!id) return undefined;
  const m = id.match(/(?:^|_)shot_(\d+)$/);
  return m ? parseInt(m[1]!, 10) : undefined;
}

// ── extractRefs ───────────────────────────────────────────────────────

/**
 * Pull (id, type) references out of a shot-prompt JSON. Returns [] if
 * no references can be found. Format-tolerant:
 *
 *   - top-level `references: [{ id, type }]`
 *   - top-level `references: [{ refId: 'character_image:lara', type }]`
 *   - nested `frames.<key>.references: [...]` (any frame key)
 *
 * refId encoding: `<upstreamStageId>:<itemId>`. The id pulled out is
 * the itemId portion; type is inferred from the stage prefix when
 * not explicitly declared.
 */
export function extractRefs(json: unknown): ContentRef[] {
  if (!json || typeof json !== 'object') return [];
  const j = json as Record<string, unknown>;
  const out: ContentRef[] = [];
  collectRefArray(j['references'], out);
  const frames = j['frames'] as Record<string, unknown> | undefined;
  if (frames) {
    for (const frameKey of Object.keys(frames)) {
      const frame = frames[frameKey] as Record<string, unknown> | undefined;
      if (frame) collectRefArray(frame['references'], out);
    }
  }
  return out;
}

function collectRefArray(arr: unknown, out: ContentRef[]): void {
  if (!Array.isArray(arr)) return;
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec['id'] === 'string' && typeof rec['type'] === 'string') {
      out.push({ id: rec['id'] as string, type: rec['type'] as string });
      continue;
    }
    if (typeof rec['refId'] === 'string') {
      const refId = rec['refId'] as string;
      const colon = refId.indexOf(':');
      const stageId = colon > -1 ? refId.slice(0, colon) : refId;
      const itemId = colon > -1 ? refId.slice(colon + 1) : '';
      const declaredType = typeof rec['type'] === 'string' ? (rec['type'] as string) : '';
      const type =
        declaredType ||
        (stageId.includes('character') ? 'character' : stageId.includes('setting') ? 'setting' : 'unknown');
      if (itemId) out.push({ id: itemId, type });
    }
  }
}

// ── synthesizeMissingPromptEntries ────────────────────────────────────

/**
 * For each (image, prompt) pair, if the bundle has the prompt-tier
 * node but the entries map doesn't, mint a synthetic prompt entry
 * for every image-tier entry. itemId carries over so matching-scope
 * deps wire correctly. Mutates the passed map.
 */
export function synthesizeMissingPromptEntries(
  bundle: DagBundle,
  entriesByBundleNode: EntriesByBundleNode,
  pairs: Array<{ image: string; prompt: string }> = [
    { image: 'character_image', prompt: 'character_image_prompt' },
    { image: 'setting_image', prompt: 'setting_image_prompt' },
    { image: 'shot_image_last_frame', prompt: 'shot_image_last_frame_prompt' },
  ],
): number {
  const bundleNodeIds = new Set(bundle.nodes.map((n) => n.id));
  let added = 0;
  for (const { image, prompt } of pairs) {
    if (!bundleNodeIds.has(prompt)) continue;
    const imageEntries = entriesByBundleNode.get(image) ?? [];
    const promptEntries = entriesByBundleNode.get(prompt) ?? [];
    const existing = new Set(promptEntries.map((e) => e.itemId));
    for (const ie of imageEntries) {
      if (existing.has(ie.itemId)) continue;
      promptEntries.push({ itemId: ie.itemId, synthetic: true });
      added += 1;
    }
    if (promptEntries.length > 0) entriesByBundleNode.set(prompt, promptEntries);
  }
  return added;
}
