/**
 * ComfyUIClient.waitForCompletion honors a caller-supplied AbortSignal.
 *
 * The 2026-06-03 stop_run gap: queueAndWaitWS's HTTP-polling fallback
 * called waitForCompletion WITHOUT forwarding options.signal, so an
 * abort that landed during the WS→HTTP transition was lost (the WS
 * abortHandler is disabled once resolved=true, and the job may not yet
 * be in the activeJobs registry cancelAllActiveJobs() fires). The fix
 * threads an externalSignal into waitForCompletion, linked to the
 * internal abort controller the poll loop already honors.
 *
 * This exercises the real method: a pre-aborted external signal makes
 * waitForCompletion return `cancelled` immediately, with no network call
 * — the poll loop checks abort at its top, before fetching. (If the
 * signal were ignored, this would hang on / hit the network instead.)
 */
import { describe, it, expect } from 'vitest';
import { ComfyUIClient } from '../../src/services/comfyui/ComfyUIClient.js';

describe('waitForCompletion external signal', () => {
  it('returns cancelled immediately when the external signal is already aborted', async () => {
    // Non-cloud base URL → no cloud API-key requirement. The abort
    // short-circuits the poll before any request is made, so the
    // unroutable address is never contacted.
    const c = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:9' });
    const ac = new AbortController();
    ac.abort();

    const result = await c.waitForCompletion('prompt-xyz', undefined, undefined, ac.signal);

    expect(result.status).toBe('cancelled');
    expect(result.prompt_id).toBe('prompt-xyz');
  });
});
