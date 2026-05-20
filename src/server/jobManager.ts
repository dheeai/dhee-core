/**
 * In-memory tracker for run-to executions kicked off via the HTTP
 * agent-control endpoints.
 *
 * Why in-memory: each dhee-core process is a single Node runtime,
 * and the desktop only spawns one. JobManager exists to:
 *   1) serialize one run-to per project (return 409 on a second
 *      concurrent request — same-project double-execution is the
 *      "two writers to project.json" race we want to avoid)
 *   2) expose poll-able state for clients (`GET .../run-to/:jobId`)
 *   3) wire a per-job `stop` hook so HTTP cancel can interrupt the
 *      in-process executor without the file-sentinel round-trip
 *
 * Cross-process serialization (e.g. desktop's executor + a `pnpm
 * run-to` from a dev shell) is still racy; that's by design — the
 * stop sentinel handles cancellation across process boundaries, and
 * the project.json file write is last-write-wins. Don't use both at
 * once.
 */

import { randomBytes } from 'crypto';

export interface RunTarget {
  /** Stage typeId (e.g. "shot_image") to pause after. */
  stage?: string;
  /** Full node id to pause after (e.g. "shot_image:scene_1_shot_1"). */
  nodeId?: string;
  /** When true, skip ComfyUI calls (LLM prompts only). */
  skipMedia?: boolean;
}

export interface RunFnResult {
  /** Maps to ExecutorAgent's RunResult.status. */
  status: 'completed' | 'failed' | 'cancelled' | 'paused_at_stage';
  /** Optional reason from the executor (e.g. 'paused_at_stage'). */
  stopReason?: string | null;
  /** Optional error message when status === 'failed'. */
  error?: string;
}

export type RunFn = () => Promise<RunFnResult>;

export interface StartJobOptions {
  /** What to actually run — usually wraps an ExecutorAgent.run(). */
  runFn: RunFn;
  /** Hook that cancels the in-flight run (e.g. agent.stop()). */
  stopFn?: () => void;
  /** Optional descriptor of what the run is targeting; surfaced in GET response. */
  target?: RunTarget;
}

export interface JobRecord {
  id: string;
  projectName: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  target: RunTarget;
  startedAt: number;
  finishedAt?: number;
  stopReason?: string | null;
  error?: string;
}

export class JobConflictError extends Error {
  readonly existingJobId: string;
  constructor(projectName: string, existingJobId: string) {
    super(`A run-to is already in flight for project '${projectName}' (jobId=${existingJobId}). Stop or wait first.`);
    this.name = 'JobConflictError';
    this.existingJobId = existingJobId;
  }
}

interface InternalEntry {
  record: JobRecord;
  /** Monotonic per-process insertion order — used to tie-break when
   *  Date.now() returns the same ms for back-to-back starts. */
  seq: number;
  stopFn?: () => void;
  /** Resolves when the run terminates (success, failure, or cancel). */
  finished: Promise<void>;
}

export class JobManager {
  private byId = new Map<string, InternalEntry>();
  private runningByProject = new Map<string, string>();
  private nextSeq = 0;

  /**
   * Kick off a run for a project. Throws JobConflictError if a run
   * is already in flight for that project. Returns the new job
   * record (initially `status='running'`); poll `get(id)` later for
   * terminal state.
   */
  start(projectName: string, options: StartJobOptions): JobRecord {
    const existing = this.runningByProject.get(projectName);
    if (existing) throw new JobConflictError(projectName, existing);

    const id = `job_${randomBytes(6).toString('hex')}`;
    const record: JobRecord = {
      id,
      projectName,
      status: 'running',
      target: options.target ?? {},
      startedAt: Date.now(),
    };

    const finished = (async () => {
      try {
        const result = await options.runFn();
        record.status = (result.status === 'completed' || result.status === 'paused_at_stage')
          ? 'completed'
          : result.status === 'cancelled' ? 'cancelled' : 'failed';
        record.stopReason = result.stopReason ?? null;
        if (result.error) record.error = result.error;
      } catch (err) {
        record.status = 'failed';
        record.error = err instanceof Error ? err.message : String(err);
      } finally {
        record.finishedAt = Date.now();
        if (this.runningByProject.get(projectName) === id) {
          this.runningByProject.delete(projectName);
        }
      }
    })();

    this.byId.set(id, {
      record,
      finished,
      seq: this.nextSeq++,
      ...(options.stopFn ? { stopFn: options.stopFn } : {}),
    });
    this.runningByProject.set(projectName, id);
    return { ...record };
  }

  /** Get a snapshot of a job by id. Returns null for unknown ids. */
  get(jobId: string): JobRecord | null {
    const entry = this.byId.get(jobId);
    return entry ? { ...entry.record } : null;
  }

  /** Most-recently-started job for a given project, or null. */
  latestForProject(projectName: string): JobRecord | null {
    let latest: InternalEntry | null = null;
    for (const entry of this.byId.values()) {
      if (entry.record.projectName !== projectName) continue;
      if (!latest || entry.seq > latest.seq) latest = entry;
    }
    return latest ? { ...latest.record } : null;
  }

  /**
   * All known jobs sorted newest-first. Useful for `GET /jobs`.
   */
  listAll(): JobRecord[] {
    return Array.from(this.byId.values())
      .sort((a, b) => b.seq - a.seq)
      .map(e => ({ ...e.record }));
  }

  /**
   * Invoke the per-job stop hook so an in-flight run can be
   * interrupted in-process. No-op if the job is already finished
   * or has no stop hook. The hook should arrange for `runFn` to
   * resolve/reject promptly; status transitions happen as runFn
   * settles.
   */
  cancel(jobId: string): void {
    const entry = this.byId.get(jobId);
    if (!entry) return;
    if (entry.record.status !== 'running') return;
    entry.stopFn?.();
  }

  /**
   * Wait for a job's run to terminate. Resolves regardless of
   * success/failure (read `status` after). Useful in tests to
   * deterministically observe terminal state without busy-polling.
   */
  async waitForCompletion(jobId: string): Promise<void> {
    const entry = this.byId.get(jobId);
    if (!entry) return;
    await entry.finished;
  }
}
