/**
 * ComfyUIClient.queueWorkflow / .uploadImage fetch-error enrichment.
 *
 * Pre-fix, these surfaced as bare `TypeError: fetch failed` with no
 * URL or cause string in the executor. Tests pin the new behavior:
 * the thrown Error names the method + URL + underlying cause so the
 * agent's chat error and the debug.log share a traceable identity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComfyUIClient } from '../../src/services/comfyui/ComfyUIClient.js';

const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  // Clean slate per test.
  globalThis.fetch = ORIG_FETCH;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  vi.restoreAllMocks();
});

function buildUndiciStyleError(): Error {
  // Mirrors what Node's undici fetch throws on connection-layer
  // failure. Unenumerable `cause` property carries the real reason.
  const err = new TypeError('fetch failed');
  Object.defineProperty(err, 'cause', {
    value: Object.assign(new Error('getaddrinfo ENOTFOUND cloud.example.test'), {
      code: 'ENOTFOUND',
    }),
    enumerable: false,
    writable: true,
  });
  return err;
}

describe('ComfyUIClient queueWorkflow fetch enrichment', () => {
  it('rethrows with method + URL + cause when fetch fails at the connection layer', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(buildUndiciStyleError());

    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.example.test/api',
      outputDir: '/tmp/dhee-test-out',
      timeout: 5,
      apiKey: 'test-key',
      isCloud: true,
    });

    let caught: unknown;
    try {
      await client.queueWorkflow({ nodes: [], links: [] }, 'client-1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('POST');
    expect(msg).toContain('https://cloud.example.test/api/prompt');
    expect(msg).toContain('fetch failed');
    expect(msg).toContain('ENOTFOUND');
    // The underlying cause is preserved for callers that want to
    // narrow on err.cause.code.
    const cause = (caught as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('ENOTFOUND');
  });

  it('uploadImage surfaces the same enriched error when fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(buildUndiciStyleError());

    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.example.test/api',
      outputDir: '/tmp/dhee-test-out',
      timeout: 5,
      apiKey: 'test-key',
      isCloud: true,
    });

    // Path doesn't need to exist — but uploadImage rejects before fetch
    // if the file is missing. Use a known-existing one (this test file).
    const selfPath = new URL(import.meta.url).pathname;

    let caught: unknown;
    try {
      await client.uploadImage(selfPath, 'input', true);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('POST');
    expect(msg).toContain('/upload/image');
    expect(msg).toContain('fetch failed');
    expect(msg).toContain('ENOTFOUND');
  });

  it('does not enrich when fetch succeeds (HTTP error path stays untouched)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('upstream said no', { status: 502, statusText: 'Bad Gateway' }),
    );

    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.example.test/api',
      outputDir: '/tmp/dhee-test-out',
      timeout: 5,
      apiKey: 'test-key',
      isCloud: true,
    });

    let caught: unknown;
    try {
      await client.queueWorkflow({ nodes: [], links: [] }, 'client-1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // The HTTP-error path is the existing "ComfyUI returned 502" message
    // — confirm enrichment did NOT run (no "fetch failed" / "cause:").
    expect(msg).toContain('ComfyUI returned 502');
    expect(msg).not.toContain('cause:');
  });
});
