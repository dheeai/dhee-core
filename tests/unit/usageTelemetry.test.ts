/**
 * usageTelemetry — the per-call LLM usage sink + summary (issue #102 #0).
 *
 * Exercises real behavior: write records via recordLlmUsage, read them
 * back, and aggregate with summarizeUsage. The path is redirected to a
 * temp file via DHEE_USAGE_TELEMETRY_PATH so tests never touch logs/.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordLlmUsage,
  readUsageRecords,
  summarizeUsage,
  usageTelemetryPath,
} from '../../src/core/llm/usageTelemetry.js';

let dir: string;
let file: string;
const ENV_PATH = 'DHEE_USAGE_TELEMETRY_PATH';
const ENV_OFF = 'DHEE_USAGE_TELEMETRY_DISABLED';
let prevPath: string | undefined;
let prevOff: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-tel-'));
  file = join(dir, 'llm-usage.jsonl');
  prevPath = process.env[ENV_PATH];
  prevOff = process.env[ENV_OFF];
  process.env[ENV_PATH] = file;
  delete process.env[ENV_OFF];
});

afterEach(() => {
  if (prevPath === undefined) delete process.env[ENV_PATH];
  else process.env[ENV_PATH] = prevPath;
  if (prevOff === undefined) delete process.env[ENV_OFF];
  else process.env[ENV_OFF] = prevOff;
  rmSync(dir, { recursive: true, force: true });
});

describe('recordLlmUsage / readUsageRecords', () => {
  it('round-trips a record and derives ts + cachedRatio', () => {
    recordLlmUsage({
      lane: 'walker',
      model: 'deepseek/deepseek-v4-flash',
      nodeId: 'shot_image_prompt',
      itemId: 'scene_1_shot_2',
      promptTokens: 5000,
      cachedTokens: 4800,
      completionTokens: 100,
      totalTokens: 5100,
      costUsd: 0.0002,
    });
    const recs = readUsageRecords(file);
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    expect(r.lane).toBe('walker');
    expect(r.nodeId).toBe('shot_image_prompt');
    expect(r.itemId).toBe('scene_1_shot_2');
    expect(r.cachedRatio).toBeCloseTo(0.96, 5);
    expect(typeof r.ts).toBe('number');
    expect(r.ts).toBeGreaterThan(0);
    expect(r.costUsd).toBe(0.0002);
  });

  it('appends across calls (one line per call)', () => {
    recordLlmUsage({ lane: 'walker', model: 'm', promptTokens: 10, cachedTokens: 0, completionTokens: 5, totalTokens: 15 });
    recordLlmUsage({ lane: 'walker', model: 'm', promptTokens: 20, cachedTokens: 10, completionTokens: 5, totalTokens: 25 });
    expect(readUsageRecords(file)).toHaveLength(2);
  });

  it('cachedRatio is 0 when there are no prompt tokens', () => {
    recordLlmUsage({ lane: 'chat', model: 'm', promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(readUsageRecords(file)[0]!.cachedRatio).toBe(0);
  });

  it('is a no-op when telemetry is disabled', () => {
    process.env[ENV_OFF] = '1';
    recordLlmUsage({ lane: 'walker', model: 'm', promptTokens: 10, cachedTokens: 0, completionTokens: 1, totalTokens: 11 });
    expect(readUsageRecords(file)).toHaveLength(0);
  });

  it('never throws on an unwritable path (best-effort)', () => {
    process.env[ENV_PATH] = '/this/path/does/not/exist/and/cannot/be/made/\0/x';
    expect(() =>
      recordLlmUsage({ lane: 'walker', model: 'm', promptTokens: 1, cachedTokens: 0, completionTokens: 1, totalTokens: 2 }),
    ).not.toThrow();
  });

  it('skips malformed lines when reading', () => {
    writeFileSync(file, '{"lane":"walker","model":"m","promptTokens":1,"cachedTokens":0,"completionTokens":1,"totalTokens":2,"ts":1,"cachedRatio":0}\nNOT JSON\n\n');
    expect(readUsageRecords(file)).toHaveLength(1);
  });

  it('resolves the path from DHEE_USAGE_TELEMETRY_PATH', () => {
    expect(usageTelemetryPath()).toBe(file);
  });
});

describe('summarizeUsage', () => {
  it('splits totals by lane and computes cached + input:output ratios', () => {
    const records = [
      { ts: 1, lane: 'walker', model: 'm', promptTokens: 1000, cachedTokens: 900, completionTokens: 100, totalTokens: 1100, cachedRatio: 0.9 },
      { ts: 2, lane: 'walker', model: 'm', promptTokens: 1000, cachedTokens: 800, completionTokens: 100, totalTokens: 1100, cachedRatio: 0.8 },
      { ts: 3, lane: 'chat', model: 'm', promptTokens: 8000, cachedTokens: 4000, completionTokens: 50, totalTokens: 8050, cachedRatio: 0.5 },
    ];
    const s = summarizeUsage(records);

    expect(s.byLane['walker']!.calls).toBe(2);
    expect(s.byLane['walker']!.promptTokens).toBe(2000);
    expect(s.byLane['walker']!.cachedTokens).toBe(1700);
    expect(s.byLane['walker']!.cachedRatio).toBeCloseTo(0.85, 5);
    expect(s.byLane['walker']!.inputOutputRatio).toBeCloseTo(10, 5); // 2000/200

    expect(s.byLane['chat']!.calls).toBe(1);
    expect(s.byLane['chat']!.inputOutputRatio).toBeCloseTo(160, 5); // 8000/50 — the #102 symptom
    expect(s.byLane['chat']!.cachedRatio).toBeCloseTo(0.5, 5);

    expect(s.overall.calls).toBe(3);
    expect(s.overall.promptTokens).toBe(10000);
    expect(s.overall.cachedTokens).toBe(5700);
    expect(s.overall.cachedRatio).toBeCloseTo(0.57, 5);
  });

  it('reports Infinity input:output ratio when a lane produced no output', () => {
    const s = summarizeUsage([
      { ts: 1, lane: 'walker', model: 'm', promptTokens: 100, cachedTokens: 0, completionTokens: 0, totalTokens: 100, cachedRatio: 0 },
    ]);
    expect(s.byLane['walker']!.inputOutputRatio).toBe(Infinity);
  });

  it('returns an empty overall for no records', () => {
    const s = summarizeUsage([]);
    expect(s.overall.calls).toBe(0);
    expect(Object.keys(s.byLane)).toHaveLength(0);
  });
});
