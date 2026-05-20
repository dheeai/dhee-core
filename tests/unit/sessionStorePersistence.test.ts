/**
 * sessionStore + historyReplay round-trip tests.
 *
 * Exercises the persistence layer end-to-end without booting a real
 * pi-coding-agent (which would need an LLM, auth, etc):
 *  - sessionStore: record / find / mostRecent / forget / purge
 *  - historyReplay: parse a hand-crafted JSONL into HistoryData
 *
 * Avoids the project rule against grep-based tests by exercising actual
 * behavior: writing real files, reading them back, asserting on
 * structured outputs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../src/agent/pi/sessionStore.js';
import { buildHistoryFromFile } from '../../src/server/historyReplay.js';

const ENV_KEY = 'DHEE_PI_SESSIONS_DIR';
let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'kshana-session-store-'));
  process.env[ENV_KEY] = tempRoot;
});

afterEach(() => {
  delete process.env[ENV_KEY];
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe('sessionStore', () => {
  it('records and finds a session, persisting projectSlug + path', async () => {

    const slug = 'demo';
    const file = store.sessionFilePathFor('s-1', slug);
    // Pretend the JSONL exists (writing a stub is enough — findSession
    // checks existsSync).
    store.ensureProjectSessionsDir(slug);
    writeFileSync(file, '', 'utf8');

    const rec = store.recordSession('s-1', slug, file);
    expect(rec.sessionId).toBe('s-1');
    expect(rec.projectSlug).toBe(slug);
    expect(rec.sessionFile).toBe(file);

    const found = store.findSession('s-1');
    expect(found).not.toBeNull();
    expect(found!.sessionFile).toBe(file);
  });

  it('returns the most recent session for a project', async () => {

    store.ensureProjectSessionsDir('p1');
    store.ensureProjectSessionsDir('p2');
    const f1 = store.sessionFilePathFor('a', 'p1');
    const f2 = store.sessionFilePathFor('b', 'p1');
    const f3 = store.sessionFilePathFor('c', 'p2');
    for (const f of [f1, f2, f3]) writeFileSync(f, '', 'utf8');

    store.recordSession('a', 'p1', f1);
    await new Promise(r => setTimeout(r, 5));
    store.recordSession('b', 'p1', f2);
    await new Promise(r => setTimeout(r, 5));
    store.recordSession('c', 'p2', f3);

    const recent = store.mostRecentForProject('p1');
    expect(recent?.sessionId).toBe('b');

    const recentP2 = store.mostRecentForProject('p2');
    expect(recentP2?.sessionId).toBe('c');
  });

  it('reflects setSessionProject in subsequent project queries', async () => {

    store.ensureProjectSessionsDir(store.AMBIENT_PROJECT_SLUG);
    const file = store.sessionFilePathFor('s-amb', store.AMBIENT_PROJECT_SLUG);
    writeFileSync(file, '', 'utf8');
    store.recordSession('s-amb', store.AMBIENT_PROJECT_SLUG, file);

    expect(store.mostRecentForProject('chosen')).toBeNull();
    store.setSessionProject('s-amb', 'chosen');
    const recent = store.mostRecentForProject('chosen');
    expect(recent?.sessionId).toBe('s-amb');
  });

  it('forgetSession drops the index entry but keeps the file', async () => {

    store.ensureProjectSessionsDir('p');
    const file = store.sessionFilePathFor('keep', 'p');
    writeFileSync(file, 'data', 'utf8');
    store.recordSession('keep', 'p', file);

    store.forgetSession('keep');
    expect(store.findSession('keep')).toBeNull();
    expect(existsSync(file)).toBe(true);
  });

  it('purgeSessionHistory removes both index entry and JSONL', async () => {

    store.ensureProjectSessionsDir('p');
    const file = store.sessionFilePathFor('blast', 'p');
    writeFileSync(file, 'data', 'utf8');
    store.recordSession('blast', 'p', file);

    store.purgeSessionHistory('blast');
    expect(store.findSession('blast')).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('findSession returns null when the JSONL has been deleted out from under us', async () => {

    store.ensureProjectSessionsDir('p');
    const file = store.sessionFilePathFor('orphan', 'p');
    writeFileSync(file, '', 'utf8');
    store.recordSession('orphan', 'p', file);

    rmSync(file);
    expect(store.findSession('orphan')).toBeNull();
  });
});

describe('buildHistoryFromFile', () => {
  function jsonl(...lines: unknown[]): string {
    return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  }

  it('returns an empty snapshot when the file is missing', async () => {

    const out = buildHistoryFromFile(join(tempRoot, 'nope.jsonl'));
    expect(out.messages).toEqual([]);
    expect(out.toolCalls).toEqual([]);
    expect(out.compactionCount).toBe(0);
  });

  it('translates user/assistant message entries into chat bubbles', async () => {

    const file = join(tempRoot, 't1.jsonl');
    const t = '2026-05-08T10:00:00.000Z';
    writeFileSync(
      file,
      jsonl(
        { type: 'session', version: 3, id: 's', timestamp: t, cwd: tempRoot },
        {
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: t,
          message: { role: 'user', content: 'Hello there', timestamp: 1 },
        },
        {
          type: 'message',
          id: 'e2',
          parentId: 'e1',
          timestamp: t,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi! How can I help?' }],
            timestamp: 2,
          },
        },
      ),
      'utf8',
    );

    const out = buildHistoryFromFile(file);
    expect(out.messages.map((m: { type: string; content: string }) => [m.type, m.content])).toEqual([
      ['user', 'Hello there'],
      ['agent', 'Hi! How can I help?'],
    ]);
    expect(out.toolCalls).toEqual([]);
  });

  it('reconstructs tool calls + their results across message entries', async () => {

    const file = join(tempRoot, 't2.jsonl');
    const t = '2026-05-08T10:00:00.000Z';
    writeFileSync(
      file,
      jsonl(
        { type: 'session', version: 3, id: 's', timestamp: t, cwd: tempRoot },
        {
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: t,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Looking that up.' },
              {
                type: 'toolCall',
                id: 'call-42',
                name: 'kshana_list_projects',
                arguments: { filter: 'active' },
              },
            ],
            timestamp: 1,
          },
        },
        {
          type: 'message',
          id: 'e2',
          parentId: 'e1',
          timestamp: t,
          message: {
            role: 'toolResult',
            toolCallId: 'call-42',
            toolName: 'kshana_list_projects',
            content: [{ type: 'text', text: 'project-a, project-b' }],
            isError: false,
            timestamp: 2,
          },
        },
      ),
      'utf8',
    );

    const out = buildHistoryFromFile(file);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].id).toBe('call-42');
    expect(out.toolCalls[0].toolName).toBe('kshana_list_projects');
    expect(out.toolCalls[0].status).toBe('completed');
    expect(out.toolCalls[0].args).toEqual({ filter: 'active' });
    const result = out.toolCalls[0].result as { output: string };
    expect(result.output).toBe('project-a, project-b');
  });

  it('counts compaction entries and emits a system bubble for each', async () => {

    const file = join(tempRoot, 't3.jsonl');
    const t = '2026-05-08T10:00:00.000Z';
    writeFileSync(
      file,
      jsonl(
        { type: 'session', version: 3, id: 's', timestamp: t, cwd: tempRoot },
        {
          type: 'compaction',
          id: 'c1',
          parentId: null,
          timestamp: t,
          summary: 'earlier turns summarized',
          firstKeptEntryId: 'x',
          tokensBefore: 90000,
        },
      ),
      'utf8',
    );

    const out = buildHistoryFromFile(file);
    expect(out.compactionCount).toBe(1);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].type).toBe('system');
  });

  it('strips synthetic user messages (system events, project announcements)', async () => {

    const file = join(tempRoot, 't4.jsonl');
    const t = '2026-05-08T10:00:00.000Z';
    writeFileSync(
      file,
      jsonl(
        { type: 'session', version: 3, id: 's', timestamp: t, cwd: tempRoot },
        {
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: t,
          message: {
            role: 'user',
            content: '[SYSTEM EVENT] runner failed task xyz',
            timestamp: 1,
          },
        },
        {
          type: 'message',
          id: 'e2',
          parentId: 'e1',
          timestamp: t,
          message: {
            role: 'user',
            content: '(Active project: demo) tell me about this',
            timestamp: 2,
          },
        },
      ),
      'utf8',
    );

    const out = buildHistoryFromFile(file);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].content).toBe('tell me about this');
  });
});
