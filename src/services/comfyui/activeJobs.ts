/**
 * Process-singleton registry of in-flight ComfyUI prompts.
 *
 * Why this exists: when the user clicks "Cancel", BackgroundTaskRunner
 * aborts the local pipeline immediately — but the ComfyUI workflow it
 * submitted keeps running on the GPU until it completes naturally,
 * burning paid Cloud credits the user thinks they reclaimed. The
 * `POST /interrupt` endpoint stops it, but only if someone calls it
 * with the right client.
 *
 * The provider layer creates a fresh `ComfyUIClient` per generation
 * call, so there's no single object the cancel path can address. This
 * module tracks the live ones in a process-global Set. Each entry is a
 * cancellable handle bundling the client + its prompt_id, so the
 * cancel path can iterate and fire `POST /interrupt` against every
 * provider currently waiting on output.
 *
 * Contract:
 *   - `registerActiveJob(handle)` runs immediately after a successful
 *     `queueWorkflow()` returns a prompt_id.
 *   - `unregisterActiveJob(handle)` runs in a `finally` after
 *     completion, failure, or interrupt — guaranteed cleanup.
 *   - `cancelAllActiveJobs()` calls `interrupt()` on each handle and
 *     clears the set. Safe to call when nothing is in flight.
 *
 * Best-effort by design: interrupt failures (Comfy unreachable, prompt
 * already finished, etc.) are swallowed. Caller already initiated a
 * cancel; further error noise is unhelpful.
 */

export interface CancellableComfyJob {
  /** ComfyUI prompt_id assigned by the server. */
  promptId: string;
  /** Calls POST /interrupt for the right server URL. */
  interrupt: () => Promise<void>;
  /**
   * Calls POST /queue with {"clear": true} for the right server URL.
   * `/interrupt` ONLY stops the prompt currently executing on the GPU
   * — pending prompts in the queue keep running one after another.
   * `clearQueue()` drains that pending queue. Cancel paths call both:
   * interrupt to stop what's running NOW, clearQueue to make sure
   * nothing else starts.
   */
  clearQueue: () => Promise<void>;
  /**
   * Stable key for the Comfy server this job lives on (e.g. base
   * URL). Used by `cancelAllActiveJobs` to deduplicate `clearQueue`
   * calls — many jobs from the same batch share one Comfy server,
   * and clearing the queue once per server is correct + fast.
   */
  serverKey: string;
  /**
   * Wakes any wait-for-completion loop (poll OR websocket) that's
   * watching this job — set by the registrant; signalled by
   * `cancelAllActiveJobs`. Without this, the cancel path could fire
   * `/interrupt` to the GPU but the wait loop would keep polling for
   * up to a 10-second cycle before noticing, holding the runner
   * task "running" and the UI "Stopping…" for the entire window.
   * The 2026-05-19 Soft Seinen stuck-Stopping incident was exactly
   * this: GPU released but poll loop never aborted.
   */
  abortController: AbortController;
}

const activeJobs = new Set<CancellableComfyJob>();

export function registerActiveJob(job: CancellableComfyJob): void {
  activeJobs.add(job);
}

export function unregisterActiveJob(job: CancellableComfyJob): void {
  activeJobs.delete(job);
}

/**
 * Fire `interrupt()` on every currently-registered job and clear the
 * set. Returns the number of jobs that had `interrupt()` issued.
 * Errors from individual interrupts are swallowed — cancel paths
 * must not throw.
 *
 * Order matters: signal the AbortController FIRST so the wait loop
 * wakes immediately, then call interrupt() best-effort to release
 * the GPU. If we did interrupt first and it stalled the network
 * call (zrok tunnel hiccup, slow cloud), the wait loop would still
 * be polling — the abort signal is the fast path; the GPU release
 * is the polite cleanup.
 */
export async function cancelAllActiveJobs(): Promise<number> {
  const snapshot = Array.from(activeJobs);
  activeJobs.clear();
  // STEP 1 (synchronous, no awaits): abort every wait loop's controller.
  // This is what actually makes the cancel instantaneous — once these
  // signals fire, the executor's awaits unblock and the runner can
  // wind down without waiting for any HTTP round-trip.
  for (const job of snapshot) {
    try {
      job.abortController.abort();
    } catch {
      // Already aborted, etc. — swallow.
    }
  }
  // STEP 2 (HTTP cleanup against Comfy):
  //   - `interrupt()`  → POST /interrupt, stops the prompt currently
  //                       executing on the GPU.
  //   - `clearQueue()` → POST /queue {clear:true}, drains every PENDING
  //                       prompt this server still has queued. CLOUD MODE
  //                       no-ops this — the queue is shared with other
  //                       tenants, see ComfyUIClient.clearQueue() for
  //                       why.
  // Both are best-effort cleanup against the GPU. The cancel ALREADY
  // completed (step 1) — these HTTP calls just release cloud credits /
  // free up local GPU for the next run, they don't gate the cancel.
  //
  // FIRE-AND-FORGET (kicked off, NOT awaited): the user explicitly
  // wants cancels to be instant in cloud mode where the /interrupt
  // round-trip can take a few seconds. Awaiting it here made
  // `cancel()` callers (BackgroundTaskRunner, ChatPanelEmbedded
  // Stop, agent's dhee_task_cancel) wait for cloud HTTP to settle
  // before reporting cancellation — and during that window the UI
  // is in limbo. Now: signal flips instantly, GPU cleanup happens
  // in the background.
  const uniqueServers = new Map<string, () => Promise<void>>();
  for (const job of snapshot) {
    if (!uniqueServers.has(job.serverKey)) {
      uniqueServers.set(job.serverKey, job.clearQueue);
    }
  }
  void Promise.allSettled([
    ...snapshot.map((job) => job.interrupt()),
    ...Array.from(uniqueServers.values()).map((fn) => fn()),
  ]);
  return snapshot.length;
}

/** Visible for testing. */
export function getActiveJobCount(): number {
  return activeJobs.size;
}

/** Visible for testing. Resets internal state. */
export function _resetActiveJobsForTest(): void {
  activeJobs.clear();
}
