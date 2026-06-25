/**
 * drive.ts CLI handler tests.
 *
 * Pi session boot is stubbed (returning a fake session that emits a
 * scripted event stream) so we can verify CLI semantics — index
 * persistence, error paths, transcript-event capture — without
 * needing an LLM key.
 *
 * The live "does it actually talk to a model" smoke is gated on
 * provider creds and lives separately under tests/e2e/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriveDeps } from '../../src/agent/pi/drive.js';
import { cmdList, cmdSend, cmdStart, DRIVE_PROJECT_SLUG } from '../../src/agent/pi/drive.js';
import * as store from '../../src/agent/pi/sessionStore.js';

const ENV_KEY = 'DHEE_PI_SESSIONS_DIR';
let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'dhee-drive-cli-'));
  process.env[ENV_KEY] = tempRoot;
});

afterEach(() => {
  delete process.env[ENV_KEY];
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * Build a stub DriveDeps where `buildSession` returns a fake session
 * configurable per-test. The fake session writes a minimal JSONL header
 * on construction (so SessionManager.open() at the next send sees a
 * valid file).
 */
function stubDeps(opts: {
  sessionIdFromBuild: string;
  sessionFileFromBuild: string;
  promptEvents?: Array<{ kind: 'text' | 'tool'; payload: string }>;
}): DriveDeps {
  return {
    async buildSession({ sessionManager: _sm }) {
      // Write a stub JSONL so the path on disk is realistic for the
      // "start created a file" assertions and so a subsequent
      // SessionManager.open() wouldn't blow up.
      writeFileSync(
        opts.sessionFileFromBuild,
        JSON.stringify({ type: 'session', id: opts.sessionIdFromBuild }) + '\n',
        'utf8',
      );
      const listeners: Array<(ev: unknown) => void> = [];
      return {
        session: {
          sessionId: opts.sessionIdFromBuild,
          sessionFile: opts.sessionFileFromBuild,
          subscribe(listener: (ev: unknown) => void) {
            listeners.push(listener);
            return () => {};
          },
          async prompt(_: string) {
            for (const ev of opts.promptEvents ?? []) {
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
        },
      } as never;
    },
  };
}

describe('drive.cmdStart', () => {
  it('creates a fresh session, records it in the store, returns its id + file', async () => {
    const sid = 'pi-test-id-123';
    const sfile = join(tempRoot, DRIVE_PROJECT_SLUG, `${sid}.jsonl`);
    const deps = stubDeps({ sessionIdFromBuild: sid, sessionFileFromBuild: sfile });

    const out = await cmdStart(deps);

    expect(out.ok).toBe(true);
    expect(out.sessionId).toBe(sid);
    expect(out.sessionFile).toBe(sfile);
    expect(out.projectSlug).toBe(DRIVE_PROJECT_SLUG);
    expect(existsSync(sfile)).toBe(true);

    const rec = store.findSession(sid);
    expect(rec).not.toBeNull();
    expect(rec!.sessionFile).toBe(sfile);
    expect(rec!.projectSlug).toBe(DRIVE_PROJECT_SLUG);
  });
});

describe('drive.cmdSend', () => {
  it('errors clearly when the sessionId is not in the store', async () => {
    const deps = stubDeps({
      sessionIdFromBuild: 'unused',
      sessionFileFromBuild: join(tempRoot, 'unused.jsonl'),
    });

    const out = await cmdSend('does-not-exist', 'hello', deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown session/i);
  });

  it('captures assistant_text deltas and tool_calls across the prompt', async () => {
    const sid = 'pi-test-id-send';
    const sfile = join(tempRoot, DRIVE_PROJECT_SLUG, `${sid}.jsonl`);

    // 1. Start the session so it lives in the store.
    await cmdStart(stubDeps({ sessionIdFromBuild: sid, sessionFileFromBuild: sfile }));

    // 2. Send. Script: one text chunk, one tool call, more text.
    const sendDeps = stubDeps({
      sessionIdFromBuild: sid,
      sessionFileFromBuild: sfile,
      promptEvents: [
        { kind: 'text', payload: 'Hello ' },
        { kind: 'tool', payload: 'dhee_start_run' },
        { kind: 'text', payload: 'world.' },
      ],
    });

    const out = await cmdSend(sid, 'do the thing', sendDeps);

    expect(out.ok).toBe(true);
    expect(out.sessionId).toBe(sid);
    expect(out.assistant_text).toBe('Hello world.');
    expect(out.tool_calls.map((c) => c.name)).toEqual(['dhee_start_run']);
  });
});

describe('drive.cmdList', () => {
  it('returns sessions previously recorded via start', async () => {
    const sid1 = 'pi-list-a';
    const sid2 = 'pi-list-b';
    const f1 = join(tempRoot, DRIVE_PROJECT_SLUG, `${sid1}.jsonl`);
    const f2 = join(tempRoot, DRIVE_PROJECT_SLUG, `${sid2}.jsonl`);
    await cmdStart(stubDeps({ sessionIdFromBuild: sid1, sessionFileFromBuild: f1 }));
    await cmdStart(stubDeps({ sessionIdFromBuild: sid2, sessionFileFromBuild: f2 }));

    const out = await cmdList();
    expect(out.ok).toBe(true);
    const ids = out.sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual([sid1, sid2].sort());
  });
});

/**
 * Sanity check: cmdSend touches lastActivity on the store record. A
 * future "drive list --recent" UX depends on this.
 */
describe('drive.cmdSend touches lastActivity', () => {
  it('bumps the store record so list shows it most-recently', async () => {
    const sid = 'pi-touch';
    const sfile = join(tempRoot, DRIVE_PROJECT_SLUG, `${sid}.jsonl`);
    await cmdStart(stubDeps({ sessionIdFromBuild: sid, sessionFileFromBuild: sfile }));

    const before = store.findSession(sid)!.lastActivity;
    // Spin off a small wall-clock delta so the comparison is meaningful.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(before + 1000));

    await cmdSend(
      sid,
      'tap',
      stubDeps({ sessionIdFromBuild: sid, sessionFileFromBuild: sfile, promptEvents: [{ kind: 'text', payload: 'k' }] }),
    );

    const after = store.findSession(sid)!.lastActivity;
    expect(after).toBeGreaterThan(before);

    vi.useRealTimers();
  });
});

// Wallpaper: ensure readFileSync above is wired so eslint-unused-vars doesn't complain in CI.
void readFileSync;
