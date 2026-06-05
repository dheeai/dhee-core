/**
 * Chat-lane usage telemetry extension (issue #102 #0).
 *
 * Drives the real recording path: fire a `message_end`-style assistant
 * message through the extension and assert a lane='chat' record lands in
 * the sink (path redirected to a temp file). Non-assistant / usage-less
 * messages must be ignored.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordChatMessageUsage,
  registerUsageTelemetry,
} from '../../src/agent/pi/usageTelemetryExtension.js';
import { readUsageRecords } from '../../src/core/llm/usageTelemetry.js';

let dir: string;
let file: string;
let prevPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-tel-ext-'));
  file = join(dir, 'llm-usage.jsonl');
  prevPath = process.env['DHEE_USAGE_TELEMETRY_PATH'];
  process.env['DHEE_USAGE_TELEMETRY_PATH'] = file;
  delete process.env['DHEE_USAGE_TELEMETRY_DISABLED'];
});

afterEach(() => {
  if (prevPath === undefined) delete process.env['DHEE_USAGE_TELEMETRY_PATH'];
  else process.env['DHEE_USAGE_TELEMETRY_PATH'] = prevPath;
  rmSync(dir, { recursive: true, force: true });
});

const assistantMessage = {
  role: 'assistant',
  model: 'deepseek/deepseek-v4-flash',
  usage: { input: 8000, output: 50, cacheRead: 4000, cacheWrite: 0, totalTokens: 8050, cost: { total: 0.0012 } },
};

describe('recordChatMessageUsage', () => {
  it('records an assistant message with usage as lane=chat, mapping pi-ai fields', () => {
    recordChatMessageUsage(assistantMessage, 'session-123');
    const recs = readUsageRecords(file);
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    expect(r.lane).toBe('chat');
    expect(r.model).toBe('deepseek/deepseek-v4-flash');
    expect(r.sessionId).toBe('session-123');
    expect(r.promptTokens).toBe(8000);
    expect(r.completionTokens).toBe(50);
    expect(r.cachedTokens).toBe(4000); // cacheRead → cachedTokens
    expect(r.costUsd).toBe(0.0012);
    expect(r.cachedRatio).toBeCloseTo(0.5, 5);
  });

  it('ignores non-assistant messages', () => {
    recordChatMessageUsage({ role: 'user', content: 'hi' });
    recordChatMessageUsage({ role: 'toolResult', toolName: 'x', content: [] });
    expect(readUsageRecords(file)).toHaveLength(0);
  });

  it('ignores assistant messages without usage', () => {
    recordChatMessageUsage({ role: 'assistant', model: 'm' });
    expect(readUsageRecords(file)).toHaveLength(0);
  });
});

describe('registerUsageTelemetry', () => {
  it('subscribes to message_end and records the assistant message usage', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const pi = {
      on(event: string, handler: (e: unknown) => void) {
        handlers[event] = handler;
      },
    };
    registerUsageTelemetry(pi as never);
    expect(typeof handlers['message_end']).toBe('function');

    handlers['message_end']!({ message: assistantMessage });
    const recs = readUsageRecords(file);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.lane).toBe('chat');
    expect(recs[0]!.promptTokens).toBe(8000);
  });
});
