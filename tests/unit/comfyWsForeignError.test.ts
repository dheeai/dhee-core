/**
 * Regression: a foreign user's `execution_error` on ComfyUI Cloud
 * must NOT terminate our in-flight prompt as failed.
 *
 * Cloud broadcasts `execution_error` events to all subscribers on the
 * shared client websocket. The handler already filters foreign
 * `executed` and `execution_success` payloads via prompt_id (see
 * "Noir potter" comment), but `execution_error` was unfiltered —
 * any other user's job blowing up resolved every concurrent dhee
 * cloud submission as `status: error`. During the BurgerEating run
 * this surfaced as: 17/17 shots failing within ~75s of submission,
 * with the misleading message "ComfyUI job did not complete (status:
 * error)" and a foreign prompt_id in the dropped payload.
 *
 * The fix mirrors the existing execution_success guard. We test the
 * extracted `decideWsAction` pure function — exercising the actual
 * routing decision the WS message handler delegates to.
 */

import { describe, it, expect } from 'vitest';
import { decideWsAction } from '../../src/services/comfyui/wsAction.js';

const OUR = 'our-prompt-abc';
const FOREIGN = 'someone-else-xyz';

describe('decideWsAction — foreign-prompt filter on execution_error', () => {
  it('ignores execution_error from a foreign prompt_id', () => {
    const action = decideWsAction(
      { type: 'execution_error', data: { prompt_id: FOREIGN, exception_message: 'lora missing' } },
      OUR,
    );
    expect(action.kind).toBe('ignore_foreign_error');
  });

  it('treats execution_error for our prompt as finish_error', () => {
    const action = decideWsAction(
      { type: 'execution_error', data: { prompt_id: OUR, exception_message: 'real error' } },
      OUR,
    );
    expect(action.kind).toBe('finish_error');
  });

  it('treats execution_error with no prompt_id as our error (conservative)', () => {
    // Some cloud rejection paths drop the prompt_id field. Without
    // it we can't distinguish ours from theirs — fail closed (treat
    // as ours) to surface the error rather than hang forever.
    const action = decideWsAction(
      { type: 'execution_error', data: { exception_message: 'no prompt id' } },
      OUR,
    );
    expect(action.kind).toBe('finish_error');
  });
});

describe('decideWsAction — existing execution_success filter (regression-pin)', () => {
  it('ignores execution_success from a foreign prompt_id', () => {
    const action = decideWsAction(
      { type: 'execution_success', data: { prompt_id: FOREIGN } },
      OUR,
    );
    expect(action.kind).toBe('ignore_foreign_success');
  });

  it('treats execution_success for our prompt as finish_completed', () => {
    const action = decideWsAction(
      { type: 'execution_success', data: { prompt_id: OUR } },
      OUR,
    );
    expect(action.kind).toBe('finish_completed');
  });
});

describe('decideWsAction — output capture filter (regression-pin)', () => {
  it('ignores executed/output payload from a foreign prompt_id', () => {
    const action = decideWsAction(
      {
        type: 'executed',
        data: {
          prompt_id: FOREIGN,
          node: '94',
          output: { images: [{ filename: 'foreign.png', subfolder: '', type: 'output' }] },
        },
      },
      OUR,
    );
    expect(action.kind).toBe('ignore_foreign_output');
  });

  it('captures executed/output payload for our prompt', () => {
    const action = decideWsAction(
      {
        type: 'executed',
        data: {
          prompt_id: OUR,
          node: '94',
          output: { images: [{ filename: 'ours.png', subfolder: 's', type: 'output' }] },
        },
      },
      OUR,
    );
    expect(action.kind).toBe('capture_output');
    if (action.kind === 'capture_output') {
      expect(action.items).toEqual([
        { filename: 'ours.png', subfolder: 's', type: 'output', node_id: '94' },
      ]);
    }
  });
});
