/**
 * EventLog — append-only JSONL event log per project.
 *
 * The SINGLE writer to the log. Walker, regen, and agent tools all
 * append through this; no other code path mutates the file. This
 * preserves the single-writer discipline that the snapshot model
 * relied on, but now per *event* rather than per *snapshot rewrite*.
 *
 * Persistence: one event per line in <projectDir>/.dhee/events.jsonl.
 * Each line is a JSON-encoded {@link DheeEvent}. `append` assigns the
 * next `seq`, generates an `id` (nanoid), stamps `ts` (informational —
 * NOT used for ordering), and writes the framed line.
 *
 * Read-side tolerance:
 *   - empty file → empty iterator
 *   - torn last line (truncated mid-write) → silently dropped
 *   - non-JSON middle lines → skipped, continue with the rest
 *
 * Ordering: events are ordered by `seq` (monotonic per project), not by
 * `ts`. Replay must be a fold over `seq` order.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { nanoid } from 'nanoid';

import type { DheeEvent, EventAppendInput, EventKind } from './events.js';
import { dheeDir, eventLogPath } from './eventLogPath.js';

export interface EventLog {
  /** Append one event; assigns seq/id/ts and persists. */
  append<K extends EventKind>(e: EventAppendInput<K>): DheeEvent<K>;
  /**
   * Iterate events in seq order. Optional filters:
   *   - branchId: only events on this branch.
   *   - sinceSeq: events with seq > sinceSeq (exclusive).
   */
  read(opts?: { branchId?: string; sinceSeq?: number }): Iterable<DheeEvent>;
  /** What the next `seq` will be on next append. */
  nextSeq(): number;
  /** Absolute path to the underlying file (useful for tests/debug). */
  filePath(): string;
}

/**
 * Open (or create on first append) an event log for a project.
 *
 * Idempotent: opening a log twice returns two independent handles that
 * see the same on-disk state. Each handle re-derives `nextSeq` from the
 * file on first call, then caches it — so within one handle, appends
 * are amortized O(1) ignoring fsync.
 */
export function openEventLog(projectDir: string): EventLog {
  const path = eventLogPath(projectDir);
  let cachedNextSeq: number | null = null;

  function deriveNextSeq(): number {
    if (!existsSync(path)) return 1;
    const raw = readFileSync(path, 'utf-8');
    if (raw.length === 0) return 1;
    let maxSeq = 0;
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      try {
        const e = JSON.parse(line) as { seq?: number };
        if (typeof e.seq === 'number' && e.seq > maxSeq) maxSeq = e.seq;
      } catch {
        // skip malformed lines — they don't contribute to seq
      }
    }
    return maxSeq + 1;
  }

  function ensureDir(): void {
    const dir = dheeDir(projectDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function nextSeq(): number {
    if (cachedNextSeq === null) cachedNextSeq = deriveNextSeq();
    return cachedNextSeq;
  }

  function append<K extends EventKind>(input: EventAppendInput<K>): DheeEvent<K> {
    ensureDir();
    const seq = nextSeq();
    const event: DheeEvent<K> = {
      seq,
      id: nanoid(),
      ts: Date.now(),
      ...input,
    } as DheeEvent<K>;
    appendFileSync(path, JSON.stringify(event) + '\n');
    cachedNextSeq = seq + 1;
    return event;
  }

  function* read(opts?: { branchId?: string; sinceSeq?: number }): Iterable<DheeEvent> {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf-8');
    if (raw.length === 0) return;
    const lines = raw.split('\n');
    // Per the design contract, torn-last-line tolerance: drop a final
    // line that doesn't end with the newline framing. The last entry of
    // `split('\n')` on a well-framed file is the trailing empty string,
    // which is naturally skipped below.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      const isLast = i === lines.length - 1 || lines.slice(i + 1).every((l) => l.length === 0);
      let event: DheeEvent;
      try {
        event = JSON.parse(line) as DheeEvent;
      } catch {
        // Torn last line OR mid-file corruption — both safe to skip.
        if (isLast) continue;
        continue;
      }
      if (typeof event.seq !== 'number') continue;
      if (opts?.branchId !== undefined && event.branchId !== opts.branchId) continue;
      if (opts?.sinceSeq !== undefined && event.seq <= opts.sinceSeq) continue;
      yield event;
    }
  }

  return { append, read, nextSeq, filePath: () => path };
}
