/**
 * Tests for `retryOnEmptyLLMResponse` (Bug 13).
 *
 * Contract:
 *   - Non-empty first response → returned as-is, no retry.
 *   - Empty first response → retry exactly once; return whatever the retry
 *     yields (empty or not). Downstream empty-content guard hard-fails when
 *     both attempts come back empty.
 *   - Whitespace-only response (newlines, tabs only) counts as empty.
 */
import { describe, it, expect, vi } from 'vitest';
import { retryOnEmptyLLMResponse } from '../../src/core/planner/retryOnEmptyLLMResponse.js';

describe('retryOnEmptyLLMResponse', () => {
  it('returns first response as-is when non-empty', async () => {
    const generate = vi.fn().mockResolvedValue('hello world');
    const result = await retryOnEmptyLLMResponse(generate);
    expect(result).toBe('hello world');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once when first response is empty', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('recovered on retry');
    const result = await retryOnEmptyLLMResponse(generate);
    expect(result).toBe('recovered on retry');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('returns the retry result even if still empty (downstream guard handles failure)', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    const result = await retryOnEmptyLLMResponse(generate);
    expect(result).toBe('');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('treats whitespace-only first response as empty and retries', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('   \n\t\n  ')
      .mockResolvedValueOnce('content this time');
    const result = await retryOnEmptyLLMResponse(generate);
    expect(result).toBe('content this time');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('invokes log + onRetry hooks before the retry attempt', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('ok');
    const log = vi.fn();
    const onRetry = vi.fn();

    await retryOnEmptyLLMResponse(generate, { log, onRetry });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Empty LLM response'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke hooks when first response is already good', async () => {
    const generate = vi.fn().mockResolvedValue('first-shot success');
    const log = vi.fn();
    const onRetry = vi.fn();

    await retryOnEmptyLLMResponse(generate, { log, onRetry });

    expect(log).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not retry more than once even if pattern repeats indefinitely', async () => {
    const generate = vi.fn().mockResolvedValue('');
    await retryOnEmptyLLMResponse(generate);
    expect(generate).toHaveBeenCalledTimes(2); // never 3+
  });
});
