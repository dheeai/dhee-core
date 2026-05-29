/**
 * historyReplay — translate a persisted pi-coding-agent session JSONL into
 * a HistoryData snapshot the frontend can hydrate from on resume.
 *
 * Strategy: a snapshot rather than an event stream. Replaying tool calls
 * as live events would re-trigger frontend logic (auto-open panels,
 * notification toasts) and force the reducer to re-derive state across
 * many ticks. A single SET_HISTORY action is faster, deterministic, and
 * keeps the live-event code path untouched.
 *
 * Source of truth: pi-coding-agent's `parseSessionEntries(file content)`,
 * which yields `SessionEntry[]` — message entries (user / assistant /
 * tool-result), compaction markers, custom message entries (used by the
 * media bubble extension), etc.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
  type SessionMessageEntry,
  type CustomMessageEntry,
  type CompactionEntry,
} from '@mariozechner/pi-coding-agent';
import type { HistoryChatMessage, HistoryData, HistoryToolCall } from './types.js';

interface AssistantContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
  details?: unknown;
  timestamp: number;
}

interface AssistantMessage {
  role: 'assistant';
  content: AssistantContent[];
  timestamp: number;
}

interface UserMessage {
  role: 'user';
  content: string | Array<{ type: string; text?: string }>;
  timestamp: number;
}

type Msg = AssistantMessage | UserMessage | ToolResultMessage | { role?: string; timestamp?: number };

function isMessageEntry(e: SessionEntry): e is SessionMessageEntry {
  return e.type === 'message';
}

function isCustomMessageEntry(e: SessionEntry): e is CustomMessageEntry {
  return e.type === 'custom_message';
}

function isCompactionEntry(e: SessionEntry): e is CompactionEntry {
  return e.type === 'compaction';
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(c =>
      c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
        ? String((c as { text?: unknown }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('');
}

function firstPositiveIndex(values: number[]): number {
  const positive = values.filter((value) => value >= 0);
  return positive.length > 0 ? Math.min(...positive) : -1;
}

function sanitizeLegacyWizardKickoff(text: string): string | null {
  if (!text.startsWith('Create the dhee project "')) return null;

  const storyMarker = '\nStory:\n';
  const storyStart = text.indexOf(storyMarker);
  if (storyStart < 0) return null;

  const afterStory = text.slice(storyStart + storyMarker.length);
  const storyEnd = firstPositiveIndex([
    afterStory.indexOf('\n\nPass these copied project-local reference images'),
    afterStory.indexOf('\n\nThen start the pipeline.'),
  ]);
  const story =
    (storyEnd >= 0 ? afterStory.slice(0, storyEnd) : afterStory).trim();
  if (!story) return null;

  const names = Array.from(afterStory.matchAll(/"name"\s*:\s*"([^"]+)"/g))
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));

  return [
    story,
    names.length > 0 ? `Attached: ${Array.from(new Set(names)).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function shouldHideInternalUserTask(text: string): boolean {
  return (
    /^Run the pipeline for the current project to completion\./.test(text) ||
    /^Continue running the dhee pipeline for project=/.test(text)
  );
}

function sanitizeUserHistoryText(text: string): string | null {
  if (text.startsWith('[SYSTEM EVENT]')) return null;
  const stripped = text.replace(/^\(Active project:[^)]*\)\s*/, '').trim();
  if (!stripped) return null;
  if (shouldHideInternalUserTask(stripped)) return null;
  return sanitizeLegacyWizardKickoff(stripped) ?? stripped;
}

function buildHistoryFromEntries(entries: SessionEntry[]): HistoryData {
  const messages: HistoryChatMessage[] = [];
  const toolCalls: HistoryToolCall[] = [];
  const seenToolCallIds = new Set<string>();
  let compactionCount = 0;
  let focusedProject: string | undefined;

  for (const entry of entries) {
    if (isCompactionEntry(entry)) {
      compactionCount += 1;
      messages.push({
        id: `compaction-${entry.id}`,
        type: 'system',
        content: 'Earlier conversation was summarized to free up context.',
        timestamp: Date.parse(entry.timestamp) || Date.now(),
      });
      continue;
    }

    if (isCustomMessageEntry(entry)) {
      // Media bubbles: kshana's onMedia path stores the asset payload as a
      // custom_message entry. Best-effort decode — if the shape doesn't
      // match, fall through to a plain text bubble so we don't drop it.
      const details = entry.details as
        | { kind?: 'image' | 'video'; path?: string; project?: string; source?: string }
        | undefined;
      if (details?.kind && details?.path && details?.project) {
        messages.push({
          id: `media-${entry.id}`,
          type: 'media',
          content: '',
          timestamp: Date.parse(entry.timestamp) || Date.now(),
          media: {
            kind: details.kind,
            path: details.path,
            project: details.project,
            ...(details.source ? { source: details.source } : {}),
          },
        });
        if (!focusedProject) focusedProject = details.project;
        continue;
      }
      const text = extractText(entry.content);
      if (text) {
        messages.push({
          id: `custom-${entry.id}`,
          type: 'system',
          content: text,
          timestamp: Date.parse(entry.timestamp) || Date.now(),
        });
      }
      continue;
    }

    if (!isMessageEntry(entry)) continue;
    const msg = entry.message as Msg;
    const ts = Date.parse(entry.timestamp) || Date.now();

    if (msg.role === 'user') {
      const um = msg as UserMessage;
      const text = extractText(um.content);
      // Skip synthetic supervisor/control prompts and display-scrub
      // legacy setup kickoffs so chat history reflects user prompts,
      // not internal tool-routing metadata.
      const stripped = sanitizeUserHistoryText(text);
      if (!stripped) continue;
      messages.push({
        id: `user-${entry.id}`,
        type: 'user',
        content: stripped,
        timestamp: ts,
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const am = msg as AssistantMessage;
      const textParts: string[] = [];
      for (const part of am.content ?? []) {
        if (part.type === 'text' && part.text) {
          textParts.push(part.text);
        } else if (part.type === 'toolCall' && part.id && part.name) {
          if (seenToolCallIds.has(part.id)) continue;
          seenToolCallIds.add(part.id);
          toolCalls.push({
            id: part.id,
            toolName: part.name,
            args: stringifyArgs(part.arguments),
            status: 'executing',
            startTime: ts,
            agentName: 'kshana-pi',
          });
        }
      }
      const combined = textParts.join('').trim();
      if (combined) {
        messages.push({
          id: `agent-${entry.id}`,
          type: 'agent',
          content: combined,
          timestamp: ts,
          agentName: 'kshana-pi',
        });
      }
      continue;
    }

    if (msg.role === 'toolResult') {
      const tr = msg as ToolResultMessage;
      const idx = toolCalls.findIndex(tc => tc.id === tr.toolCallId);
      if (idx === -1) continue;
      const existing = toolCalls[idx];
      if (!existing) continue;
      const text = extractText(tr.content);
      toolCalls[idx] = {
        ...existing,
        status: tr.isError ? 'error' : 'completed',
        result: { ...(typeof tr.details === 'object' && tr.details ? tr.details : {}), output: text },
        duration: ts - existing.startTime,
      };
      continue;
    }
  }

  return {
    messages,
    toolCalls,
    ...(focusedProject ? { focusedProject } : {}),
    compactionCount,
  };
}

function stringifyArgs(args: unknown): Record<string, string> | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * Read a pi-coding-agent JSONL session file and produce a HistoryData
 * snapshot for the frontend. Returns an empty snapshot if the file is
 * missing or corrupt — a resume that can't load history shouldn't
 * blow up the connect flow.
 */
export function buildHistoryFromFile(sessionFile: string): HistoryData {
  if (!existsSync(sessionFile)) {
    return { messages: [], toolCalls: [], compactionCount: 0 };
  }
  let raw: string;
  try {
    raw = readFileSync(sessionFile, 'utf8');
  } catch {
    return { messages: [], toolCalls: [], compactionCount: 0 };
  }
  let parsed: FileEntry[];
  try {
    parsed = parseSessionEntries(raw);
  } catch {
    return { messages: [], toolCalls: [], compactionCount: 0 };
  }
  const entries = parsed.filter((e): e is SessionEntry => e.type !== 'session');
  return buildHistoryFromEntries(entries);
}

export const __test = { buildHistoryFromEntries };
