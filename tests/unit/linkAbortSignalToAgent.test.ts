/**
 * Tests for `linkAbortSignalToAgent`.
 *
 * Background: runExecutor wires an AbortSignal → ExecutorAgent.stop().
 * The mechanics (already-aborted → fire immediately; not-yet-aborted →
 * register listener; cleanup on completion) are easy to get subtly
 * wrong — listener leaks, missed-already-aborted edge, etc.
 *
 * Extracted as a pure function so it can be tested without spinning
 * up a real ExecutorAgent + LLMClient.
 */
import { describe, it, expect, vi } from 'vitest';
import { linkAbortSignalToAgent } from '../../src/server/runners/linkAbortSignalToAgent.js';

describe('linkAbortSignalToAgent', () => {
  it('does nothing when signal is undefined', () => {
    const stopFn = vi.fn();
    const cleanup = linkAbortSignalToAgent(undefined, stopFn);
    expect(stopFn).not.toHaveBeenCalled();
    cleanup(); // safe to call
  });

  it('fires stopFn immediately when the signal is already aborted', () => {
    const ac = new AbortController();
    ac.abort();
    const stopFn = vi.fn();
    linkAbortSignalToAgent(ac.signal, stopFn);
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  it('registers a listener that fires stopFn on later abort', () => {
    const ac = new AbortController();
    const stopFn = vi.fn();
    linkAbortSignalToAgent(ac.signal, stopFn);
    expect(stopFn).not.toHaveBeenCalled();
    ac.abort();
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  it('cleanup() removes the listener so a later abort does NOT call stopFn', () => {
    const ac = new AbortController();
    const stopFn = vi.fn();
    const cleanup = linkAbortSignalToAgent(ac.signal, stopFn);
    cleanup();
    ac.abort();
    expect(stopFn).not.toHaveBeenCalled();
  });

  it('cleanup() is idempotent — calling it twice does not throw', () => {
    const ac = new AbortController();
    const stopFn = vi.fn();
    const cleanup = linkAbortSignalToAgent(ac.signal, stopFn);
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });

  it('cleanup() after already-aborted path is a no-op', () => {
    const ac = new AbortController();
    ac.abort();
    const stopFn = vi.fn();
    const cleanup = linkAbortSignalToAgent(ac.signal, stopFn);
    expect(() => cleanup()).not.toThrow();
    expect(stopFn).toHaveBeenCalledTimes(1); // not called again
  });

  it('multiple aborts only fire stopFn once (browser AbortSignal de-dup behavior)', () => {
    const ac = new AbortController();
    const stopFn = vi.fn();
    linkAbortSignalToAgent(ac.signal, stopFn);
    ac.abort();
    ac.abort(); // re-aborting is a no-op
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  // Bug 17: deleteSession() calls abortController.abort('shutdown').
  // linkAbortSignalToAgent should extract that and pass it as a reason so
  // the executor can tag failed nodes with the shutdown origin.
  it('passes "shutdown" to stopFn when controller aborts with that reason', () => {
    const ac = new AbortController();
    const stopFn = vi.fn();
    linkAbortSignalToAgent(ac.signal, stopFn);
    ac.abort('shutdown');
    expect(stopFn).toHaveBeenCalledWith('shutdown');
  });

  it('passes "user" to stopFn when no reason is provided (backward compat)', () => {
    const ac = new AbortController();
    const stopFn = vi.fn();
    linkAbortSignalToAgent(ac.signal, stopFn);
    ac.abort();
    expect(stopFn).toHaveBeenCalledWith('user');
  });

  it('passes "user" to stopFn for an unrecognized reason payload', () => {
    const ac = new AbortController();
    const stopFn = vi.fn();
    linkAbortSignalToAgent(ac.signal, stopFn);
    ac.abort('some other reason');
    expect(stopFn).toHaveBeenCalledWith('user');
  });
});
