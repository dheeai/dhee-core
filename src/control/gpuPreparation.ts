import { createHash } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import { GpuQueueClient, type GpuWorkflow } from '../dag/gpuQueue.js';
import { validateQueueInputs } from '../dag/gpuQueueInputs.js';
import { QueueJobs } from '../dag/gpuQueueJobs.js';
import { parseBundleSource, resolveBundleDir } from '../dag/bundleSource.js';
import { loadBundle, materializeProductionReviewInstances } from '../dag/walker.js';
import { openEventLog } from '../dag/eventLog/EventLog.js';
import type { DheeEvent } from '../dag/eventLog/events.js';
import { computeBranchTree } from '../dag/eventLog/projectBranches.js';
import { projectWalkState } from '../dag/eventLog/projectWalkState.js';
import { acquireWalkLock, isWalkLockResult } from '../dag/projectWalkLock.js';
const targetFields = {
  projectDir: z.string().refine(isAbsolute),
  branchId: z.string().min(1).default('main'),
};
export const gpuTargetsSchema = z.object(targetFields).strict();
export const gpuPreparationSchema = z
  .object({
    ...targetFields,
    nodeId: z.string().regex(/^[\w.-]+$/),
    itemId: z
      .string()
      .regex(/^[\w.-]+$/)
      .optional(),
    requestId: z.string().min(8).max(128),
    expectedSelectionId: z.string().nullable(),
    endpoint: z.string().min(1).optional(),
    workflow: z.string().min(1),
    workflowVersion: z.string().min(1),
    inputs: z.record(z.unknown()),
    primaryOutput: z.number().int().nonnegative().default(0),
  })
  .strict();
type SelectionEvent = DheeEvent<'runner.swapped'>;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function snapshot(input: z.input<typeof gpuTargetsSchema>) {
  const req = gpuTargetsSchema.parse(input);
  const projectDir = realpathSync(req.projectDir);
  const project = z
    .object({ bundleSource: z.string() })
    .parse(JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')));
  const location = resolveBundleDir(parseBundleSource(project.bundleSource));
  const bundle = loadBundle(
    statSync(location).isDirectory() ? join(location, 'bundle.json') : location
  );
  const events = [...openEventLog(projectDir).read()];
  const branches = computeBranchTree(events).branches;
  if (!branches.some(b => b.branchId === req.branchId)) throw new Error('Unknown project branch.');
  const instances = materializeProductionReviewInstances({
    projectDir,
    bundle,
    branchId: req.branchId,
  });
  const state = projectWalkState(events, { branchId: req.branchId });
  const swaps = events.filter(
    (e): e is SelectionEvent => e.kind === 'runner.swapped' && e.branchId === req.branchId
  );
  const targets = bundle.nodes
    .filter(n => ['image', 'video', 'audio'].includes(n.outputs.format))
    .flatMap(node =>
      (instances.get(node.id) ?? []).map(item => {
        const latest = swaps
          .filter(e => e.payload.nodeId === node.id && e.payload.itemId === item.itemId)
          .at(-1);
        const effectiveTool = latest?.payload.toTool ?? node.runner.tool;
        const selection =
          effectiveTool === 'gpu.queue'
            ? { ...node.runner.config, ...latest?.payload.configOverride }
            : undefined;
        const key = item.itemId === undefined ? node.id : `${node.id}:${item.itemId}`;
        return {
          nodeId: node.id,
          itemId: item.itemId,
          format: node.outputs.format,
          status: state.nodes[key]?.status ?? 'pending',
          selectionId: latest?.id ?? null,
          selection,
          tool: latest?.payload.toTool ?? node.runner.tool,
          unsupported: !!node.chunkBy,
        };
      })
    );
  return { projectDir, branchId: req.branchId, branches, targets, swaps };
}
export function listGpuTargets(input: z.input<typeof gpuTargetsSchema>) {
  const { swaps: _swaps, ...result } = snapshot(input);
  return result;
}
export async function prepareGpuAttempt(
  input: z.input<typeof gpuPreparationSchema>,
  catalog: (endpoint: string, signal?: AbortSignal) => Promise<GpuWorkflow[]> = (
    endpoint,
    signal
  ) => new GpuQueueClient(endpoint).listWorkflows(signal),
  signal?: AbortSignal
) {
  const req = gpuPreparationSchema.parse(input);
  signal?.throwIfAborted();
  const key = JSON.stringify([
    'prepared',
    req.branchId,
    req.nodeId,
    req.itemId ?? '',
    req.requestId,
  ]);
  const fingerprint = digest(canonical(req));
  const initial = snapshot({ projectDir: req.projectDir, branchId: req.branchId });
  const previous = initial.swaps.find(e => e.payload.configOverride?.attemptKey === key);
  const response = (event: SelectionEvent, active = true) => ({
    active,
    selectionId: event.id,
    attemptKey: key,
    workflow: req.workflow,
    workflowVersion: req.workflowVersion,
    inputs: event.payload.configOverride?.inputs,
  });
  if (previous) {
    if (previous.payload.configOverride?.preparationFingerprint !== fingerprint)
      throw new Error('This request id belongs to a different preparation.');
    return response(
      previous,
      initial.targets.some(t => t.selectionId === previous.id)
    );
  }
  const endpoint = new GpuQueueClient(req.endpoint ?? process.env['DHEE_GPU_QUEUE_URL'] ?? '')
    .endpoint.href;
  const workflow = (await catalog(endpoint, signal)).find(w => w.name === req.workflow);
  if (!workflow || workflow.version !== req.workflowVersion)
    throw new Error('Workflow version changed. Refresh the catalog and select it again.');
  const inputs = validateQueueInputs(workflow, req.inputs, parseInt(digest(key).slice(0, 8), 16));
  let total = 0;
  for (const [name, schema] of Object.entries(workflow.inputs)) {
    if (inputs[name] === undefined || !['file', 'file_list'].includes(String(schema.type)))
      continue;
    for (const file of schema.type === 'file_list'
      ? (inputs[name] as string[])
      : [inputs[name] as string]) {
      if (/^up_[A-Za-z0-9_-]+$/.test(file)) continue;
      if (/^https?:\/\//.test(file)) {
        const url = new URL(file);
        if (url.username || url.password)
          throw new Error('Reference URLs cannot embed credentials.');
        continue;
      }
      const path = realpathSync(resolve(initial.projectDir, file));
      const rel = relative(initial.projectDir, path);
      const info = statSync(path);
      if (
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        !rel ||
        !info.isFile() ||
        !/\.(png|jpe?g|webp|gif|mp4|mov|webm|mkv|wav|mp3|flac|ogg|m4a|aac)$/i.test(path)
      )
        throw new Error('References must be supported media files inside the project.');
      total += info.size;
      if (info.size > 64 * 1024 ** 2 || total > 128 * 1024 ** 2)
        throw new Error('References exceed the upload snapshot limits.');
    }
  }
  signal?.throwIfAborted();
  const lock = acquireWalkLock(initial.projectDir);
  if (isWalkLockResult(lock)) throw new Error('Stop the active run before preparing an attempt.');
  try {
    const current = snapshot({ projectDir: initial.projectDir, branchId: req.branchId });
    const duplicate = current.swaps.find(e => e.payload.configOverride?.attemptKey === key);
    if (duplicate) {
      if (duplicate.payload.configOverride?.preparationFingerprint !== fingerprint)
        throw new Error('This request id belongs to a different preparation.');
      return response(
        duplicate,
        current.targets.some(t => t.selectionId === duplicate.id)
      );
    }
    const target = current.targets.find(t => t.nodeId === req.nodeId && t.itemId === req.itemId);
    if (!target) throw new Error('Target is not in the current project plan.');
    if (target.unsupported)
      throw new Error(
        'Adaptive chunk targets require explicit chunk planning before queue preparation.'
      );
    if (target.status === 'completed' || target.status === 'in_progress')
      throw new Error(
        `Target is ${target.status}; stop or explicitly invalidate it before preparing another attempt.`
      );
    if (target.selectionId !== req.expectedSelectionId)
      throw new Error('Selection changed. Reload the target before saving.');
    if (typeof target.selection?.attemptKey === 'string') {
      const prior = new QueueJobs(initial.projectDir).find(
        JSON.stringify(['gpu.queue', req.nodeId, req.itemId ?? '', target.selection.attemptKey])
      );
      if (
        prior &&
        prior.phase !== 'downloaded' &&
        !['failed', 'cancelled', 'expired'].includes(prior.job?.state ?? '')
      )
        throw new Error(
          'The previous attempt is active or unresolved. Recover it before replacing it.'
        );
    }
    const event = openEventLog(initial.projectDir).append({
      kind: 'runner.swapped',
      actor: 'user',
      branchId: req.branchId,
      payload: {
        nodeId: req.nodeId,
        ...(req.itemId ? { itemId: req.itemId } : {}),
        fromTool: target.tool,
        toTool: 'gpu.queue',
        reason: 'Explicit catalog workflow preparation; no job submitted.',
        configOverride: {
          endpoint,
          workflow: req.workflow,
          workflowVersion: req.workflowVersion,
          attemptKey: key,
          inputs,
          inputMap: {},
          primaryOutput: req.primaryOutput,
          timeoutSeconds: 1800,
          preparationFingerprint: fingerprint,
        },
      },
    });
    return response(event);
  } finally {
    lock.release();
  }
}
