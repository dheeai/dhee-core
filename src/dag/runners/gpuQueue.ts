import { sceneIntentSchema, assertSceneIntent } from '../../control/sceneIntent.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { readFile, stat, copyFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { GpuQueueClient } from '../gpuQueue.js';
import { QueueJobs, type QueueJobRecord } from '../gpuQueueJobs.js';
import { validateQueueInputs, uploadQueueFile } from '../gpuQueueInputs.js';
import type { Runner, RunnerContext } from '../schema.js';

const configSchema = z.object({
  sceneIntent: sceneIntentSchema.optional(),
  endpoint: z.string().optional(),
  workflow: z.string().min(1),
  workflowVersion: z.string().min(1),
  attemptKey: z.string().min(1),
  inputMap: z.record(z.string()).default({}),
  inputs: z.record(z.unknown()).default({}),
  outputPath: z.string().min(1),
  primaryOutput: z.number().int().nonnegative().default(0),
  timeoutSeconds: z.number().int().min(1).max(86400).default(1800),
});
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function inside(project: string, path: string): string {
  const rel = relative(project, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '')
    throw new Error('Media paths must be files inside the project.');
  return rel;
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
function outputTarget(project: string, output: string): string {
  const target = resolve(project, output);
  const rel = inside(project, target);
  let parent = project;
  for (const part of dirname(rel)
    .split(sep)
    .filter(part => part !== '.')) {
    parent = join(parent, part);
    try {
      mkdirSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (lstatSync(parent).isSymbolicLink())
      throw new Error('Output folders cannot be symbolic links.');
  }
  return target;
}

type Client = Pick<GpuQueueClient, 'listWorkflows' | 'submit' | 'getJob' | 'cancel'>;
export function createGpuQueueRunner(
  options: {
    clientFactory?: (endpoint: string) => Client;
    fetcher?: typeof fetch;
    pollMs?: number;
  } = {}
): Runner {
  const factory = options.clientFactory ?? (endpoint => new GpuQueueClient(endpoint));
  const fetcher = options.fetcher ?? fetch;
  return {
    describe: () => ({
      id: 'gpu.queue',
      displayName: 'Shared GPU queue',
      description:
        'Run a version-selected catalog workflow through the shared gateway with durable job recovery.',
      capabilities: ['generation', 'durable-jobs'],
      modalities: {
        input: ['text', 'image', 'video', 'audio'],
        output: ['image', 'video', 'audio'],
      },
      configSchema: {
        workflow: 'string',
        workflowVersion: 'string',
        attemptKey: 'string',
        inputMap: 'object',
        inputs: 'object',
        outputPath: 'string',
      },
      costHint: 'local_gpu',
    }),
    async run(ctx: RunnerContext) {
      let store: QueueJobs | undefined;
      let record: QueueJobRecord | undefined;
      try {
        ctx.signal?.throwIfAborted();
        const cfg = configSchema.parse(ctx.node.runner.config);
        const project = realpathSync(ctx.projectDir);
        const target = outputTarget(project, cfg.outputPath);
        const key = JSON.stringify(['gpu.queue', ctx.node.id, ctx.itemId ?? '', cfg.attemptKey]);
        store = new QueueJobs(project, factory, fetcher);
        const existing = store.find(key);
        const endpoint =
          existing?.endpoint ??
          new GpuQueueClient(cfg.endpoint ?? process.env['DHEE_GPU_QUEUE_URL'] ?? '').endpoint.href;
        const client = factory(endpoint);
        const workflow =
          existing?.workflowSnapshot ??
          (await client.listWorkflows(ctx.signal)).find(item => item.name === cfg.workflow);
        if (!workflow || workflow.name !== cfg.workflow || workflow.version !== cfg.workflowVersion)
          throw new Error(
            'Workflow version changed or is missing. Review the catalog and explicitly select the new version before rendering.'
          );
        const supplied = { ...cfg.inputs };
        for (const [name, from] of Object.entries(cfg.inputMap)) {
          if (!(from in ctx.inputs)) throw new Error(`Missing upstream input ${from} for ${name}.`);
          supplied[name] = ctx.inputs[from];
        }
        // Stable per attempt: retries never quietly roll another random seed.
        const values = validateQueueInputs(
          workflow,
          supplied,
          parseInt(digest(key).slice(0, 8), 16)
        );
        const sourceInputs = { ...values };
        const snapshots: { name: string; index?: number; bytes: Buffer; filename: string }[] = [];
        let totalBytes = 0;
        for (const [name, schema] of Object.entries(workflow.inputs)) {
          if (!(name in values) || !['file', 'file_list'].includes(String(schema.type))) continue;
          const files =
            schema.type === 'file_list' ? (values[name] as string[]) : [values[name] as string];
          const identities: unknown[] = [];
          for (const [index, file] of files.entries()) {
            ctx.signal?.throwIfAborted();
            if (/^up_[A-Za-z0-9_-]+$/.test(file)) {
              if (cfg.sceneIntent) throw new Error('Checked scene references must be local files');
              identities.push(file);
              continue;
            }
            if (/^https?:\/\//.test(file)) {
              if (cfg.sceneIntent) throw new Error('Checked scene references must be local files');
              const url = new URL(file);
              if (url.username || url.password)
                throw new Error('Reference URLs cannot embed credentials.');
              identities.push(file);
              continue;
            }
            if (file.startsWith('data:'))
              throw new Error('Save data URI references as local media files before generation.');
            const path = realpathSync(resolve(project, file));
            const localPath = inside(project, path);
            const info = await stat(path);
            if (!info.isFile() || info.size > 64 * 1024 ** 2)
              throw new Error('Each local reference must be a media file no larger than 64 MiB.');
            if (!/\.(png|jpe?g|webp|gif|mp4|mov|webm|mkv|wav|mp3|flac|ogg|m4a|aac)$/i.test(path))
              throw new Error(
                'Local references must use a supported image, video or audio extension.'
              );
            const bytes = await readFile(path);
            totalBytes += bytes.length;
            if (bytes.length > 64 * 1024 ** 2 || totalBytes > 128 * 1024 ** 2)
              throw new Error('Local references exceed the 128 MiB snapshot limit.');
            identities.push({ localPath, sha256: digest(bytes), bytes: bytes.length });
            snapshots.push({
              name,
              ...(schema.type === 'file_list' ? { index } : {}),
              bytes,
              filename: basename(path),
            });
          }
          sourceInputs[name] = schema.type === 'file_list' ? identities : identities[0];
        }
        if (cfg.sceneIntent) assertSceneIntent(cfg.sceneIntent, sourceInputs);
        record = await store.submit(
          {
            key,
            endpoint,
            workflow: cfg.workflow,
            version: cfg.workflowVersion,
            workflowSnapshot: workflow,
            inputs: sourceInputs,
          },
          ctx.signal,
          async () => {
            const wire = { ...values };
            for (const [name, value] of Object.entries(wire))
              if (Array.isArray(value)) wire[name] = [...(value as unknown[])];
            for (const file of snapshots) {
              const handle = await uploadQueueFile(
                endpoint,
                file.bytes,
                file.filename,
                ctx.signal,
                fetcher
              );
              if (file.index === undefined) wire[file.name] = handle;
              else (wire[file.name] as string[])[file.index] = handle;
            }
            return wire;
          }
        );
        if (!record.jobId)
          throw new Error(
            `Submission outcome unknown (${record.id}). Check gateway history; do not start another attempt automatically.`
          );
        ctx.log(`GPU job ${record.jobId}: ${record.phase}.`);
        const deadline = Date.now() + cfg.timeoutSeconds * 1000;
        while (record.phase !== 'downloaded') {
          ctx.signal?.throwIfAborted();
          record = await store.refresh(record.id, ctx.signal);
          const state = record.job?.state;
          ctx.log(`GPU job ${record.jobId}: ${state}.`);
          if (state === 'done') {
            record = await store.download(record.id, ctx.signal);
            break;
          }
          if (state === 'failed' || state === 'cancelled' || state === 'expired')
            throw new Error(
              `GPU job ${state}: ${typeof record.job?.['error'] === 'string' ? record.job['error'] : 'Start a new explicit attempt after resolving the cause.'}`
            );
          if (Date.now() >= deadline)
            throw new Error(
              `GPU wait timed out. Job ${record.jobId} remains saved; resume this attempt to continue tracking it.`
            );
          await delay(options.pollMs ?? 3000, undefined, { signal: ctx.signal });
        }
        const files = record.files ?? [];
        const primary = files[cfg.primaryOutput];
        if (!primary) throw new Error('The selected primary output is missing.');
        for (const file of files) {
          const path = realpathSync(resolve(project, file.path));
          inside(project, path);
          if ((await fileHash(path)) !== file.sha256)
            throw new Error(
              'A saved GPU output changed. Restore the saved artifact before resuming.'
            );
        }
        if (extname(target).toLowerCase() !== extname(primary.path).toLowerCase())
          throw new Error('Primary output format does not match the requested output path.');
        const temporary = `${target}.${randomUUID()}.part`;
        try {
          await copyFile(resolve(project, primary.path), temporary);
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
        return {
          ok: true,
          outputPath: relative(project, target),
          outputs: files
            .filter((_, index) => index !== cfg.primaryOutput)
            .map(file => ({ path: file.path, metadata: { sha256: file.sha256 } })),
          metadata: {
            queueRecordId: record.id,
            jobId: record.jobId,
            workflow: cfg.workflow,
            workflowVersion: record.version,
            seed: record.inputs['seed'],
          },
        };
      } catch (error) {
        if (ctx.signal?.aborted && record?.jobId && store && record.phase !== 'downloaded') {
          try {
            await store.cancel(record.id);
            ctx.log(`Cancellation requested for ${record.jobId}; refresh its status to confirm.`);
          } catch {
            ctx.log(`Could not confirm cancellation for ${record.jobId}. Retry it from GPU jobs.`);
          }
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
export const gpuQueueRunner = createGpuQueueRunner();
