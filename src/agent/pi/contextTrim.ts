/**
 * contextTrim — bound the chat-agent's re-sent context so prompt tokens
 * stop growing monotonically over a long session (issue #102).
 *
 * The problem: pi-coding-agent re-sends the WHOLE conversation history to
 * the model every turn. Bulky tool results (a status dump, an inlined
 * artifact, a file read) stay verbatim in that history forever, so the
 * prompt (input) token count climbs with wall-clock time while output
 * stays tiny — almost all metered spend goes to re-reading accumulated
 * context. Pi's built-in auto-compaction only fires near the context
 * window (`contextWindow - reserveTokens`), so nothing bounds growth
 * below it.
 *
 * The fix: a `context`-event extension. Pi runs registered `context`
 * handlers via `transformContext` right before each LLM call — AFTER
 * compaction, BEFORE the messages are converted and sent. We transform
 * the re-sent COPY only; the persisted session JSONL and the chat UI are
 * untouched (they read from the SessionManager, not from this hook). So
 * trimming here never corrupts the transcript and is fully reversible —
 * the model just receives a leaner view each turn.
 *
 * Two tiers, both structurally safe (we only shrink text strings; we
 * never drop a message or touch a tool-call / thinking / image block, so
 * tool-call ↔ tool-result pairing stays valid):
 *
 *   Tier A — elide bulky TOOL RESULTS outside the recent window. Each
 *     old tool result over `maxToolResultChars` is replaced with a short
 *     stub that names the tool, the elided size, a preview, and how to
 *     get it back ("re-run the tool"). This kills the dominant driver.
 *
 *   Tier B — if the context is STILL over `maxContextTokens` after tier
 *     A (e.g. a giant pasted story or a huge assistant turn), elide large
 *     user/assistant/custom TEXT blocks oldest-first until under budget.
 *
 * The recent window (`keepRecentMessages`) is always preserved verbatim
 * so the agent keeps full fidelity on what it's actively working on.
 *
 * All thresholds are env-tunable; set DHEE_CONTEXT_TRIM_DISABLED to opt
 * out entirely. Set DHEE_CONTEXT_TRIM_DEBUG to log each trim's before/
 * after token estimate to stderr.
 */

import { estimateTokens, type ContextEvent, type ExtensionAPI, type ExtensionFactory } from '@mariozechner/pi-coding-agent';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ImageContent, TextContent, ToolResultMessage } from '@mariozechner/pi-ai';

/** Sentinel embedded in every stub so trimming is idempotent (we never
 *  re-elide an already-elided block). Distinctive enough not to collide
 *  with real tool output. */
export const DHEE_ELIDED_MARKER = '⟪dhee-context-elided⟫';

export interface ContextTrimOptions {
  /** The last N messages are always preserved verbatim (the agent's
   *  active working set). */
  keepRecentMessages: number;
  /** A tool result whose text content exceeds this many chars is elided
   *  (tier A) — but only outside the recent window. */
  maxToolResultChars: number;
  /** Soft ceiling (estimated tokens) for the whole context. When tier A
   *  alone doesn't get under this, tier B kicks in. Kept well below the
   *  model context window so we trim long before pi's auto-compaction. */
  maxContextTokens: number;
  /** Tier B only elides text blocks larger than this — eliding a tiny
   *  block costs more in stub text than it saves. */
  minElidableChars: number;
}

export const DEFAULT_CONTEXT_TRIM_OPTIONS: ContextTrimOptions = {
  keepRecentMessages: 30,
  maxToolResultChars: 2000,
  maxContextTokens: 48000,
  minElidableChars: 2000,
};

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function intEnv(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Resolve options from an env bag (defaults to process.env). */
export function resolveContextTrimOptions(
  env: NodeJS.ProcessEnv = process.env,
): ContextTrimOptions {
  return {
    keepRecentMessages: intEnv(env['DHEE_CONTEXT_KEEP_RECENT'], DEFAULT_CONTEXT_TRIM_OPTIONS.keepRecentMessages),
    maxToolResultChars: intEnv(env['DHEE_CONTEXT_MAX_TOOL_RESULT_CHARS'], DEFAULT_CONTEXT_TRIM_OPTIONS.maxToolResultChars),
    maxContextTokens: intEnv(env['DHEE_CONTEXT_MAX_TOKENS'], DEFAULT_CONTEXT_TRIM_OPTIONS.maxContextTokens),
    minElidableChars: intEnv(env['DHEE_CONTEXT_MIN_ELIDABLE_CHARS'], DEFAULT_CONTEXT_TRIM_OPTIONS.minElidableChars),
  };
}

function isTextBlock(b: unknown): b is TextContent {
  return (
    !!b &&
    typeof b === 'object' &&
    (b as { type?: unknown }).type === 'text' &&
    typeof (b as { text?: unknown }).text === 'string'
  );
}

/** Concatenated text of a message's content (string or block array). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const b of content) if (isTextBlock(b)) s += b.text;
  return s;
}

/** One-line preview of elided text for the stub. Kept short: the stub
 *  persists in every subsequent turn, so a long preview re-introduces the
 *  very accumulation we're trying to bound. */
function preview(text: string, n = 120): string {
  return text.slice(0, n).replace(/\s+/g, ' ').trim();
}

/** Robust per-message token estimate — falls back to a chars/4 heuristic
 *  if pi's estimator throws on an unusual message shape. */
function safeEstimate(m: AgentMessage): number {
  try {
    return estimateTokens(m);
  } catch {
    return Math.ceil(contentText((m as { content?: unknown }).content).length / 4);
  }
}

function estimateTotalTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const m of messages) total += safeEstimate(m);
  return total;
}

/** Tier A: replace a bulky tool result's text with a compact stub,
 *  preserving any image blocks and all envelope fields. */
function elideToolResult(m: ToolResultMessage): ToolResultMessage {
  const text = contentText(m.content);
  const stub: TextContent = {
    type: 'text',
    text:
      `${DHEE_ELIDED_MARKER} ${m.toolName} result (${text.length} chars) removed from context to save tokens. ` +
      `Preview: "${preview(text)}…". Re-run ${m.toolName} if you need the full output again.`,
  };
  const images: ImageContent[] = Array.isArray(m.content)
    ? (m.content.filter((b) => !isTextBlock(b)) as ImageContent[])
    : [];
  return { ...m, content: [stub, ...images] };
}

/** Tier B: replace large text blocks in a user/assistant/custom message
 *  with a short stub. Never touches tool-call, thinking, or image blocks.
 *  Returns the SAME reference unchanged if nothing qualified. */
function elideMessageText(m: AgentMessage, opts: ContextTrimOptions): AgentMessage {
  const role = (m as { role?: string }).role;
  const stubText = (origLen: number): string =>
    `${DHEE_ELIDED_MARKER} ${origLen} chars of an earlier ${role ?? 'message'} removed to save context.`;

  const content = (m as { content?: unknown }).content;

  // String content (user / custom messages).
  if (typeof content === 'string') {
    if (content.includes(DHEE_ELIDED_MARKER) || content.length <= opts.minElidableChars) return m;
    return { ...(m as object), content: stubText(content.length) } as AgentMessage;
  }

  // Block-array content.
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((b) => {
      if (!isTextBlock(b)) return b; // preserve toolCall / thinking / image
      if (b.text.includes(DHEE_ELIDED_MARKER) || b.text.length <= opts.minElidableChars) return b;
      changed = true;
      return { type: 'text', text: stubText(b.text.length) } as TextContent;
    });
    if (!changed) return m;
    return { ...(m as object), content: next } as AgentMessage;
  }

  return m;
}

/**
 * Pure transform: return a trimmed copy of the conversation suitable for
 * re-sending to the model. Never mutates the input. Idempotent — running
 * it on an already-trimmed array returns an equivalent array.
 */
export function trimContextMessages(
  messages: readonly AgentMessage[],
  optsIn?: Partial<ContextTrimOptions>,
): AgentMessage[] {
  const opts = { ...DEFAULT_CONTEXT_TRIM_OPTIONS, ...optsIn };
  if (messages.length === 0) return [...messages];

  const recentStart = Math.max(0, messages.length - opts.keepRecentMessages);

  // Tier A — bulky tool results outside the recent window.
  const out: AgentMessage[] = messages.map((m, i) => {
    if (i >= recentStart) return m;
    if ((m as { role?: string }).role !== 'toolResult') return m;
    const tr = m as ToolResultMessage;
    const text = contentText(tr.content);
    if (text.includes(DHEE_ELIDED_MARKER)) return m;
    if (text.length <= opts.maxToolResultChars) return m;
    return elideToolResult(tr);
  });

  // Tier B — if still over budget, elide large non-tool text oldest-first.
  if (estimateTotalTokens(out) > opts.maxContextTokens) {
    for (let i = 0; i < recentStart; i++) {
      if (estimateTotalTokens(out) <= opts.maxContextTokens) break;
      const m = out[i]!;
      if ((m as { role?: string }).role === 'toolResult') continue; // tier A owns these
      const elided = elideMessageText(m, opts);
      if (elided !== m) out[i] = elided;
    }
  }

  return out;
}

/**
 * Build a `context`-event extension factory bound to the given options.
 * Exported for tests + callers that want explicit config; production uses
 * the env-driven `registerContextTrim` below.
 */
export function makeContextTrimExtension(
  optsIn?: Partial<ContextTrimOptions>,
): ExtensionFactory {
  const opts = { ...DEFAULT_CONTEXT_TRIM_OPTIONS, ...optsIn };
  const debug = truthy(process.env['DHEE_CONTEXT_TRIM_DEBUG']);
  return (pi: ExtensionAPI) => {
    pi.on('context', (event: ContextEvent) => {
      const messages = trimContextMessages(event.messages, opts);
      if (debug) {
        const before = estimateTotalTokens(event.messages);
        const after = estimateTotalTokens(messages);
        if (after < before) {
          process.stderr.write(
            `[dhee context-trim] ${event.messages.length} msgs: ~${before} → ~${after} tokens (saved ~${before - after})\n`,
          );
        }
      }
      return { messages };
    });
  };
}

/**
 * Default production extension factory. Env-tunable; opt out entirely
 * with DHEE_CONTEXT_TRIM_DISABLED. Wired into the default stack in
 * buildSession.ts.
 */
export const registerContextTrim: ExtensionFactory = (pi) => {
  if (truthy(process.env['DHEE_CONTEXT_TRIM_DISABLED'])) return;
  return makeContextTrimExtension(resolveContextTrimOptions())(pi);
};
