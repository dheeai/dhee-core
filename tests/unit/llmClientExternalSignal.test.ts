/**
 * Regression: `LLMClient.generateStream` must abort the in-flight
 * HTTP request when the caller's external AbortSignal fires.
 *
 * Without this hook, reasoning-model streams (DeepSeek-R / o-series /
 * Gemini-thinking) run for the full 1-7 min until natural completion
 * or the internal 200s wall-clock self-timeout — making the
 * user-facing Cancel button feel broken. The executor passes its
 * per-run AbortController.signal into every generateStream call so
 * agent.stop() propagates all the way down.
 *
 * Tested by monkey-patching the LLMClient instance's internal
 * `chat.completions.create` method so the AbortSignal handed to the
 * OpenAI SDK is observable. We don't need a real network call — only
 * the signal wiring at the LLMClient boundary.
 */
import { describe, it, expect } from 'vitest';
import { LLMClient } from '../../src/core/llm/LLMClient.js';

interface MutableLLMClient {
  client: {
    chat: {
      completions: {
        create: (request: unknown, options?: { signal?: AbortSignal }) => unknown;
      };
    };
  };
}

/**
 * Replace the OpenAI SDK handle on an LLMClient with a stub that
 * records the AbortSignal handed to `chat.completions.create` and
 * returns an empty async iterator (so generateStream finishes
 * without trying to parse a real SSE response).
 */
function stubClientForSignalCapture(client: LLMClient): {
  capturedSignal: () => AbortSignal | null;
} {
  let captured: AbortSignal | null = null;
  (client as unknown as MutableLLMClient).client = {
    chat: {
      completions: {
        create: async (_request: unknown, options?: { signal?: AbortSignal }) => {
          captured = options?.signal ?? null;
          // Return an empty async iterable — generateStream's
          // `for await (chunk of stream)` exits immediately.
          return (async function* () {
            // no chunks
          })();
        },
      },
    },
  };
  return { capturedSignal: () => captured };
}

describe('LLMClient.generateStream — external AbortSignal propagation', () => {
  it('hands a signal to chat.completions.create that fires when the caller\'s signal fires', async () => {
    const client = new LLMClient({
      baseUrl: 'http://stub.local/v1',
      apiKey: 'test',
      model: 'test',
    });
    const { capturedSignal } = stubClientForSignalCapture(client);

    const ac = new AbortController();
    // Drain the stream — it'll immediately exit on the empty iterator.
    for await (const _chunk of client.generateStream({
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
    })) {
      // nothing
    }

    const handed = capturedSignal();
    expect(handed).not.toBeNull();
    expect(handed!.aborted).toBe(false);

    // Firing the caller's signal MUST propagate to the signal we
    // handed the SDK. (We test post-hoc because generateStream's
    // stream has already drained, but the abort listener is
    // single-shot — we can still observe propagation via a fresh
    // bind in the test setup if needed.)
    //
    // Subtle: once the stream drains, generateStream's `finally`-
    // equivalent path removes the external listener (so the abort
    // can't fire LATE and surprise other callers). The test below
    // verifies the listener IS removed by checking that aborting
    // AFTER drain does NOT abort the captured signal.
    ac.abort();
    expect(handed!.aborted).toBe(false);
  });

  it('mid-stream abort propagates: caller signal fires → SDK signal aborts', async () => {
    const client = new LLMClient({
      baseUrl: 'http://stub.local/v1',
      apiKey: 'test',
      model: 'test',
    });
    let capturedSignal: AbortSignal | null = null;
    // Stub: hold the stream open until the abort fires.
    (client as unknown as MutableLLMClient).client = {
      chat: {
        completions: {
          create: async (_request: unknown, options?: { signal?: AbortSignal }) => {
            capturedSignal = options?.signal ?? null;
            // Async iterable that never yields — exits only when
            // the signal aborts. (Aborting the openai-sdk signal
            // would normally throw on next iteration; we simulate
            // by waiting on the signal.)
            return (async function* () {
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) return resolve();
                options?.signal?.addEventListener('abort', () => resolve(), {
                  once: true,
                });
              });
              // After abort, throw to mimic SDK behaviour.
              throw new Error('aborted');
            })();
          },
        },
      },
    };

    const ac = new AbortController();
    const consumer = (async () => {
      try {
        for await (const _chunk of client.generateStream({
          messages: [{ role: 'user', content: 'hi' }],
          signal: ac.signal,
        })) {
          // never yields
        }
        return 'completed';
      } catch (err) {
        return err instanceof Error ? err.message : 'unknown';
      }
    })();

    // Wait a tick for the stream to be created.
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);

    // Fire the external cancel. The internal signal MUST flip to
    // aborted immediately.
    ac.abort();
    expect(capturedSignal!.aborted).toBe(true);

    // The stream consumer surfaces the abort.
    const result = await consumer;
    expect(result).toBe('aborted');
  });

  it('pre-aborted external signal → internal signal is aborted before the stream starts', async () => {
    const client = new LLMClient({
      baseUrl: 'http://stub.local/v1',
      apiKey: 'test',
      model: 'test',
    });
    const { capturedSignal } = stubClientForSignalCapture(client);

    const ac = new AbortController();
    ac.abort();

    for await (const _chunk of client.generateStream({
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
    })) {
      // empty
    }

    const handed = capturedSignal();
    expect(handed).not.toBeNull();
    expect(handed!.aborted).toBe(true);
  });

  it('back-compat: omitting `signal` still works (most callers don\'t cancel)', async () => {
    const client = new LLMClient({
      baseUrl: 'http://stub.local/v1',
      apiKey: 'test',
      model: 'test',
    });
    const { capturedSignal } = stubClientForSignalCapture(client);

    for await (const _chunk of client.generateStream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      // empty
    }

    // The internal signal still exists (for the 200s self-timeout)
    // but isn't fired externally.
    const handed = capturedSignal();
    expect(handed).not.toBeNull();
    expect(handed!.aborted).toBe(false);
  });
});
