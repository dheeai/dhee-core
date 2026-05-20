/**
 * Workflow integration helpers — single source of truth for the
 * upload → validate → analyze → save → list/update/delete flow.
 *
 * Both the pi-agent tools (`src/agent/pi/tools/comfyui/*`) and the
 * REST handlers (`src/server/routes.ts`) call these. Keeping the
 * logic here means there's exactly one way to integrate a workflow
 * regardless of how the user got there (chat or HTTP).
 *
 * No Fastify, no HTTP context. Pure functions plus side-effects
 * confined to the user workflows directory and the registry singleton.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { basename, join } from 'path';
import {
  parseWorkflow,
  analyzeWorkflowWithLLM,
  type ParsedWorkflow,
  type WorkflowAnalysis,
} from './WorkflowParser.js';
import {
  getWorkflowModeRegistry,
} from '../providers/WorkflowModeRegistry.js';
import { getUserWorkflowsDir } from '../providers/workflowsRoot.js';
import type { LLMClient } from '../../core/llm/index.js';
import type { WorkflowManifest } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WorkflowIntegrationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'WorkflowIntegrationError';
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Where user-uploaded workflows live. Hosts (dhee-desktop) override
 * via `setUserWorkflowsDir()`; default is `<cwd>/workflows/user/`
 * which works for the CLI / dev environment.
 */
function getUserWorkflowsDirForWrite(): string {
  const hostDir = getUserWorkflowsDir();
  if (hostDir) return hostDir;
  return join(process.cwd(), 'workflows', 'user');
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function safeId(input: string): string {
  return input
    .replace(/\.json$/i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Force the workflow registry to re-scan its directories and rebuild
 * its mode-filtered map. Call this after any process-wide change
 * that affects manifest visibility — most notably a `COMFY_MODE`
 * env-var flip when the host (dhee-desktop) toggles between local
 * and cloud.
 *
 * Without this, `getAllModes()` keeps returning the previous
 * mode-filtered set even though `COMFY_MODE` says otherwise — the
 * filter is applied at refresh time, not at lookup.
 */
export function refreshWorkflowRegistry(): void {
  getWorkflowModeRegistry().refresh();
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export interface ValidateResult {
  ok: true;
  parsed: ParsedWorkflow;
}

export interface ValidateError {
  ok: false;
  reason: string;
}

/**
 * Read a JSON file from disk and confirm it parses as a ComfyUI
 * workflow. Returns either the parsed shape or a human-readable
 * reason it isn't ComfyUI.
 *
 * Cheap: just JSON.parse + structural sniff. No LLM, no I/O beyond
 * one read.
 */
export function validateWorkflowFile(
  workflowPath: string,
): ValidateResult | ValidateError {
  if (!existsSync(workflowPath)) {
    return { ok: false, reason: `File not found: ${workflowPath}` };
  }

  let content: string;
  try {
    content = readFileSync(workflowPath, 'utf-8');
  } catch (err) {
    return { ok: false, reason: `Could not read file: ${(err as Error).message}` };
  }

  let parsed: ParsedWorkflow;
  try {
    parsed = parseWorkflow(content);
  } catch (err) {
    return {
      ok: false,
      reason:
        `Not a valid ComfyUI workflow: ${(err as Error).message}. ` +
        `Expected either LiteGraph format (with a "nodes" array) or API format (a flat object of nodes with class_type fields).`,
    };
  }

  if (parsed.totalNodes === 0) {
    return { ok: false, reason: 'Workflow has zero nodes — likely not a real ComfyUI workflow.' };
  }

  return { ok: true, parsed };
}

// ---------------------------------------------------------------------------
// Analyze (LLM-assisted)
// ---------------------------------------------------------------------------

export interface AnalyzeResult {
  parsed: ParsedWorkflow;
  /** Null if the LLM call failed; caller falls back to heuristic mappings on `parsed`. */
  analysis: WorkflowAnalysis | null;
  /** True if LLM analysis was attempted and failed (vs. not attempted at all). */
  llmFailed: boolean;
  llmError?: string;
}

/**
 * Validate + LLM-analyze a workflow file. The LLM proposes a display
 * name, pipeline, parameter mappings, and LoRA keywords. If the LLM
 * call fails (no API key, offline, rate-limited), `analysis` is null
 * and `llmFailed` is true — the caller can fall back to manual
 * mapping using `parsed.inputNodes`.
 */
export async function analyzeWorkflowFile(
  workflowPath: string,
  llm: LLMClient,
): Promise<AnalyzeResult> {
  const validated = validateWorkflowFile(workflowPath);
  if (!validated.ok) {
    throw new WorkflowIntegrationError(validated.reason, 'INVALID_WORKFLOW');
  }

  const content = readFileSync(workflowPath, 'utf-8');

  try {
    const analysis = await analyzeWorkflowWithLLM(content, validated.parsed, llm);

    // Merge LLM suggestions back into parsed nodes so callers see one shape
    if (analysis.suggestedMappings) {
      for (const suggestion of analysis.suggestedMappings) {
        const node = validated.parsed.inputNodes.find(n => n.nodeId === suggestion.nodeId);
        if (node) node.suggestedInput = suggestion.suggestedInput;
      }
    }
    if (analysis.pipeline && validated.parsed.detectedPipeline === 'unknown') {
      validated.parsed.detectedPipeline = analysis.pipeline as ParsedWorkflow['detectedPipeline'];
    }

    return { parsed: validated.parsed, analysis, llmFailed: false };
  } catch (err) {
    return {
      parsed: validated.parsed,
      analysis: null,
      llmFailed: true,
      llmError: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export interface SaveWorkflowOptions {
  /** Path to the source ComfyUI workflow JSON to copy in. */
  sourcePath: string;
  /** The manifest to persist. `id` and `workflowFile` get normalized. */
  manifest: WorkflowManifest;
  /** If a manifest with the same id exists: 'overwrite' replaces, 'rename' appends a timestamp suffix to the new id, 'fail' throws. */
  onConflict?: 'overwrite' | 'rename' | 'fail';
}

export interface SaveWorkflowResult {
  finalId: string;
  manifestPath: string;
  workflowPath: string;
}

/**
 * Persist a workflow JSON + manifest under the user workflows
 * directory and refresh the registry so the new mode is available
 * immediately.
 */
export function saveWorkflow(opts: SaveWorkflowOptions): SaveWorkflowResult {
  const { sourcePath, manifest } = opts;
  const onConflict = opts.onConflict ?? 'fail';

  if (!existsSync(sourcePath)) {
    throw new WorkflowIntegrationError(
      `Source workflow file not found: ${sourcePath}`,
      'SOURCE_NOT_FOUND',
    );
  }

  const userDir = getUserWorkflowsDirForWrite();
  ensureDir(userDir);

  let finalId = safeId(manifest.id || basename(sourcePath));
  if (!finalId) {
    throw new WorkflowIntegrationError(
      'Manifest id is empty after sanitization. Provide an id with letters/digits.',
      'INVALID_ID',
    );
  }

  const manifestPath = (id: string) => join(userDir, `${id}.manifest.json`);
  const workflowPath = (id: string) => join(userDir, `${id}.json`);

  // Reject collisions with built-ins outright — user uploads can't
  // shadow shipped workflows by id.
  const registry = getWorkflowModeRegistry();
  if (registry.isBuiltInId(finalId)) {
    throw new WorkflowIntegrationError(
      `'${finalId}' is a built-in workflow id and cannot be overwritten. Pick a different id.`,
      'BUILTIN_COLLISION',
    );
  }

  // User-vs-user collision: honor onConflict policy
  if (existsSync(manifestPath(finalId))) {
    if (onConflict === 'fail') {
      throw new WorkflowIntegrationError(
        `A workflow named '${finalId}' already exists. Choose a different id, or pass onConflict='overwrite'/'rename'.`,
        'ID_EXISTS',
      );
    }
    if (onConflict === 'rename') {
      finalId = `${finalId}_${Date.now().toString(36)}`;
    }
    // 'overwrite' falls through and replaces
  }

  // Normalize the manifest before persisting.
  //
  // `mode` is forced to 'local' on every save: user-uploaded
  // workflows reference custom nodes / model files that exist on
  // the user's own ComfyUI install. Cloud ComfyUI is a managed
  // service with a fixed node set — submitting an arbitrary user
  // workflow there would fail. The registry's mode-filter then
  // hides these from the cloud view entirely.
  const normalized: WorkflowManifest = {
    ...manifest,
    id: finalId,
    workflowFile: `${finalId}.json`,
    builtIn: false,
    mode: 'local',
  };

  // Copy the workflow JSON in, then write the manifest. Order
  // matters: refresh() will only register the manifest if its
  // workflowFile exists on disk.
  copyFileSync(sourcePath, workflowPath(finalId));
  writeFileSync(manifestPath(finalId), JSON.stringify(normalized, null, 2));

  // Pick up the new entry without restart
  registry.refresh();

  return {
    finalId,
    manifestPath: manifestPath(finalId),
    workflowPath: workflowPath(finalId),
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface WorkflowSummary {
  id: string;
  displayName: string;
  pipeline: string;
  builtIn: boolean;
  isOverride: boolean;
  active: boolean;
}

/**
 * Scan the user workflows directory directly for manifests, bypassing
 * the registry's mode filter. Used so the Settings UI can always
 * show what the user has installed even when they're in cloud mode
 * (where local-only user manifests are hidden from the routing
 * registry — but the user still wants to see them with an
 * "inactive" indicator).
 */
function listUserWorkflowsRaw(): WorkflowSummary[] {
  const userDir = getUserWorkflowsDirForWrite();
  if (!existsSync(userDir)) return [];
  const out: WorkflowSummary[] = [];
  let entries: string[];
  try {
    entries = readdirSync(userDir);
  } catch {
    return [];
  }
  for (const file of entries) {
    if (!file.endsWith('.manifest.json')) continue;
    try {
      const content = readFileSync(join(userDir, file), 'utf-8');
      const parsed = JSON.parse(content);
      const manifests = Array.isArray(parsed) ? parsed : [parsed];
      for (const m of manifests) {
        if (!m?.id) continue;
        out.push({
          id: m.id,
          displayName: m.displayName ?? m.id,
          pipeline: m.pipeline ?? 'unknown',
          builtIn: false,
          isOverride: m.isOverride === true,
          // True for now — overridden below if the registry doesn't
          // have this id (i.e. mode-filter hid it).
          active: m.active !== false,
        });
      }
    } catch {
      // Skip unparseable / partial manifest files; the registry's
      // refresh() will warn separately.
    }
  }
  return out;
}

/**
 * List all workflows known to the registry (built-ins + user uploads).
 * Optionally filter to user uploads only.
 *
 * User uploads are merged from a direct disk scan so they show up
 * even when the registry's COMFY_MODE filter would hide them. Hidden
 * uploads are marked `active: false` so the UI can show an
 * "inactive — current mode doesn't use this" badge.
 */
export function listWorkflows(opts?: { userOnly?: boolean }): WorkflowSummary[] {
  const registry = getWorkflowModeRegistry();
  const fromRegistry = registry.getAllModes();
  const fromRegistryById = new Map(fromRegistry.map(m => [m.id, m] as const));

  const summaries: WorkflowSummary[] = fromRegistry.map(m => ({
    id: m.id,
    displayName: m.displayName,
    pipeline: m.pipeline,
    builtIn: m.builtIn === true,
    isOverride: m.isOverride === true,
    active: m.active !== false,
  }));

  // Surface user-uploaded manifests the registry filtered out.
  for (const userSum of listUserWorkflowsRaw()) {
    if (fromRegistryById.has(userSum.id)) continue;
    summaries.push({ ...userSum, active: false });
  }

  return opts?.userOnly ? summaries.filter(s => !s.builtIn) : summaries;
}

/**
 * Get the full manifest for a single workflow, or undefined.
 *
 * Tries the registry first (active manifests), then falls back to a
 * direct disk read of the user dir so workflows hidden by the
 * current COMFY_MODE filter still resolve. Without this fallback,
 * the Settings UI's edit dialog would say "not found" for any
 * inactive user workflow even though listWorkflows just rendered it.
 */
export function getWorkflow(id: string): WorkflowManifest | undefined {
  const fromRegistry = getWorkflowModeRegistry().getMode(id);
  if (fromRegistry) return fromRegistry;

  // Fallback: read from disk. Only the user dir — built-ins live
  // inside dhee-core's checkout and the registry is the canonical
  // path for those.
  const userDir = getUserWorkflowsDirForWrite();
  const manifestPath = join(userDir, `${id}.manifest.json`);
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const candidate: WorkflowManifest = Array.isArray(parsed) ? parsed[0] : parsed;
    if (candidate?.id !== id) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Update (patch defaults / display name / etc.)
// ---------------------------------------------------------------------------

export type WorkflowUpdate = Partial<
  Pick<
    WorkflowManifest,
    'displayName' | 'llmDescription' | 'selectionCriteria' | 'priority' |
    'parameterMappings' | 'inputRequirements' | 'promptKeywords' |
    'isOverride' | 'active'
  >
>;

/**
 * Patch fields on an existing user manifest. Refuses to patch
 * built-ins (they're immutable). Refreshes the registry so the
 * change is visible immediately.
 */
export function updateWorkflow(id: string, patch: WorkflowUpdate): WorkflowManifest {
  // Use getWorkflow() (which falls back to disk for mode-filtered
  // user manifests) instead of registry.getMode() directly —
  // otherwise editing a workflow's defaults would fail with
  // NOT_FOUND any time the user is in a mode that hides it.
  const existing = getWorkflow(id);
  if (!existing) {
    throw new WorkflowIntegrationError(`No workflow with id '${id}'`, 'NOT_FOUND');
  }
  if (existing.builtIn) {
    throw new WorkflowIntegrationError(
      `'${id}' is a built-in workflow and cannot be edited.`,
      'BUILTIN_IMMUTABLE',
    );
  }

  const userDir = getUserWorkflowsDirForWrite();
  const manifestPath = join(userDir, `${id}.manifest.json`);
  if (!existsSync(manifestPath)) {
    throw new WorkflowIntegrationError(
      `Manifest file missing on disk: ${manifestPath}`,
      'MANIFEST_MISSING',
    );
  }

  // Same mode-lock as saveWorkflow: even if a caller goes around
  // the WorkflowUpdate type via `as`, the persisted record stays
  // mode=local so cloud ComfyUI never sees a user-uploaded workflow.
  const merged: WorkflowManifest = {
    ...existing,
    ...patch,
    id,
    builtIn: false,
    mode: 'local',
  };
  writeFileSync(manifestPath, JSON.stringify(merged, null, 2));
  getWorkflowModeRegistry().refresh();
  return merged;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function deleteWorkflow(id: string): void {
  // Use getWorkflow() (disk fallback) so users can delete workflows
  // that are currently inactive in the registry's mode filter —
  // otherwise switching to cloud and trying to clean up local
  // workflows would fail with NOT_FOUND.
  const existing = getWorkflow(id);
  if (!existing) {
    throw new WorkflowIntegrationError(`No workflow with id '${id}'`, 'NOT_FOUND');
  }
  if (existing.builtIn) {
    throw new WorkflowIntegrationError(
      `'${id}' is a built-in workflow and cannot be deleted.`,
      'BUILTIN_IMMUTABLE',
    );
  }

  const userDir = getUserWorkflowsDirForWrite();

  // Remove manifest + workflow JSON if either exists. Other files
  // matching the prefix (e.g. previews) are left alone — we don't
  // own them.
  const manifestPath = join(userDir, `${id}.manifest.json`);
  const workflowPath = join(userDir, `${id}.json`);

  if (existsSync(manifestPath)) rmSync(manifestPath);
  if (existsSync(workflowPath)) rmSync(workflowPath);

  getWorkflowModeRegistry().refresh();
}

// ---------------------------------------------------------------------------
// Convenience: orphan cleanup
// ---------------------------------------------------------------------------

/**
 * Sweep the user workflows directory for `.json` files that have no
 * matching manifest. Useful after a partial save crash. Currently not
 * called by anything; here so future maintenance has a tool to use.
 */
export function findOrphanedWorkflows(): string[] {
  const userDir = getUserWorkflowsDirForWrite();
  if (!existsSync(userDir)) return [];
  const entries = readdirSync(userDir);
  const orphans: string[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json') || file.endsWith('.manifest.json')) continue;
    const id = file.replace(/\.json$/, '');
    const manifestFile = `${id}.manifest.json`;
    if (!entries.includes(manifestFile)) orphans.push(file);
  }
  return orphans;
}
