import {
  gpuTargetsSchema,
  gpuPreparationSchema,
  listGpuTargets,
  prepareGpuAttempt,
} from './gpuPreparation.js';
/** Shared structured operations for Desktop, CLI automation and future MCP adapters. */
import { realpathSync, statSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { GpuQueueClient } from '../dag/gpuQueue.js';
import { QueueJobs, type QueueJobRecord } from '../dag/gpuQueueJobs.js';
import {
  productionReviewsRequired,
  setProductionReviewsRequired,
} from '../dag/productionReviewGates.js';
import {
  readProjectProductionReview,
  recordProjectProductionReview,
} from '../dag/projectProductionReviews.js';
import { openEventLog } from '../dag/eventLog/EventLog.js';
import { projectWalkState } from '../dag/eventLog/projectWalkState.js';
import { runProjectViaBundle } from '../server/runners/runProjectViaBundle.js';

const project = {
  projectDir: z.string().refine(isAbsolute, 'An absolute project directory is required.'),
};
const branch = { branchId: z.string().min(1).default('main') };
const gate = z.enum(['storyboard', 'references', 'rough-cut']);
const id = z.string().regex(/^[a-f0-9]{64}$/);
export const productionRequestSchema = z.discriminatedUnion('action', [
  gpuTargetsSchema.extend({ action: z.literal('gpu.targets') }),
  gpuPreparationSchema.extend({ action: z.literal('gpu.prepare') }),
  gpuPreparationSchema
    .pick({ projectDir: true, branchId: true, nodeId: true, itemId: true })
    .extend({
      action: z.literal('gpu.run'),
      expectedSelectionId: z.string().min(1),
    }),
  z.object({ action: z.literal('gpu.catalog'), endpoint: z.string().min(1).optional() }).strict(),
  z
    .object({
      action: z.literal('gpu.jobs'),
      ...project,
      operation: z.enum(['list', 'refresh', 'cancel', 'download']),
      id: id.optional(),
    })
    .strict(),
  z.object({ action: z.literal('project.status'), ...project, ...branch }).strict(),
  z.object({ action: z.literal('review.enable'), ...project }).strict(),
  z.object({ action: z.literal('review.read'), ...project, ...branch, gate }).strict(),
  z
    .object({
      action: z.literal('review.decide'),
      ...project,
      ...branch,
      gate,
      expectedFingerprint: id,
      decision: z.enum(['approved', 'changes-requested']),
      notes: z.string().max(10000).optional(),
      humanAcknowledged: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('project.run'),
      ...project,
      ...branch,
      stopAt: z.string().min(1).optional(),
      runOnly: z.array(z.string().min(1)).optional(),
    })
    .strict(),
]);
export type ProductionRequest = z.input<typeof productionRequestSchema>;
export type ProductionResponse = { ok: true; result: unknown } | { ok: false; error: string };
export interface ProductionOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
}
type JobStore = Pick<QueueJobs, 'list' | 'refresh' | 'cancel' | 'download'>;
interface Dependencies {
  catalog?: (endpoint: string) => Pick<GpuQueueClient, 'listWorkflows'>;
  jobs?: (projectDir: string) => JobStore;
  run?: typeof runProjectViaBundle;
  recordReview?: typeof recordProjectProductionReview;
}
export function summarizeQueueJob(record: QueueJobRecord) {
  return {
    id: record.id,
    workflow: record.workflow,
    phase: record.phase,
    jobId: record.jobId,
    state: record.job?.state,
    cancelRequested: record.cancelRequested,
    error: record.error || record.job?.error || undefined,
    files: record.files?.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
  };
}
export function createProductionControl(deps: Dependencies = {}) {
  return async (input: unknown, options: ProductionOptions = {}): Promise<ProductionResponse> => {
    try {
      options.signal?.throwIfAborted();
      const req = productionRequestSchema.parse(input);
      if (req.action === 'gpu.catalog') {
        const endpoint = req.endpoint ?? process.env['DHEE_GPU_QUEUE_URL'] ?? '';
        const client = deps.catalog?.(endpoint) ?? new GpuQueueClient(endpoint);
        return { ok: true, result: { workflows: await client.listWorkflows(options.signal) } };
      }
      const projectDir = realpathSync(req.projectDir);
      if (!statSync(join(projectDir, 'project.json')).isFile())
        throw new Error('Project is unavailable.');
      if (req.action === 'gpu.targets')
        return { ok: true, result: listGpuTargets({ projectDir, branchId: req.branchId }) };
      if (req.action === 'gpu.prepare') {
        const { action, ...payload } = req;
        if (action === 'gpu.prepare')
          return {
            ok: true,
            result: await prepareGpuAttempt(
              payload,
              deps.catalog
                ? (endpoint, signal) => deps.catalog!(endpoint).listWorkflows(signal)
                : undefined,
              options.signal
            ),
          };
      }
      if (req.action === 'gpu.jobs') {
        if (req.operation !== 'list' && !req.id)
          throw new Error('A saved queue record id is required.');
        const store = deps.jobs?.(projectDir) ?? new QueueJobs(projectDir);
        if (req.operation !== 'list') await store[req.operation](req.id!, options.signal);
        return { ok: true, result: { jobs: store.list().map(summarizeQueueJob) } };
      }
      if (req.action === 'project.status') {
        const persisted = z
          .object({ pausedAtGate: z.unknown().optional(), pausedAtBudget: z.unknown().optional() })
          .parse(JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')));
        return {
          ok: true,
          result: {
            projectDir,
            branchId: req.branchId,
            reviewsRequired: productionReviewsRequired(projectDir),
            // Legacy pause markers are project-wide; never attribute them to this branch.
            pauseHints: {
              scope: 'project',
              gate: persisted.pausedAtGate ?? null,
              budget: persisted.pausedAtBudget ?? null,
            },
            state: projectWalkState([...openEventLog(projectDir).read()], {
              branchId: req.branchId,
            }),
          },
        };
      }
      if (req.action === 'review.enable')
        return { ok: true, result: setProductionReviewsRequired({ projectDir, enabled: true }) };
      if (req.action === 'review.read')
        return {
          ok: true,
          result: await readProjectProductionReview({
            projectDir,
            branchId: req.branchId,
            gate: req.gate,
            targets: [],
          }),
        };
      if (req.action === 'review.decide')
        return {
          ok: true,
          result: await (deps.recordReview ?? recordProjectProductionReview)({
            projectDir,
            branchId: req.branchId,
            gate: req.gate,
            targets: [],
            expectedFingerprint: req.expectedFingerprint,
            decision: req.decision,
            notes: req.notes,
          }),
        };
      if (!productionReviewsRequired(projectDir))
        throw new Error(
          'Enable the three creative approval points before an automated production run.'
        );
      if (req.action === 'gpu.run') {
        const target = listGpuTargets({ projectDir, branchId: req.branchId }).targets.find(
          t => t.nodeId === req.nodeId && t.itemId === req.itemId
        );
        if (
          !target ||
          target.unsupported ||
          target.tool !== 'gpu.queue' ||
          !target.selection?.preparationFingerprint ||
          target.selectionId !== req.expectedSelectionId
        )
          throw new Error(
            'The prepared GPU selection is unavailable or changed. Reload and prepare the target first.'
          );
        const result = await (deps.run ?? runProjectViaBundle)({
          requireProductionReviews: true,
          projectDir,
          branchId: req.branchId,
          targetInstance: {
            nodeId: req.nodeId,
            itemId: req.itemId,
            selectionId: req.expectedSelectionId,
          },
          signal: options.signal,
          log: options.log ?? (() => {}),
        });
        return result.ok
          ? { ok: true, result }
          : { ok: false, error: result.error ?? 'Selected generation failed.' };
      }
      const result = await (deps.run ?? runProjectViaBundle)({
        requireProductionReviews: true,
        projectDir,
        branchId: req.branchId,
        stopAt: req.stopAt,
        runOnly: req.runOnly,
        signal: options.signal,
        log: options.log ?? (() => {}),
      });
      if (!result.ok) return { ok: false, error: result.error ?? 'Production run failed.' };
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
export const executeProductionRequest = createProductionControl();
