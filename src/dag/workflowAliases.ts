/**
 * workflowAliases — per-endpoint persistent store of (a) name aliases
 * for model files and (b) per-workflow per-node class_type swaps.
 *
 * Storage:
 *   <aliasesDir>/<endpoint-slug>/aliases.json
 *
 *   {
 *     "name_aliases": {
 *       "<bundle-canonical-name>": "<user-local-name>"
 *     },
 *     "class_swaps": {
 *       "<workflowKey>": { "<nodeId>": "<NewClassName>" }
 *     }
 *   }
 *
 * The agent's `dhee_apply_workflow_aliases` tool writes here.
 * Runners read here at workflow-load time and apply substitutions
 * in-memory before posting to Comfy. Bundle's canonical workflow
 * stays untouched.
 *
 * Safety guardrail: `applyAliases` ONLY swaps:
 *   - inputs.<*_name> string values (name aliases)
 *   - node.class_type (class swaps, scoped to workflowKey + nodeId)
 *
 * It never adds/removes nodes, reorders, edits non-`*_name` inputs,
 * or touches the graph topology. That's the safety contract the
 * agent's tool surface relies on.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ComfyWorkflow } from './workflowVerify.js';

/**
 * Resolve the per-user workflow-aliases root, consistently across platforms.
 *
 * `DHEE_WORKFLOW_ALIASES_DIR` wins when set (the desktop exports it so the
 * runner reads exactly where the UI wrote). Otherwise fall back to
 * `<home>/.dhee/workflow-aliases` using `os.homedir()` — NOT
 * `process.env.HOME`, which is UNSET on Windows (Windows uses USERPROFILE).
 * The old `process.env['HOME'] ?? ''` fallback resolved to a cwd-relative
 * `.dhee/workflow-aliases` on Windows, so the desktop saved aliases to
 * `C:\Users\<user>\.dhee\workflow-aliases` (via app.getPath('home')) while the
 * runner looked somewhere else and found nothing — model substitutions were
 * silently ignored on Windows. Centralizing here keeps every runner in sync.
 */
export function defaultAliasesDir(): string {
  const env = process.env['DHEE_WORKFLOW_ALIASES_DIR'];
  if (typeof env === 'string' && env.trim().length > 0) return env.trim();
  return join(homedir(), '.dhee', 'workflow-aliases');
}

export interface WorkflowAliases {
  /** Global per-endpoint name→name remappings. */
  name_aliases?: Record<string, string>;
  /** Per-workflow per-node class_type swaps. */
  class_swaps?: Record<string, Record<string, string>>;
}

/**
 * Normalize an endpoint URL to a filesystem-safe directory name.
 * Strips scheme, replaces anything not [a-z0-9] with underscore,
 * collapses repeats, trims edges.
 */
export function endpointSlug(endpoint: string): string {
  return endpoint
    .replace(/^https?:\/\//i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * A local ComfyUI's URL is unstable: a zrok/ngrok tunnel rotates, a LAN
 * box gets a new DHCP IP, localhost vs 127.0.0.1, a Tailscale name vs a
 * raw IP. Keying the alias store by the raw URL slug means every such
 * change silently ORPHANS the user's model substitutions — they'd have
 * to re-pick "use a model I have" after every URL change (the exact
 * complaint that motivated this). So collapse every NON-cloud endpoint
 * to one stable key, `self.local` — the user's own box, regardless of
 * how it's currently addressed. Cloud endpoints stay keyed per-host:
 * distinct cloud accounts/boxes (cloud.comfy.org, the Dhee Cloud
 * `/comfy/api` proxy) have distinct model libraries that must not share
 * a namespace.
 */
function isCloudEndpoint(endpoint: string): boolean {
  return /cloud\.comfy\.org/i.test(endpoint) || /\/comfy\/api(?:\/|$)/i.test(endpoint);
}

/**
 * Stable per-box alias key. Cloud stays per-host; every local box (any
 * non-cloud URL) maps to the canonical `self.local`. Read and write go
 * through here, so they can never drift apart.
 */
export function aliasEndpointKey(endpoint: string): string {
  return isCloudEndpoint(endpoint) ? endpoint : 'self.local';
}

function aliasesPath(aliasesDir: string, endpoint: string): { dir: string; file: string } {
  const dir = join(aliasesDir, endpointSlug(aliasEndpointKey(endpoint)));
  return { dir, file: join(dir, 'aliases.json') };
}

function readAliasesFile(file: string): WorkflowAliases {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as WorkflowAliases;
  } catch {
    return {};
  }
}

/** Merge `over` onto `base` (`over` wins). name_aliases shallow; class_swaps two-level. */
function mergeAliases(base: WorkflowAliases, over: WorkflowAliases): WorkflowAliases {
  const out: WorkflowAliases = {};
  if (base.name_aliases || over.name_aliases) {
    out.name_aliases = { ...(base.name_aliases ?? {}), ...(over.name_aliases ?? {}) };
  }
  if (base.class_swaps || over.class_swaps) {
    const cs: Record<string, Record<string, string>> = { ...(base.class_swaps ?? {}) };
    for (const [wfKey, perNode] of Object.entries(over.class_swaps ?? {})) {
      cs[wfKey] = { ...(cs[wfKey] ?? {}), ...perNode };
    }
    out.class_swaps = cs;
  }
  return out;
}

export function readAliases(aliasesDir: string, endpoint: string): WorkflowAliases {
  const key = aliasEndpointKey(endpoint);
  const slug = endpointSlug(key);
  const primary = readAliasesFile(join(aliasesDir, slug, 'aliases.json'));
  if (key !== 'self.local') return primary;

  // Legacy fold-in: substitutions made BEFORE stable keying live under
  // per-URL slug dirs (e.g. a zrok tunnel, an old LAN IP). They all
  // describe the same physical local box, so merge them under self.local
  // — otherwise the keying upgrade (or any past URL change) would orphan
  // every pick the user already made. self_local (the current key) wins
  // on conflicts; cloud dirs are never folded in (distinct boxes).
  let merged = primary;
  try {
    for (const entry of readdirSync(aliasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === slug) continue;
      if (/cloud_comfy_org/i.test(entry.name)) continue;
      const legacy = readAliasesFile(join(aliasesDir, entry.name, 'aliases.json'));
      merged = mergeAliases(legacy, merged); // primary overrides legacy
    }
  } catch {
    // aliasesDir may not exist yet — nothing to fold in.
  }
  return merged;
}

/**
 * Merge-write: never clobbers keys the caller didn't supply. Lets the
 * agent add one alias at a time without wiping prior ones.
 */
export function writeAliases(
  aliasesDir: string,
  endpoint: string,
  patch: WorkflowAliases,
): void {
  const { dir, file } = aliasesPath(aliasesDir, endpoint);
  mkdirSync(dir, { recursive: true });
  const existing = readAliases(aliasesDir, endpoint);

  const merged: WorkflowAliases = {};
  // name_aliases — shallow merge.
  if (existing.name_aliases || patch.name_aliases) {
    merged.name_aliases = { ...(existing.name_aliases ?? {}), ...(patch.name_aliases ?? {}) };
  }
  // class_swaps — two-level merge (per workflow, per node).
  if (existing.class_swaps || patch.class_swaps) {
    const out: Record<string, Record<string, string>> = { ...(existing.class_swaps ?? {}) };
    for (const [wfKey, perNode] of Object.entries(patch.class_swaps ?? {})) {
      out[wfKey] = { ...(out[wfKey] ?? {}), ...perNode };
    }
    merged.class_swaps = out;
  }

  writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
}

export interface ApplyAliasesOpts {
  /** Stable identifier for this workflow (used to look up class_swaps). */
  workflowKey: string;
  aliases: WorkflowAliases;
  /**
   * Called for each class_swap actually applied (old class → new class).
   * Lets callers log + validate the swaps (see applyEndpointAliases).
   */
  onClassSwap?: (nodeId: string, from: string, to: string) => void;
}

const MODEL_EXTS = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx', '.sft'];

function looksLikeModelFilename(s: string): boolean {
  const lower = s.toLowerCase();
  return MODEL_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Apply name aliases + class swaps to a workflow IN A FRESH COPY.
 * Input is never mutated. The substitution is intentionally narrow:
 * only `inputs.<*_name>` string values get renamed, and only nodes
 * matching `(workflowKey, nodeId)` in class_swaps get reclassed.
 */
export function applyAliases(
  workflow: ComfyWorkflow,
  opts: ApplyAliasesOpts,
): ComfyWorkflow {
  const { workflowKey, aliases } = opts;
  const nameMap = aliases.name_aliases ?? {};
  const classSwapsForThisWorkflow = aliases.class_swaps?.[workflowKey] ?? {};

  // Deep clone via JSON to guarantee no mutation of caller's object.
  // Workflows are small JSON; cost is negligible.
  const out: ComfyWorkflow = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

  for (const [nodeId, node] of Object.entries(out)) {
    if (!node || typeof node !== 'object') continue;

    // class_type swap, scoped to this workflowKey + this nodeId.
    const newClass = classSwapsForThisWorkflow[nodeId];
    if (newClass && newClass !== node.class_type) {
      opts.onClassSwap?.(nodeId, node.class_type ?? '(unknown)', newClass);
      node.class_type = newClass;
    }

    // Name substitutions on *_name string inputs that look like model
    // filenames. Strictly limited to that field-name pattern + string
    // values + extension match — protects against accidentally
    // rewriting integer / boolean / wire-array inputs.
    const inputs = node.inputs;
    if (inputs && typeof inputs === 'object') {
      for (const [field, value] of Object.entries(inputs)) {
        if (!field.endsWith('_name')) continue;
        if (typeof value !== 'string') continue;
        if (!looksLikeModelFilename(value)) continue;
        const newName = nameMap[value];
        if (newName) (inputs as Record<string, unknown>)[field] = newName;
      }
    }
  }

  return out;
}

// ── class_swap validation + the shared apply-aliases-for-a-runner helper ──

export interface ClassSwapProblem {
  nodeId: string;
  from: string;
  to: string;
  issue: 'class-not-on-endpoint' | 'missing-required-inputs';
  /** For 'missing-required-inputs': which required inputs the node lacks. */
  missing?: string[];
}

/**
 * Validate every applied class_swap against the endpoint's node signatures
 * (ComfyUI /object_info). Catches the failure mode where a swap rewrites a
 * node to a class whose REQUIRED inputs the node doesn't provide (e.g.
 * LoraLoaderModelOnly → "Load Lora", which needs `clip`) — which ComfyUI
 * would otherwise reject deep in prompt validation with a cryptic 400.
 * Pure.
 */
export function validateClassSwaps(
  workflow: ComfyWorkflow,
  swaps: Array<{ nodeId: string; from: string; to: string }>,
  objectInfo: Record<string, unknown>,
): ClassSwapProblem[] {
  const problems: ClassSwapProblem[] = [];
  for (const sw of swaps) {
    const node = workflow[sw.nodeId];
    if (!node) continue;
    const classInfo = objectInfo[sw.to] as { input?: { required?: Record<string, unknown> } } | undefined;
    if (!classInfo) {
      problems.push({ nodeId: sw.nodeId, from: sw.from, to: sw.to, issue: 'class-not-on-endpoint' });
      continue;
    }
    const required = Object.keys(classInfo.input?.required ?? {});
    const provided = new Set(Object.keys(node.inputs ?? {}));
    const missing = required.filter((r) => !provided.has(r));
    if (missing.length > 0) {
      problems.push({ nodeId: sw.nodeId, from: sw.from, to: sw.to, issue: 'missing-required-inputs', missing });
    }
  }
  return problems;
}

export interface ApplyEndpointAliasesOpts {
  workflow: ComfyWorkflow;
  workflowKey: string;
  aliasesDir: string;
  /** Resolved endpoint URL (for readAliases keying + /object_info validation). */
  endpointUrl?: string;
  log?: (msg: string) => void;
  /** Injectable for tests; defaults to fetching `<endpoint>/object_info`. */
  fetchObjectInfo?: (endpointUrl: string) => Promise<Record<string, unknown>>;
}

export interface ApplyEndpointAliasesResult {
  workflow: ComfyWorkflow;
  /**
   * Set when an applied class_swap is invalid — the caller should FAIL the
   * run with this message instead of submitting a workflow ComfyUI rejects.
   */
  error?: string;
}

async function defaultFetchObjectInfo(endpointUrl: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${endpointUrl.replace(/\/$/, '')}/object_info`);
  if (!resp.ok) throw new Error(`/object_info returned ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

/**
 * Read + apply the per-endpoint aliases for one runner call, LOGGING each
 * class_swap (so a stale/bad swap is visible) and VALIDATING that each swap
 * leaves the node satisfying its new class's required inputs. Returns the
 * rewritten workflow; sets `error` when a swap is invalid so the runner can
 * fail fast with an actionable message. Loading/applying is best-effort
 * (a malformed/unreadable store never blocks the run); only an invalid
 * class_swap produces an `error`.
 */
export async function applyEndpointAliases(
  opts: ApplyEndpointAliasesOpts,
): Promise<ApplyEndpointAliasesResult> {
  const log = opts.log ?? (() => {});
  let aliases: WorkflowAliases;
  try {
    aliases = readAliases(opts.aliasesDir, opts.endpointUrl ?? 'unknown');
  } catch (e) {
    log(`alias load skipped (${(e as Error).message})`);
    return { workflow: opts.workflow };
  }
  const hasAny =
    (aliases.name_aliases && Object.keys(aliases.name_aliases).length > 0) ||
    (aliases.class_swaps && Object.keys(aliases.class_swaps).length > 0);
  if (!hasAny) return { workflow: opts.workflow };

  const swaps: Array<{ nodeId: string; from: string; to: string }> = [];
  let rewritten: ComfyWorkflow;
  try {
    rewritten = applyAliases(opts.workflow, {
      workflowKey: opts.workflowKey,
      aliases,
      onClassSwap: (nodeId, from, to) => {
        swaps.push({ nodeId, from, to });
        log(`alias class_swap: node ${nodeId} '${from}' → '${to}' (workflow=${opts.workflowKey})`);
      },
    });
  } catch (e) {
    log(`alias apply skipped (${(e as Error).message})`);
    return { workflow: opts.workflow };
  }
  log(`applied aliases for endpoint=${opts.endpointUrl ?? 'unknown'} workflow=${opts.workflowKey}`);

  if (swaps.length === 0 || !opts.endpointUrl) return { workflow: rewritten };

  // Validate the class_swaps against the endpoint's actual node signatures.
  const fetcher = opts.fetchObjectInfo ?? defaultFetchObjectInfo;
  let objectInfo: Record<string, unknown> | undefined;
  try {
    objectInfo = await fetcher(opts.endpointUrl);
  } catch (e) {
    log(`class_swap validation skipped (could not fetch /object_info: ${(e as Error).message})`);
    return { workflow: rewritten };
  }
  const problems = validateClassSwaps(rewritten, swaps, objectInfo);
  if (problems.length === 0) return { workflow: rewritten };

  const lines = problems.map((p) =>
    p.issue === 'class-not-on-endpoint'
      ? `  - node ${p.nodeId}: class_swap '${p.from}' → '${p.to}', but '${p.to}' is NOT installed on this ComfyUI`
      : `  - node ${p.nodeId}: class_swap '${p.from}' → '${p.to}' leaves required input(s) unsatisfied: ${p.missing!.join(', ')}`,
  );
  return {
    workflow: rewritten,
    error:
      `invalid class_swap alias for endpoint ${opts.endpointUrl} (workflow=${opts.workflowKey}):\n` +
      lines.join('\n') +
      `\nThis comes from a persisted alias in the workflow-alias store ` +
      `(~/.dhee/workflow-aliases/<endpoint-slug>/aliases.json). Remove or fix that class_swap.`,
  };
}
