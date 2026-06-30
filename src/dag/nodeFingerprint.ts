/**
 * Node-definition fingerprinting — fixes dhee-core#171.
 *
 * `dhee run` is "state-as-truth": the walker cache-skips any node whose
 * walkState entry is `completed` and whose output file exists, WITHOUT
 * re-checking the node's definition. So editing a bundle file a node
 * references by path — `promptTemplate`, `outputSchema`, `workflowPath`,
 * `manifestPath`, `scriptPath` — or editing the node's inline `config`
 * in bundle.json had NO effect on resume; you had to wipe the project to
 * pick the edit up.
 *
 * This module computes a content-stable fingerprint of a node's
 * DEFINITION (tool + inline config + the CONTENTS of every referenced
 * bundle file + wiring). The walker stamps it on completion; on the next
 * run a pre-walk sweep recomputes it and, when it differs, invalidates
 * the node and its downstream so only the edited subgraph re-runs — no
 * wipe, all unrelated intermediates preserved.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DagBundle, NodeDef } from './schema.js';
import { computeInputsHash } from './cas/inputsHash.js';
import { loadWalkState } from './walkState.js';

/**
 * Config fields whose string VALUE is a bundle-relative path to a file
 * whose CONTENTS shape the node's output. The path string alone is
 * already in `config`, but editing the file it points at doesn't change
 * the string — so we fold the file's bytes in via `{ kind: 'file' }`
 * markers (content-hashed by computeInputsHash). Keep in sync with the
 * fields runners resolve against `ctx.bundleDir`.
 */
const FILE_CONFIG_FIELDS = [
  'promptTemplate',
  'outputSchema',
  'workflowPath',
  'manifestPath',
  'scriptPath',
] as const;

/**
 * Content-stable hash of a node's DEFINITION. Changing the runner tool,
 * any inline config value, the contents of a referenced bundle file, the
 * input wiring, the output pattern, or the collection fan-out keys all
 * change the fingerprint. Returns a hex string.
 */
export function computeNodeDefFingerprint(node: NodeDef, bundleDir?: string): string {
  const runner = node.runner ?? { tool: '', config: {} };
  const config = (runner.config ?? {}) as Record<string, unknown>;

  // Fold referenced-file CONTENTS in. Only mark a field as a file when
  // it actually exists on disk — computeInputsHash throws on a missing
  // file marker, and a not-yet-created file should fall back to its path
  // string rather than abort the whole sweep.
  const files: Record<string, unknown> = {};
  for (const field of FILE_CONFIG_FIELDS) {
    const val = config[field];
    if (typeof val !== 'string' || val.length === 0) continue;
    const abs = bundleDir ? resolve(bundleDir, val) : val;
    files[field] = bundleDir && existsSync(abs) ? { kind: 'file' as const, path: abs } : val;
  }

  return computeInputsHash({
    tool: typeof runner.tool === 'string' ? runner.tool : '',
    // Bump this if the fingerprint's own shape changes (forces a one-time
    // recompute across all projects rather than silent staleness).
    toolVersion: 'nodedef-v1',
    inputs: {
      config,
      files,
      nodeInputs: node.inputs ?? [],
      outputPattern: node.outputs?.pattern ?? '',
      itemSource: node.itemSource ?? null,
      itemKey: node.itemKey ?? null,
      ...((node as NodeDef & { allowEmptyItems?: boolean }).allowEmptyItems === true
        ? { allowEmptyItems: true }
        : {}),
    },
    config: {},
  });
}

/**
 * Pre-walk staleness sweep. Compares every completed node's stored
 * `defFingerprint` against a freshly-computed one; for each node whose
 * definition changed, invalidates that node AND its transitive
 * downstream (expanding to concrete walkState keys so collection item
 * instances are cleared too — bare-id invalidation alone misses them,
 * cf. #167). Nodes completed before this feature have no stored
 * fingerprint and are left untouched (no spurious invalidation); they
 * pick up a fingerprint the next time they run.
 *
 * Runs once per dispatch, before the walk, so the walk then re-derives
 * exactly the edited subgraph.
 */
export async function invalidateStaleNodeDefinitions(opts: {
  projectDir: string;
  bundle: DagBundle;
  bundleDir?: string;
  log?: (msg: string) => void;
}): Promise<{ stale: string[]; invalidated: string[] }> {
  const log = opts.log ?? (() => {});
  const state = loadWalkState(opts.projectDir);
  if (!state || !state.nodes) return { stale: [], invalidated: [] };

  // Index walkState entries by bare node id.
  const keysByNode = new Map<string, string[]>();
  for (const key of Object.keys(state.nodes)) {
    const bare = key.includes(':') ? key.split(':')[0]! : key;
    const list = keysByNode.get(bare) ?? [];
    list.push(key);
    keysByNode.set(bare, list);
  }

  const stale: string[] = [];
  for (const node of opts.bundle.nodes) {
    const keys = keysByNode.get(node.id);
    if (!keys || keys.length === 0) continue;
    // A node's instances share one definition; find a completed instance
    // that carries a stored fingerprint to compare against.
    let stored: string | undefined;
    let sawCompleted = false;
    for (const k of keys) {
      const entry = state.nodes[k]!;
      if (entry.status === 'completed') {
        sawCompleted = true;
        if (typeof entry.defFingerprint === 'string') {
          stored = entry.defFingerprint;
          break;
        }
      }
    }
    if (!sawCompleted || stored === undefined) continue; // unknown / legacy → don't touch
    const current = computeNodeDefFingerprint(node, opts.bundleDir);
    if (current !== stored) stale.push(node.id);
  }

  if (stale.length === 0) return { stale: [], invalidated: [] };

  // Expand stale ids + their transitive structural downstream to the
  // CONCRETE walkState keys (incl. `nodeId:itemId` collection instances),
  // so invalidation actually clears collection items rather than no-op'ing
  // on a bare id (#167).
  const { invalidateNodes, bundleStructuralDownstream } = await import('./projectRegen.js');
  const closure = new Set<string>(stale);
  for (const d of bundleStructuralDownstream(opts.bundle, stale)) closure.add(d);
  const keysToInvalidate: string[] = [];
  for (const key of Object.keys(state.nodes)) {
    const bare = key.includes(':') ? key.split(':')[0]! : key;
    if (closure.has(bare)) keysToInvalidate.push(key);
  }

  const res = await invalidateNodes({
    projectDir: opts.projectDir,
    nodeIds: keysToInvalidate,
    source: 'stale-node-def',
    bundle: opts.bundle,
  });
  log(
    `walker: edited node definition(s) detected [${stale.join(', ')}] — invalidated ` +
      `${res.invalidated.length} entr(y/ies) incl. downstream; they will re-run (no wipe needed).`,
  );
  return { stale, invalidated: res.invalidated };
}
