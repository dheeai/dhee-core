import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  createWriteStream,
} from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { GpuQueueClient, workflowSchema, type GpuWorkflow, type GpuJob } from './gpuQueue.js';
import { lockSync } from 'proper-lockfile';

export interface QueueSubmission {
  /** Stable caller-assigned key for ONE generation attempt. Reuse to recover, never to regenerate. */
  key: string;
  endpoint: string;
  workflow: string;
  version: string;
  workflowSnapshot?: GpuWorkflow;
  inputs: Record<string, unknown>;
}
const recordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string(),
  endpoint: z.string(),
  workflow: z.string(),
  version: z.string(),
  inputs: z.record(z.unknown()),
  sourceInputs: z.record(z.unknown()).optional(),
  workflowSnapshot: workflowSchema.optional(),
  phase: z.enum(['submitting', 'unknown', 'tracked', 'downloaded']),
  createdAt: z.string(),
  updatedAt: z.string(),
  jobId: z.string().optional(),
  job: z
    .object({
      job_id: z.string(),
      state: z.enum(['queued', 'dispatching', 'running', 'done', 'failed', 'cancelled', 'expired']),
    })
    .passthrough()
    .optional(),
  cancelRequested: z.boolean().optional(),
  error: z.string().optional(),
  files: z
    .array(
      z.object({ path: z.string(), sha256: z.string(), bytes: z.number(), sourceUrl: z.string() })
    )
    .optional(),
});
export type QueueJobRecord = z.infer<typeof recordSchema>;
type Remote = Pick<GpuQueueClient, 'submit' | 'getJob' | 'cancel'>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  throw new Error('Queue inputs must be plain JSON with finite numbers.');
}

/** Project-owned job ledger. Transport failures never authorize an automatic second render. */
export class QueueJobs {
  readonly projectDir: string;
  readonly storeDir: string;
  constructor(
    projectDir: string,
    private readonly client: (endpoint: string) => Remote = endpoint =>
      new GpuQueueClient(endpoint),
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.projectDir = realpathSync(projectDir);
    this.storeDir = join(this.projectDir, '.dhee', 'gpu-queue');
    this.directory(this.storeDir);
  }
  private directory(path: string) {
    const rel = relative(this.projectDir, path);
    if (rel === '..' || rel.startsWith(`..${sep}`))
      throw new Error('Queue storage must remain inside the project.');
    let current = this.projectDir;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new Error('Queue storage cannot use symbolic links.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          mkdirSync(current);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        if (lstatSync(current).isSymbolicLink())
          throw new Error('Queue storage cannot use symbolic links.');
      }
    }
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid queue record id.');
    return join(this.storeDir, `${id}.json`);
  }
  read(id: string): QueueJobRecord {
    const record = recordSchema.parse(JSON.parse(readFileSync(this.path(id), 'utf8')));
    if (record.id !== id) throw new Error('Queue record identity does not match its file.');
    return record;
  }
  find(key: string): QueueJobRecord | undefined {
    const id = hash(key);
    return existsSync(this.path(id)) ? this.read(id) : undefined;
  }
  list(): QueueJobRecord[] {
    return readdirSync(this.storeDir)
      .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => {
        const id = name.slice(0, -5);
        try {
          return this.read(id);
        } catch {
          return {
            id,
            fingerprint: '',
            endpoint: '',
            workflow: 'Unreadable saved job',
            version: '',
            inputs: {},
            phase: 'unknown' as const,
            createdAt: '',
            updatedAt: '',
            error:
              'Unreadable queue record. Preserve this file for recovery; it has not been overwritten.',
          };
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private save(record: QueueJobRecord, exclusive = false): QueueJobRecord {
    record.updatedAt = new Date().toISOString();
    const path = this.path(record.id);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      if (exclusive) {
        // Never replace another process's intent, even if a lock lease was lost.
        const fd = openSync(path, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify(record, null, 2));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } else {
        writeFileSync(temp, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
        const fd = openSync(temp, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, path);
      }
      const dirFd = openSync(this.storeDir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } finally {
      rmSync(temp, { force: true });
    }
    return record;
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    let release: () => void;
    try {
      release = lockSync(this.storeDir, {
        realpath: true,
        retries: 0,
        stale: 60_000,
        update: 10_000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED')
        throw new Error('A queue operation is already in progress for this project.');
      throw error;
    }
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async submit(
    input: QueueSubmission,
    signal?: AbortSignal,
    prepareInputs?: () => Promise<Record<string, unknown>>
  ): Promise<QueueJobRecord> {
    signal?.throwIfAborted();
    if (!input.key || !input.workflow || !input.version)
      throw new Error('A generation key, workflow and catalog version are required.');
    const endpoint = new GpuQueueClient(input.endpoint).endpoint.href;
    const fingerprint = hash(
      canonical({
        endpoint,
        workflow: input.workflow,
        version: input.version,
        inputs: input.inputs,
      })
    );
    const id = hash(input.key);
    return this.locked(async () => {
      if (existsSync(this.path(id))) {
        const existing = this.read(id);
        if (existing.fingerprint !== fingerprint)
          throw new Error('This generation key already belongs to a different request.');
        if (existing.phase === 'submitting')
          return this.save({
            ...existing,
            phase: 'unknown',
            error:
              'Submission was interrupted. Check gateway history before starting a new attempt.',
          });
        return existing;
      }
      signal?.throwIfAborted();
      const wireInputs = prepareInputs ? await prepareInputs() : input.inputs;
      signal?.throwIfAborted();
      const record: QueueJobRecord = {
        id,
        fingerprint,
        endpoint,
        workflow: input.workflow,
        version: input.version,
        workflowSnapshot: input.workflowSnapshot,
        inputs: JSON.parse(canonical(wireInputs)) as Record<string, unknown>,
        sourceInputs: JSON.parse(canonical(input.inputs)) as Record<string, unknown>,
        phase: 'submitting',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.save(record, true); // Durable intent BEFORE contacting the queue.
      try {
        const accepted = await this.client(endpoint).submit(input.workflow, record.inputs, signal);
        record.jobId = accepted.job_id;
        record.phase = 'tracked';
      } catch (error) {
        record.phase = 'unknown';
        record.error = `Submission outcome unknown; do not resubmit automatically. ${error instanceof Error ? error.message : String(error)}`;
      }
      return this.save(record);
    });
  }
  async refresh(id: string, signal?: AbortSignal): Promise<QueueJobRecord> {
    return this.locked(async () => {
      const record = this.read(id);
      if (!record.jobId)
        throw new Error('Submission outcome is unknown. Resolve it from gateway history first.');
      const job = await this.client(record.endpoint).getJob(record.jobId, signal);
      if (job.job_id !== record.jobId) throw new Error('Gateway returned a different job id.');
      record.job = job;
      return this.save(record);
    });
  }
  async cancel(id: string, signal?: AbortSignal): Promise<QueueJobRecord> {
    return this.locked(async () => {
      const record = this.read(id);
      if (!record.jobId) throw new Error('No confirmed remote job id is available to cancel.');
      record.cancelRequested = true;
      this.save(record);
      await this.client(record.endpoint).cancel(record.jobId, signal);
      // Acknowledgement is not proof that a running render has stopped. Refresh observes terminal state.
      return record;
    });
  }
  async download(id: string, signal?: AbortSignal): Promise<QueueJobRecord> {
    return this.locked(async () => {
      const record = this.read(id);
      if (record.phase === 'downloaded') return record;
      const job = record.job as GpuJob | undefined;
      if (job?.state !== 'done' || !job.outputs?.length)
        throw new Error('The completed job has no downloadable outputs.');
      const origin = new URL(record.endpoint).origin;
      const urls = job.outputs.map(output => {
        const url = new URL(output.url);
        if (url.origin !== origin || url.username || url.password)
          throw new Error('Output URL must use the GPU gateway origin.');
        return url;
      });
      const outputDir = join(this.storeDir, id);
      this.directory(outputDir);
      const files: NonNullable<QueueJobRecord['files']> = [];
      // Invalidate prior completion before attempting to replace any local outputs.
      record.phase = 'tracked';
      record.files = undefined;
      this.save(record);
      for (const [index, url] of urls.entries()) {
        signal?.throwIfAborted();
        const extension = extname(url.pathname);
        const name = `${index}${/^\.[a-z0-9]{1,8}$/i.test(extension) ? extension : '.bin'}`;
        const target = join(outputDir, name);
        const temp = `${target}.${randomUUID()}.part`;
        const digest = createHash('sha256');
        let bytes = 0;
        const downloadSignal = AbortSignal.any([
          AbortSignal.timeout(120_000),
          ...(signal ? [signal] : []),
        ]);
        try {
          const response = await this.fetcher(url, { signal: downloadSignal, redirect: 'error' });
          if (!response.ok || !response.body)
            throw new Error(`Output download failed: HTTP ${response.status}.`);
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              if (bytes > 2 * 1024 ** 3) {
                callback(new Error('Output exceeds the 2 GiB download limit.'));
                return;
              }
              digest.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(
            Readable.fromWeb(response.body as never),
            meter,
            createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
            { signal: downloadSignal }
          );
          if (!bytes) throw new Error('Output download was empty.');
          const fd = openSync(temp, 'r');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          renameSync(temp, target);
          files.push({
            path: relative(this.projectDir, target),
            sha256: digest.digest('hex'),
            bytes,
            sourceUrl: url.href,
          });
        } finally {
          rmSync(temp, { force: true });
        }
      }
      const outputFd = openSync(outputDir, 'r');
      try {
        fsyncSync(outputFd);
      } finally {
        closeSync(outputFd);
      }
      record.files = files;
      record.phase = 'downloaded';
      return this.save(record);
    });
  }
}
