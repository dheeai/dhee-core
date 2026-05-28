/**
 * runAgentTurn — shared helper that wraps a pi-coding-agent
 * `AgentSession.prompt()` call, captures text deltas + tool-call
 * starts, and returns a structured envelope. Used by both the
 * Claude-Code-driven CLI (`pnpm drive`) and the desktop's in-process
 * pi-agent integration (BUG-016 Phase 6.5).
 *
 * Tests stub the session — we don't boot a real LLM here.
 */
import { describe, expect, it, vi } from 'vitest';
import { runAgentTurn } from '../../src/agent/pi/runTurn.js';

interface ScriptedEvent {
  kind: 'text' | 'tool';
  payload: string;
}

function makeStubSession(events: ScriptedEvent[]) {
  const listeners: Array<(ev: unknown) => void> = [];
  return {
    sessionId: 'stub',
    sessionFile: '/tmp/stub.jsonl',
    subscribe(cb: (ev: unknown) => void) {
      listeners.push(cb);
      return () => {};
    },
    async prompt(_msg: string) {
      for (const ev of events) {
        if (ev.kind === 'text') {
          for (const l of listeners) {
            l({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: ev.payload },
            });
          }
        } else {
          for (const l of listeners) {
            l({ type: 'tool_execution_start', toolName: ev.payload });
          }
        }
      }
    },
    dispose() {},
  };
}

describe('runAgentTurn', () => {
  it('joins text deltas and reports each tool_execution_start by name', async () => {
    const session = makeStubSession([
      { kind: 'text', payload: 'Hello ' },
      { kind: 'tool', payload: 'dhee_get_status' },
      { kind: 'text', payload: 'world.' },
    ]);
    const out = await runAgentTurn(session as never, 'say hi');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.assistant_text).toBe('Hello world.');
      expect(out.tool_calls.map((c) => c.name)).toEqual(['dhee_get_status']);
    }
  });

  it('returns ok=false with the underlying error when prompt rejects', async () => {
    const session = {
      subscribe: () => () => {},
      async prompt() {
        throw new Error('LLM unauthorized');
      },
      dispose() {},
    };
    const out = await runAgentTurn(session as never, 'do');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/LLM unauthorized/);
  });

  it('trims trailing/leading whitespace from concatenated text', async () => {
    const session = makeStubSession([
      { kind: 'text', payload: '   ' },
      { kind: 'text', payload: 'hi' },
      { kind: 'text', payload: ' ' },
    ]);
    const out = await runAgentTurn(session as never, 'go');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.assistant_text).toBe('hi');
  });

  it('always disposes the session after the turn (success path)', async () => {
    const dispose = vi.fn();
    const session = {
      subscribe: () => () => {},
      async prompt() {},
      dispose,
    };
    await runAgentTurn(session as never, 'x');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the session after the turn (error path)', async () => {
    const dispose = vi.fn();
    const session = {
      subscribe: () => () => {},
      async prompt() {
        throw new Error('boom');
      },
      dispose,
    };
    await runAgentTurn(session as never, 'x');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('honors keepAlive=true and does NOT dispose (for the desktop in-process case where the session is long-lived)', async () => {
    const dispose = vi.fn();
    const session = {
      subscribe: () => () => {},
      async prompt() {},
      dispose,
    };
    await runAgentTurn(session as never, 'x', { keepAlive: true });
    expect(dispose).not.toHaveBeenCalled();
  });
});
