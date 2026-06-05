/**
 * contextTrim — behavior tests for the chat-agent context bounding that
 * fixes issue #102 (unbounded prompt growth burns credits on the text
 * lane).
 *
 * These exercise the real transform: we build synthetic conversations,
 * run `trimContextMessages`, and assert on the OUTPUT (sizes, structure,
 * which messages were elided). No source-string matching — we drive the
 * function and check what it produces.
 *
 * The headline regression (issue done-criteria): an N-turn session must
 * keep per-turn prompt size BOUNDED — a flat ceiling, not a climb. The
 * "flat ceiling vs climb" test pins exactly that.
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import {
  trimContextMessages,
  makeContextTrimExtension,
  registerContextTrim,
  resolveContextTrimOptions,
  DEFAULT_CONTEXT_TRIM_OPTIONS,
  DHEE_ELIDED_MARKER,
  type ContextTrimOptions,
} from '../../src/agent/pi/contextTrim.js';

// ---- synthetic message builders (cast through unknown; the trimmer and
// the token estimator operate structurally) -------------------------------

let ts = 0;
function userMsg(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: ts++ } as unknown as AgentMessage;
}
function assistantToolCall(callId: string, toolName: string, text = 'calling tool'): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'toolCall', id: callId, name: toolName, arguments: {} },
    ],
    api: 'openai-completions',
    provider: 'test',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: ts++,
  } as unknown as AgentMessage;
}
function toolResult(callId: string, toolName: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: ts++,
  } as unknown as AgentMessage;
}

function msgText(m: AgentMessage): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('');
}
function totalChars(messages: readonly AgentMessage[]): number {
  return messages.reduce((n, m) => n + msgText(m).length, 0);
}
/** Mirror the trimmer's chars/4 budget proxy (string content ≈ pi's
 *  estimateTokens). Good enough to assert "under budget". */
function estTokens(messages: readonly AgentMessage[]): number {
  return Math.ceil(totalChars(messages) / 4);
}

/** Build an N-turn session: a leading user prompt, then N (assistant
 *  tool-call → bulky tool-result) round-trips. */
function buildSession(turns: number, resultChars: number): AgentMessage[] {
  const out: AgentMessage[] = [userMsg('Make me a 30s desert video.')];
  for (let i = 0; i < turns; i++) {
    const id = `call_${i}`;
    out.push(assistantToolCall(id, 'dhee_get_status'));
    out.push(toolResult(id, 'dhee_get_status', `STATUS DUMP #${i} ` + 'x'.repeat(resultChars)));
  }
  return out;
}

describe('trimContextMessages — tier A (bulky tool results)', () => {
  const opts: Partial<ContextTrimOptions> = {
    keepRecentMessages: 10,
    maxToolResultChars: 1000,
    maxContextTokens: 1_000_000, // disable tier B for this test
  };

  it('elides old bulky tool results, preserves the recent window, keeps structure intact', () => {
    const messages = buildSession(40, 8000); // 1 + 40*2 = 81 messages
    const trimmed = trimContextMessages(messages, opts);

    // No messages added or dropped — only content shrinks.
    expect(trimmed).toHaveLength(messages.length);

    // Total text collapses dramatically.
    expect(totalChars(trimmed)).toBeLessThan(totalChars(messages) / 5);

    const recentStart = messages.length - opts.keepRecentMessages!;

    // Every old bulky tool result is elided to a stub...
    for (let i = 0; i < recentStart; i++) {
      if ((messages[i] as { role?: string }).role !== 'toolResult') continue;
      const text = msgText(trimmed[i]!);
      expect(text).toContain(DHEE_ELIDED_MARKER);
      expect(text).toContain('dhee_get_status'); // names the tool to re-run
      expect(text.length).toBeLessThan(500);
    }

    // ...while recent messages are untouched (still the full 8000+ chars).
    for (let i = recentStart; i < messages.length; i++) {
      if ((messages[i] as { role?: string }).role !== 'toolResult') continue;
      expect(msgText(trimmed[i]!)).not.toContain(DHEE_ELIDED_MARKER);
      expect(msgText(trimmed[i]!).length).toBeGreaterThan(8000);
    }

    // Structural integrity: every tool result still carries its
    // toolCallId + toolName (so tool-call ↔ result pairing stays valid).
    for (let i = 0; i < trimmed.length; i++) {
      const orig = messages[i] as { role?: string; toolCallId?: string; toolName?: string };
      if (orig.role !== 'toolResult') continue;
      const t = trimmed[i] as { toolCallId?: string; toolName?: string };
      expect(t.toolCallId).toBe(orig.toolCallId);
      expect(t.toolName).toBe(orig.toolName);
    }
  });

  it('does not mutate the input array or its messages', () => {
    const messages = buildSession(20, 8000);
    const before = messages.map((m) => msgText(m));
    trimContextMessages(messages, opts);
    expect(messages.map((m) => msgText(m))).toEqual(before);
  });

  it('preserves recent messages by reference (verbatim, no copy)', () => {
    const messages = buildSession(20, 8000);
    const trimmed = trimContextMessages(messages, opts);
    const recentStart = messages.length - opts.keepRecentMessages!;
    for (let i = recentStart; i < messages.length; i++) {
      expect(trimmed[i]).toBe(messages[i]); // same object reference
    }
  });

  it('is idempotent — re-trimming an already-trimmed context is a no-op in size', () => {
    const messages = buildSession(30, 8000);
    const once = trimContextMessages(messages, opts);
    const twice = trimContextMessages(once, opts);
    expect(totalChars(twice)).toBe(totalChars(once));
    // No double-eliding: each elided stub contains the marker exactly once.
    for (const m of twice) {
      const occurrences = msgText(m).split(DHEE_ELIDED_MARKER).length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);
    }
  });

  it('leaves small tool results alone', () => {
    const messages = buildSession(40, 100); // results well under maxToolResultChars
    const trimmed = trimContextMessages(messages, opts);
    expect(totalChars(trimmed)).toBe(totalChars(messages));
    for (const m of trimmed) expect(msgText(m)).not.toContain(DHEE_ELIDED_MARKER);
  });
});

describe('trimContextMessages — flat ceiling, not a climb (issue #102 regression)', () => {
  it('makes the trimmed context climb >20× slower than the raw history it replaces', () => {
    const RESULT = 8000;
    const t50 = trimContextMessages(buildSession(50, RESULT));
    const t100 = trimContextMessages(buildSession(100, RESULT));
    const t200 = trimContextMessages(buildSession(200, RESULT));

    const raw50 = totalChars(buildSession(50, RESULT));
    const raw200 = totalChars(buildSession(200, RESULT));

    // Raw history climbs ~linearly with turns (the bug): 4× the turns ≈ 4× the size.
    expect(raw200 / raw50).toBeGreaterThan(3.5);

    // Trimmed context barely grows: an extra OLD turn adds only a small
    // reference stub, never a full result. Ratio stays near 1 (linear
    // would be ~4.0).
    expect(totalChars(t200) / totalChars(t50)).toBeLessThan(1.7);

    // The climb is gone: each additional OLD turn costs a stub (a few
    // hundred chars), not a full result (8000 chars) — a >20× gentler
    // slope. This is THE regression guard for issue #102.
    const rawPerTurn = (raw200 - raw50) / 150; // ≈ 8000+ chars/turn
    const trimmedMarginalPerTurn = (totalChars(t200) - totalChars(t100)) / 100;
    expect(trimmedMarginalPerTurn).toBeLessThan(rawPerTurn / 20);

    // Absolute saving is enormous: a long trimmed session is a small
    // fraction of the raw history it stands in for.
    expect(totalChars(t200)).toBeLessThan(raw200 / 6);
  });
});

describe('trimContextMessages — tier B (budget ceiling on huge non-tool text)', () => {
  it('elides large old user/assistant text oldest-first until under the token budget', () => {
    // Five huge old user pastes + a small recent window. Tier A doesn't
    // touch user messages, so tier B must bring this under budget.
    const huge = 'p'.repeat(60_000); // ~15k tokens each
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) messages.push(userMsg(`PASTE ${i}: ${huge}`));
    // recent window: a short exchange
    messages.push(userMsg('now summarize'));
    messages.push(assistantToolCall('c0', 'dhee_get_status', 'ok'));
    messages.push(toolResult('c0', 'dhee_get_status', 'short status'));

    const opts: Partial<ContextTrimOptions> = {
      keepRecentMessages: 3, // protect only the last short exchange
      maxToolResultChars: 1000,
      maxContextTokens: 5000,
      minElidableChars: 2000,
    };

    expect(estTokens(messages)).toBeGreaterThan(60_000); // way over budget pre-trim
    const trimmed = trimContextMessages(messages, opts);

    // Under budget after tier B (allow a little slack for the recent window).
    expect(estTokens(trimmed)).toBeLessThanOrEqual(opts.maxContextTokens! + 2000);

    // The huge old user pastes were elided to stubs.
    for (let i = 0; i < 5; i++) {
      expect(msgText(trimmed[i]!)).toContain(DHEE_ELIDED_MARKER);
      expect(msgText(trimmed[i]!).length).toBeLessThan(500);
    }

    // The recent exchange is preserved verbatim.
    const n = messages.length;
    for (let i = n - 3; i < n; i++) expect(trimmed[i]).toBe(messages[i]);
  });

  it('stops eliding once under budget (does not over-trim)', () => {
    const huge = 'p'.repeat(60_000);
    const messages: AgentMessage[] = [
      userMsg(`A: ${huge}`),
      userMsg(`B: ${huge}`),
      userMsg(`C: ${huge}`),
      userMsg('recent 1'),
      userMsg('recent 2'),
    ];
    const opts: Partial<ContextTrimOptions> = {
      keepRecentMessages: 2,
      maxContextTokens: 20_000, // one 15k-token paste fits under budget
      minElidableChars: 2000,
      maxToolResultChars: 1000,
    };
    const trimmed = trimContextMessages(messages, opts);
    // Oldest two elided; the third (C) should survive because we're under
    // budget by then.
    expect(msgText(trimmed[0]!)).toContain(DHEE_ELIDED_MARKER);
    expect(msgText(trimmed[1]!)).toContain(DHEE_ELIDED_MARKER);
    expect(msgText(trimmed[2]!)).not.toContain(DHEE_ELIDED_MARKER);
    expect(msgText(trimmed[2]!).length).toBeGreaterThan(50_000);
  });
});

describe('trimContextMessages — edge cases', () => {
  it('returns an empty array for empty input', () => {
    expect(trimContextMessages([])).toEqual([]);
  });

  it('never trims when everything fits in the recent window', () => {
    const messages = buildSession(3, 8000); // 7 messages, all "recent" under default keep=30
    const trimmed = trimContextMessages(messages);
    expect(totalChars(trimmed)).toBe(totalChars(messages));
  });
});

describe('context-trim extension registration', () => {
  function fakePi() {
    const handlers: Record<string, (event: unknown) => unknown> = {};
    return {
      handlers,
      on(event: string, handler: (event: unknown) => unknown) {
        handlers[event] = handler;
      },
    };
  }

  it('makeContextTrimExtension registers a context handler that returns trimmed messages', () => {
    const pi = fakePi();
    makeContextTrimExtension({ keepRecentMessages: 4, maxToolResultChars: 500, maxContextTokens: 1_000_000 })(
      pi as never,
    );
    expect(typeof pi.handlers['context']).toBe('function');

    const messages = buildSession(20, 8000);
    const result = pi.handlers['context']!({ type: 'context', messages }) as { messages: AgentMessage[] };
    expect(result.messages).toHaveLength(messages.length);
    expect(totalChars(result.messages)).toBeLessThan(totalChars(messages) / 3);
  });

  it('registerContextTrim is a no-op when DHEE_CONTEXT_TRIM_DISABLED is set', () => {
    const prev = process.env['DHEE_CONTEXT_TRIM_DISABLED'];
    try {
      process.env['DHEE_CONTEXT_TRIM_DISABLED'] = '1';
      const pi = fakePi();
      registerContextTrim(pi as never);
      expect(pi.handlers['context']).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['DHEE_CONTEXT_TRIM_DISABLED'];
      else process.env['DHEE_CONTEXT_TRIM_DISABLED'] = prev;
    }
  });

  it('registerContextTrim registers a handler when not disabled', () => {
    const prev = process.env['DHEE_CONTEXT_TRIM_DISABLED'];
    try {
      delete process.env['DHEE_CONTEXT_TRIM_DISABLED'];
      const pi = fakePi();
      registerContextTrim(pi as never);
      expect(typeof pi.handlers['context']).toBe('function');
    } finally {
      if (prev !== undefined) process.env['DHEE_CONTEXT_TRIM_DISABLED'] = prev;
    }
  });
});

describe('resolveContextTrimOptions', () => {
  it('falls back to defaults with an empty env', () => {
    expect(resolveContextTrimOptions({})).toEqual(DEFAULT_CONTEXT_TRIM_OPTIONS);
  });

  it('reads overrides from env', () => {
    const opts = resolveContextTrimOptions({
      DHEE_CONTEXT_KEEP_RECENT: '12',
      DHEE_CONTEXT_MAX_TOOL_RESULT_CHARS: '500',
      DHEE_CONTEXT_MAX_TOKENS: '20000',
      DHEE_CONTEXT_MIN_ELIDABLE_CHARS: '1000',
    });
    expect(opts).toEqual({
      keepRecentMessages: 12,
      maxToolResultChars: 500,
      maxContextTokens: 20000,
      minElidableChars: 1000,
    });
  });

  it('ignores malformed env values (keeps defaults)', () => {
    const opts = resolveContextTrimOptions({ DHEE_CONTEXT_KEEP_RECENT: 'banana' });
    expect(opts.keepRecentMessages).toBe(DEFAULT_CONTEXT_TRIM_OPTIONS.keepRecentMessages);
  });
});
