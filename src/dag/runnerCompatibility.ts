import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseBundleSource, resolveBundleDir } from './bundleSource.js';
import { openEventLog } from './eventLog/EventLog.js';
import { ensureNpmRunnersLoaded } from './ecosystem.js';
import { getRunner } from './runners/index.js';
import { getGlobalRegistry, type RunnerManifest } from './runners/registry.js';
import type { DagBundle, NodeDef, NodeOutput, Runner, RunnerDescription } from './schema.js';
import { finddheeCoreRoot } from '../agent/pi/paths.js';

export type RunnerDefaultKind = 'text' | 'image' | 'video' | 'audio';

export type RunnerDefaults = Partial<Record<RunnerDefaultKind, string[]>>;

export interface RuntimeBinding {
  /** Config field to populate immediately before runner invocation. */
  configKey: string;
  /** Key in RunnerContext.inputs. Usually an upstream node id. */
  fromInput: string;
}

export interface RunnerOverrideInput {
  nodeId: string;
  toTool: string;
  configOverride?: Record<string, unknown>;
  generatedConfigOverride?: Record<string, unknown>;
  runtimeBindings?: RuntimeBinding[];
  reason?: string;
}

export type RunnerCompatibilityStatus =
  | 'ready'
  | 'current'
  | 'blocked'
  | 'warning'
  | 'needs_setup';

export interface RunnerCatalogEntry {
  tool: string;
  displayName: string;
  description?: string;
  kinds: RunnerDefaultKind[];
  outputFormats: NodeOutput['format'][];
  registered: boolean;
  credentials?: string[];
}

export interface RunnerCompatibilityResult {
  ok: boolean;
  status: RunnerCompatibilityStatus;
  reason: string;
  warning?: string;
  toTool: string;
  outputFormats: NodeOutput['format'][];
  configOverride?: Record<string, unknown>;
  runtimeBindings?: RuntimeBinding[];
}

export interface RunnerPlanCandidate extends RunnerCompatibilityResult {
  tool: string;
  displayName?: string;
  registered: boolean;
}

export interface BundleRunnerPlanNode {
  nodeId: string;
  displayName?: string;
  outputFormat: NodeOutput['format'];
  currentTool: string;
  proposedTool?: string;
  status: RunnerCompatibilityStatus;
  reason: string;
  candidates: RunnerPlanCandidate[];
  override?: RunnerOverrideInput;
}

export interface BundleRunnerPlan {
  bundleId: string;
  nodes: BundleRunnerPlanNode[];
  runnerCatalog: RunnerCatalogEntry[];
  overrides: RunnerOverrideInput[];
}

export interface SwitchRunnerRequest {
  projectDir: string;
  nodeId: string;
  itemId?: string;
  toTool: string;
  scope?: 'node' | 'instance';
  force?: boolean;
  configOverride?: Record<string, unknown>;
  runtimeBindings?: RuntimeBinding[];
  branchId?: string;
}

export type SwitchRunnerResult =
  | {
      ok: true;
      nodeId: string;
      itemId?: string;
      scope: 'node' | 'instance';
      fromTool: string;
      toTool: string;
      status: RunnerCompatibilityStatus | 'forced';
      reason: string;
      warning?: string;
    }
  | { ok: false; error: string; status?: RunnerCompatibilityStatus; reason?: string };

interface RunnerRequirementSlot {
  name: string;
  required?: boolean;
}

interface RunnerRequirements {
  requires: RunnerRequirementSlot[];
  outputs: NodeOutput['format'][];
  declared: boolean;
  warning?: string;
}

interface ExtendedRunnerDescription extends RunnerDescription {
  requires?: Array<string | RunnerRequirementSlot> | { slots?: Array<string | RunnerRequirementSlot> };
  compatibility?: {
    requires?: Array<string | RunnerRequirementSlot> | { slots?: Array<string | RunnerRequirementSlot> };
    outputs?: string[];
    output?: string;
  };
}

interface ExtendedRunnerManifest extends RunnerManifest {
  requires?: Array<string | RunnerRequirementSlot> | { slots?: Array<string | RunnerRequirementSlot> };
  compatibility?: {
    requires?: Array<string | RunnerRequirementSlot> | { slots?: Array<string | RunnerRequirementSlot> };
    outputs?: string[];
    output?: string;
  };
}

interface ProvidedSlot {
  slot: string;
  fromInput?: string;
  configKey?: string;
}

const TEXT_FORMATS: NodeOutput['format'][] = ['md', 'json', 'text'];
const CORE_ROOT = finddheeCoreRoot(import.meta.url);
const CLOUD_WORKFLOW_DIR = join(CORE_ROOT, 'workflows', 'cloud');

const DHEE_CLOUD_WORKFLOW_CONFIG: Record<string, Record<string, unknown>> = {
  'dhee.cloud.image': {
    workflowPath: join(CLOUD_WORKFLOW_DIR, 'zimage_standard_cloud.json'),
    manifestPath: join(CLOUD_WORKFLOW_DIR, 'zimage_standard_cloud.manifest.json'),
    workflowId: 'zimage_cloud',
    endpoint: '',
  },
  'dhee.cloud.video': {
    workflowPath: join(CLOUD_WORKFLOW_DIR, 'ltx23_i2v_cloud.json'),
    manifestPath: join(CLOUD_WORKFLOW_DIR, 'ltx23_i2v_cloud.manifest.json'),
    workflowId: 'ltx23_i2v_cloud',
    endpoint: '',
  },
};

const DHEE_CLOUD_CATALOG: RunnerCatalogEntry[] = [
  {
    tool: 'dhee.cloud.text',
    displayName: 'Dhee Cloud Text',
    description: 'Dhee Cloud hosted text runner.',
    kinds: ['text'],
    outputFormats: TEXT_FORMATS,
    registered: true,
  },
  {
    tool: 'dhee.cloud.image',
    displayName: 'Dhee Cloud Image',
    description: 'Dhee Cloud hosted image runner.',
    kinds: ['image'],
    outputFormats: ['image'],
    registered: true,
  },
  {
    tool: 'dhee.cloud.video',
    displayName: 'Dhee Cloud Video',
    description: 'Dhee Cloud hosted video runner.',
    kinds: ['video'],
    outputFormats: ['video'],
    registered: true,
  },
];

const BUILTIN_RUNNER_REQUIREMENTS: Record<string, RunnerRequirements> = {
  'dhee.cloud.text': {
    declared: true,
    requires: [{ name: 'prompt', required: true }],
    outputs: TEXT_FORMATS,
  },
  'dhee.cloud.image': {
    declared: true,
    requires: [{ name: 'prompt', required: true }],
    outputs: ['image'],
  },
  'dhee.cloud.video': {
    declared: true,
    requires: [
      { name: 'prompt', required: true },
      { name: 'firstFrame', required: true },
    ],
    outputs: ['video'],
  },
  'openrouter.image': {
    declared: true,
    requires: [{ name: 'prompt', required: true }],
    outputs: ['image'],
  },
  'openrouter.video': {
    declared: true,
    requires: [
      { name: 'prompt', required: true },
      { name: 'firstFrame', required: true },
    ],
    outputs: ['video'],
  },
  'comfy.tti': {
    declared: true,
    requires: [
      { name: 'prompt', required: true },
      { name: 'workflowPath', required: true },
    ],
    outputs: ['image'],
  },
  'comfy.klein': {
    declared: true,
    requires: [
      { name: 'prompt', required: true },
      { name: 'baseImage', required: true },
      { name: 'workflowPath', required: true },
    ],
    outputs: ['image'],
  },
  'comfy.qwen_edit_chain': {
    declared: true,
    requires: [
      { name: 'prompt', required: true },
      { name: 'baseImage', required: true },
      { name: 'workflowPath', required: true },
    ],
    outputs: ['image'],
  },
  'comfy.fl2v': {
    declared: true,
    requires: [
      { name: 'prompt', required: true },
      { name: 'firstFrame', required: true },
      { name: 'lastFrame', required: true },
      { name: 'workflowPath', required: true },
    ],
    outputs: ['video'],
  },
  'comfy.ltx_director': {
    declared: true,
    requires: [
      { name: 'prompt', required: true },
      { name: 'firstFrame', required: true },
      { name: 'workflowPath', required: true },
    ],
    outputs: ['video'],
  },
  'ffmpeg.concat': {
    declared: true,
    requires: [{ name: 'videoInput', required: true }],
    outputs: ['video'],
  },
  'ffmpeg.shot_clip': {
    declared: true,
    requires: [],
    outputs: ['video'],
  },
  'ffmpeg.kenburns': {
    declared: true,
    requires: [{ name: 'firstFrame', required: true }],
    outputs: ['video'],
  },
  'ffmpeg.overlay': {
    declared: true,
    requires: [{ name: 'videoInput', required: true }],
    outputs: ['video'],
  },
  'ffmpeg.demo_overlay': {
    declared: true,
    requires: [{ name: 'videoInput', required: true }],
    outputs: ['video'],
  },
  'llm.generate': {
    declared: true,
    requires: [],
    outputs: TEXT_FORMATS,
  },
  'vlm.judge': {
    declared: true,
    requires: [{ name: 'firstFrame', required: true }],
    outputs: ['json'],
  },
};

function slotFromInputKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed.endsWith('Input')) return trimmed;
  const base = trimmed.slice(0, -'Input'.length);
  return base.slice(0, 1).toLowerCase() + base.slice(1);
}

function slotAliases(slot: string): string[] {
  switch (slot) {
    case 'prompt':
      return ['prompt', 'textInput', 'motionPrompt', 'description', 'script'];
    case 'firstFrame':
      return ['firstFrame', 'baseImage', 'referenceImage', 'imageInput'];
    case 'lastFrame':
      return ['lastFrame'];
    case 'baseImage':
      return ['baseImage', 'firstFrame', 'referenceImage', 'imageInput'];
    case 'referenceImage':
      return ['referenceImage', 'baseImage', 'firstFrame', 'imageInput'];
    case 'videoInput':
      return ['videoInput', 'video'];
    default:
      return [slot];
  }
}

function normalizeRequires(
  raw: unknown,
): RunnerRequirementSlot[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { slots?: unknown }).slots)
      ? (raw as { slots: unknown[] }).slots
      : null;
  if (!list) return null;
  const out: RunnerRequirementSlot[] = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim().length > 0) {
      out.push({ name: item.trim(), required: true });
    } else if (item && typeof item === 'object') {
      const name = (item as { name?: unknown; slot?: unknown }).name ?? (item as { slot?: unknown }).slot;
      if (typeof name === 'string' && name.trim().length > 0) {
        out.push({
          name: name.trim(),
          required: (item as { required?: unknown }).required !== false,
        });
      }
    }
  }
  return out;
}

function outputFromModality(value: string): NodeOutput['format'] | null {
  if (value === 'text') return 'text';
  if (value === 'image' || value === 'video' || value === 'audio') return value;
  if (value === 'json' || value === 'md') return value;
  return null;
}

function outputsFromUnknown(raw: unknown): NodeOutput['format'][] {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out = new Set<NodeOutput['format']>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const mapped = outputFromModality(value);
    if (mapped) out.add(mapped);
  }
  return [...out];
}

function descriptionRequirements(runner: Runner | undefined): RunnerRequirements | null {
  if (!runner) return null;
  let description: ExtendedRunnerDescription | null = null;
  try {
    description = runner.describe() as ExtendedRunnerDescription;
  } catch {
    return null;
  }
  const compat = description.compatibility;
  const requires =
    normalizeRequires(compat?.requires) ??
    normalizeRequires(description.requires);
  if (!requires) return null;
  const compatOutputs = outputsFromUnknown(compat?.outputs ?? compat?.output);
  const modalityOutputs = outputsFromUnknown(description.modalities?.output);
  return {
    declared: true,
    requires,
    outputs: compatOutputs.length > 0 ? compatOutputs : modalityOutputs,
  };
}

function manifestRequirements(manifest: RunnerManifest | undefined): RunnerRequirements | null {
  if (!manifest) return null;
  const extended = manifest as ExtendedRunnerManifest;
  const compat = extended.compatibility;
  const requires =
    normalizeRequires(compat?.requires) ??
    normalizeRequires(extended.requires);
  if (!requires) return null;
  return {
    declared: true,
    requires,
    outputs: outputsFromUnknown(compat?.outputs ?? compat?.output),
  };
}

function requirementsForTool(tool: string): RunnerRequirements {
  const runner = getRunner(tool);
  const manifest = getGlobalRegistry().getManifest(tool);
  const fromDescription = descriptionRequirements(runner);
  if (fromDescription) return fromDescription;
  const fromManifest = manifestRequirements(manifest);
  if (fromManifest) return fromManifest;
  const fallback = BUILTIN_RUNNER_REQUIREMENTS[tool];
  if (fallback) return fallback;
  const descOutputs = runner ? outputsFromUnknown((runner.describe() as RunnerDescription).modalities?.output) : [];
  return {
    declared: false,
    requires: [],
    outputs: descOutputs,
    warning: `Runner '${tool}' does not declare compatibility requirements; this swap could not be fully verified.`,
  };
}

function kindForOutput(format: NodeOutput['format']): RunnerDefaultKind {
  if (format === 'image' || format === 'video' || format === 'audio') return format;
  return 'text';
}

function formatsForKinds(kinds: RunnerDefaultKind[]): NodeOutput['format'][] {
  const out = new Set<NodeOutput['format']>();
  for (const kind of kinds) {
    if (kind === 'text') {
      for (const fmt of TEXT_FORMATS) out.add(fmt);
    } else {
      out.add(kind);
    }
  }
  return [...out];
}

function catalogEntryFromManifest(manifest: RunnerManifest): RunnerCatalogEntry {
  const runner = getRunner(manifest.tool);
  let desc: RunnerDescription | undefined;
  try {
    desc = runner?.describe();
  } catch {
    desc = undefined;
  }
  const kinds = new Set<RunnerDefaultKind>();
  for (const output of desc?.modalities?.output ?? []) {
    if (output === 'text' || output === 'image' || output === 'video' || output === 'audio') {
      kinds.add(output);
    }
  }
  const req = requirementsForTool(manifest.tool);
  for (const output of req.outputs) kinds.add(kindForOutput(output));
  if (kinds.size === 0) {
    if (manifest.tool.includes('image')) kinds.add('image');
    else if (manifest.tool.includes('video')) kinds.add('video');
    else if (manifest.tool.includes('audio')) kinds.add('audio');
    else kinds.add('text');
  }
  const kindList = [...kinds];
  return {
    tool: manifest.tool,
    displayName: manifest.displayName ?? desc?.displayName ?? manifest.tool,
    ...(manifest.description ?? desc?.description
      ? { description: manifest.description ?? desc?.description }
      : {}),
    kinds: kindList,
    outputFormats: req.outputs.length > 0 ? req.outputs : formatsForKinds(kindList),
    registered: true,
    ...(manifest.credentials?.length ? { credentials: manifest.credentials } : {}),
  };
}

export async function listRunnerCatalog(): Promise<RunnerCatalogEntry[]> {
  await ensureNpmRunnersLoaded();
  const byTool = new Map<string, RunnerCatalogEntry>();
  for (const entry of getGlobalRegistry().list().map(catalogEntryFromManifest)) {
    byTool.set(entry.tool, entry);
  }
  for (const cloud of DHEE_CLOUD_CATALOG) {
    const existing = byTool.get(cloud.tool);
    if (existing) {
      byTool.set(cloud.tool, { ...existing, displayName: existing.displayName || cloud.displayName });
    } else {
      byTool.set(cloud.tool, cloud);
    }
  }
  return [...byTool.values()].sort((a, b) => a.tool.localeCompare(b.tool));
}

function isConfiguredInput(node: NodeDef, bundle: DagBundle, inputId: string): boolean {
  if ((node.inputs ?? []).some((input) => input.from === inputId)) return true;
  if ((bundle.inputs ?? []).some((input) => input.id === inputId)) return true;
  return false;
}

function inferProvidedSlots(
  bundle: DagBundle,
  node: NodeDef,
  effectiveConfig: Record<string, unknown>,
): ProvidedSlot[] {
  const out: ProvidedSlot[] = [];
  const add = (slot: string, extra?: Omit<ProvidedSlot, 'slot'>) => {
    out.push({ slot, ...(extra ?? {}) });
  };

  add(`output:${node.outputs.format}`);
  if (TEXT_FORMATS.includes(node.outputs.format)) add('output:text');

  for (const [key, value] of Object.entries(effectiveConfig)) {
    if (key.endsWith('Input') && typeof value === 'string' && isConfiguredInput(node, bundle, value)) {
      add(slotFromInputKey(key), { fromInput: value, configKey: key });
    }
    if (
      ['prompt', 'model', 'firstFrame', 'lastFrame', 'baseImage', 'referenceImage', 'video'].includes(key) &&
      value !== undefined &&
      value !== null &&
      value !== ''
    ) {
      add(key, { configKey: key });
    }
    if (key === 'workflowPath' && typeof value === 'string' && value.length > 0) {
      add('workflowPath', { configKey: key });
    }
    if (key === 'manifestPath' && typeof value === 'string' && value.length > 0) {
      add('workflowManifest', { configKey: key });
    }
  }

  for (const input of node.inputs ?? []) {
    const upstream = bundle.nodes.find((candidate) => candidate.id === input.from);
    const format = upstream?.outputs?.format;
    const id = input.from.toLowerCase();
    if (format) {
      add(`input:${format}`, { fromInput: input.from });
      if (TEXT_FORMATS.includes(format)) add('input:text', { fromInput: input.from });
    }
    if (
      id.includes('prompt') ||
      id.includes('motion') ||
      id.includes('directive') ||
      id.includes('script') ||
      id.includes('story') ||
      (format && TEXT_FORMATS.includes(format) && input.usage !== 'reference')
    ) {
      add('prompt', { fromInput: input.from });
    }
    if (
      id.includes('last_frame') ||
      id.includes('lastframe') ||
      id.endsWith('_last') ||
      id.includes('end_frame')
    ) {
      add('lastFrame', { fromInput: input.from });
    } else if (
      format === 'image' &&
      (
        id.includes('first_frame') ||
        id.includes('firstframe') ||
        id.includes('image') ||
        id.includes('frame') ||
        input.usage === 'input' ||
        input.usage === 'reference'
      )
    ) {
      add('firstFrame', { fromInput: input.from });
      add('baseImage', { fromInput: input.from });
      add('referenceImage', { fromInput: input.from });
    }
    if (format === 'video') {
      add('videoInput', { fromInput: input.from });
      add('video', { fromInput: input.from });
    }
  }

  return out;
}

function hasOutputOverlap(nodeFormat: NodeOutput['format'], targetOutputs: NodeOutput['format'][]): boolean {
  if (targetOutputs.length === 0) return true;
  if (targetOutputs.includes(nodeFormat)) return true;
  if (TEXT_FORMATS.includes(nodeFormat) && targetOutputs.some((fmt) => TEXT_FORMATS.includes(fmt))) return true;
  return false;
}

function findSlot(provided: ProvidedSlot[], required: string): ProvidedSlot | null {
  const aliases = slotAliases(required);
  return provided.find((slot) => aliases.includes(slot.slot)) ?? null;
}

function generatedOverridesForTarget(
  toTool: string,
  provided: ProvidedSlot[],
  required: RunnerRequirementSlot[],
): Pick<RunnerCompatibilityResult, 'configOverride' | 'runtimeBindings'> {
  const configOverride: Record<string, unknown> = {};
  const runtimeBindings: RuntimeBinding[] = [];
  const bind = (slot: string, openConfigKey: string, runtimeKey: string) => {
    const source = findSlot(provided, slot);
    if (!source?.fromInput) return;
    if (toTool.startsWith('openrouter.')) {
      configOverride[openConfigKey] = source.fromInput;
    } else {
      runtimeBindings.push({ configKey: runtimeKey, fromInput: source.fromInput });
    }
  };
  Object.assign(configOverride, DHEE_CLOUD_WORKFLOW_CONFIG[toTool] ?? {});
  const requiredNames = new Set(required.map((r) => r.name));
  if (requiredNames.has('prompt')) bind('prompt', 'promptInput', 'prompt');
  if (requiredNames.has('firstFrame')) bind('firstFrame', 'firstFrameInput', 'firstFrame');
  if (requiredNames.has('lastFrame')) bind('lastFrame', 'lastFrameInput', 'lastFrame');
  if (requiredNames.has('baseImage')) bind('baseImage', 'baseImageInput', 'baseImage');
  return {
    ...(Object.keys(configOverride).length > 0 ? { configOverride } : {}),
    ...(runtimeBindings.length > 0 ? { runtimeBindings } : {}),
  };
}

export function inferNodeRunnerCompatibility(input: {
  bundle: DagBundle;
  node: NodeDef;
  toTool: string;
  effectiveConfig?: Record<string, unknown>;
}): RunnerCompatibilityResult {
  const { bundle, node, toTool } = input;
  const effectiveConfig = input.effectiveConfig ?? node.runner.config ?? {};
  const registered = Boolean(getRunner(toTool));
  const req = requirementsForTool(toTool);
  const outputs = req.outputs.length > 0 ? req.outputs : formatsForKinds([kindForOutput(node.outputs.format)]);

  if (!registered) {
    return {
      ok: false,
      status: 'needs_setup',
      reason: `Runner '${toTool}' is not installed or registered.`,
      toTool,
      outputFormats: outputs,
    };
  }

  if (!hasOutputOverlap(node.outputs.format, outputs)) {
    return {
      ok: false,
      status: 'blocked',
      reason: `${toTool} outputs ${outputs.join(', ') || 'an undeclared format'}, but ${node.id} must produce ${node.outputs.format}.`,
      toTool,
      outputFormats: outputs,
    };
  }

  if (!req.declared && req.warning) {
    return {
      ok: true,
      status: 'warning',
      reason: req.warning,
      warning: req.warning,
      toTool,
      outputFormats: outputs,
    };
  }

  const provided = inferProvidedSlots(bundle, node, effectiveConfig);
  const missing: string[] = [];
  for (const required of req.requires) {
    if (required.required === false) continue;
    if (required.name === 'workflowPath') {
      if (typeof effectiveConfig['workflowPath'] !== 'string' || !(effectiveConfig['workflowPath'] as string).trim()) {
        missing.push('workflowPath');
      }
      continue;
    }
    if (!findSlot(provided, required.name)) {
      missing.push(required.name);
    }
  }

  if (missing.length > 0) {
    const providedText = [...new Set(provided.map((slot) => slot.slot))]
      .filter((slot) => !slot.startsWith('output:') && !slot.startsWith('input:'))
      .sort()
      .join(', ') || 'no compatible inputs';
    return {
      ok: false,
      status: 'blocked',
      reason: `${toTool} needs ${missing.join(', ')}; ${node.id} provides ${providedText}.`,
      toTool,
      outputFormats: outputs,
    };
  }

  const generated = generatedOverridesForTarget(toTool, provided, req.requires);
  return {
    ok: true,
    status: 'ready',
    reason: `${toTool} can use ${node.id}'s existing inputs and produce ${node.outputs.format}.`,
    toTool,
    outputFormats: outputs,
    ...generated,
  };
}

export async function previewBundleRunnerPlan(input: {
  bundle: DagBundle;
  runnerDefaults?: RunnerDefaults;
}): Promise<BundleRunnerPlan> {
  await ensureNpmRunnersLoaded();
  const runnerCatalog = await listRunnerCatalog();
  const catalogByTool = new Map(runnerCatalog.map((entry) => [entry.tool, entry]));
  const overrides: RunnerOverrideInput[] = [];
  const nodes: BundleRunnerPlanNode[] = [];

  for (const node of input.bundle.nodes) {
    const kind = kindForOutput(node.outputs.format);
    const defaults = input.runnerDefaults?.[kind]?.filter(Boolean) ?? [];
    const candidates: RunnerPlanCandidate[] = [];
    let chosen: RunnerCompatibilityResult | null = null;
    let attempted: RunnerCompatibilityResult | null = null;

    for (const tool of defaults) {
      if (tool === node.runner.tool) {
        const current: RunnerCompatibilityResult = {
          ok: true,
          status: 'current',
          reason: `${node.id} already uses ${tool}.`,
          toTool: tool,
          outputFormats: [node.outputs.format],
        };
        candidates.push({
          ...current,
          tool,
          displayName: catalogByTool.get(tool)?.displayName,
          registered: catalogByTool.get(tool)?.registered ?? Boolean(getRunner(tool)),
        });
        attempted ??= current;
        chosen ??= current;
        break;
      }
      const check = inferNodeRunnerCompatibility({
        bundle: input.bundle,
        node,
        toTool: tool,
      });
      candidates.push({
        ...check,
        tool,
        displayName: catalogByTool.get(tool)?.displayName,
        registered: catalogByTool.get(tool)?.registered ?? Boolean(getRunner(tool)),
      });
      attempted ??= check;
      if (check.ok && (check.status === 'ready' || check.status === 'warning')) {
        chosen = check;
        break;
      }
    }

    const status = chosen?.status ?? attempted?.status ?? 'current';
    const reason =
      chosen?.reason ??
      attempted?.reason ??
      `No ${kind} runner default is configured; keeping ${node.runner.tool}.`;
    const override =
      chosen &&
      chosen.ok &&
      chosen.toTool !== node.runner.tool &&
      (chosen.status === 'ready' || chosen.status === 'warning')
        ? {
            nodeId: node.id,
            toTool: chosen.toTool,
            ...(chosen.configOverride ? { generatedConfigOverride: chosen.configOverride } : {}),
            ...(chosen.runtimeBindings ? { runtimeBindings: chosen.runtimeBindings } : {}),
            reason,
          }
        : undefined;
    if (override) overrides.push(override);

    nodes.push({
      nodeId: node.id,
      ...(node.displayName ? { displayName: node.displayName } : {}),
      outputFormat: node.outputs.format,
      currentTool: node.runner.tool,
      ...(chosen?.toTool ?? attempted?.toTool ? { proposedTool: chosen?.toTool ?? attempted?.toTool } : {}),
      status,
      reason,
      candidates,
      ...(override ? { override } : {}),
    });
  }

  return {
    bundleId: input.bundle.id,
    nodes,
    runnerCatalog,
    overrides,
  };
}

function loadBundleFromProject(projectDir: string): { bundle: DagBundle; bundleSource: string } {
  const projectPath = join(projectDir, 'project.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as { bundleSource?: string };
  if (typeof project.bundleSource !== 'string' || !project.bundleSource.trim()) {
    throw new Error(`project.json has no bundleSource field.`);
  }
  const source = parseBundleSource(project.bundleSource);
  const dirOrJson = resolveBundleDir(source);
  const bundlePath = statSync(dirOrJson).isDirectory() ? join(dirOrJson, 'bundle.json') : dirOrJson;
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as DagBundle;
  return { bundle, bundleSource: project.bundleSource };
}

export function loadBundleForRunnerPlan(bundleSource: string): DagBundle {
  const source = parseBundleSource(bundleSource);
  const dirOrJson = resolveBundleDir(source);
  const bundlePath = statSync(dirOrJson).isDirectory() ? join(dirOrJson, 'bundle.json') : dirOrJson;
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as DagBundle;
  if (!bundle.id || !Array.isArray(bundle.nodes)) {
    throw new Error(`Invalid bundle at ${bundlePath}: missing id/nodes.`);
  }
  return bundle;
}

export async function previewBundleRunnerPlanFromSource(input: {
  bundleSource: string;
  runnerDefaults?: RunnerDefaults;
}): Promise<BundleRunnerPlan> {
  const bundle = loadBundleForRunnerPlan(input.bundleSource);
  return previewBundleRunnerPlan({ bundle, runnerDefaults: input.runnerDefaults });
}

export async function switchRunnerForProject(input: SwitchRunnerRequest): Promise<SwitchRunnerResult> {
  if (!existsSync(input.projectDir)) {
    return { ok: false, error: `projectDir not found: ${input.projectDir}` };
  }
  await ensureNpmRunnersLoaded();
  let bundle: DagBundle;
  try {
    ({ bundle } = loadBundleFromProject(input.projectDir));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const node = bundle.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node) {
    return { ok: false, error: `Unknown node '${input.nodeId}' in bundle '${bundle.id}'.` };
  }

  const check = inferNodeRunnerCompatibility({
    bundle,
    node,
    toTool: input.toTool,
    effectiveConfig: { ...node.runner.config, ...(input.configOverride ?? {}) },
  });
  if (!check.ok && !input.force) {
    return {
      ok: false,
      error: check.reason,
      status: check.status,
      reason: check.reason,
    };
  }

  const scope: 'node' | 'instance' =
    input.scope ?? (input.itemId !== undefined ? 'instance' : 'node');
  const payloadItemId = scope === 'instance' ? input.itemId : undefined;
  if (scope === 'instance' && !payloadItemId) {
    return { ok: false, error: `Instance-scope runner switch requires itemId.` };
  }

  const log = openEventLog(input.projectDir);
  log.append({
    branchId: input.branchId ?? 'main',
    actor: 'user',
    kind: 'runner.swapped',
    payload: {
      nodeId: input.nodeId,
      ...(payloadItemId !== undefined ? { itemId: payloadItemId } : {}),
      scope,
      fromTool: node.runner.tool,
      toTool: input.toTool,
      reason: input.force
        ? `Forced runner switch to ${input.toTool}. ${check.reason}`
        : check.reason,
      ...(input.force ? { forced: true } : {}),
      ...(input.configOverride ? { configOverride: input.configOverride } : {}),
      ...(check.configOverride ? { generatedConfigOverride: check.configOverride } : {}),
      ...(input.runtimeBindings ?? check.runtimeBindings
        ? { runtimeBindings: input.runtimeBindings ?? check.runtimeBindings }
        : {}),
      compatibility: {
        status: check.status,
        reason: check.reason,
        ...(check.warning ? { warning: check.warning } : {}),
      },
    },
  });

  return {
    ok: true,
    nodeId: input.nodeId,
    ...(payloadItemId !== undefined ? { itemId: payloadItemId } : {}),
    scope,
    fromTool: node.runner.tool,
    toTool: input.toTool,
    status: input.force ? 'forced' : check.status,
    reason: check.reason,
    ...(check.warning ? { warning: check.warning } : {}),
  };
}
