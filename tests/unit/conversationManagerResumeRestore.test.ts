/**
 * Regression: `ConversationManager.createSession(existingSessionId)`
 * must restore enough state on resume that the next IPC call against
 * the session can do useful work.
 *
 * Before the fix: a resumed session had `focusedProject` set but
 * `sessionContext` undefined. Any IPC call that derives a working dir
 * from `sessionContext` (invalidateNodes, run_to, content reads) threw
 * "Session project not configured. Call configureProject / focusProject
 * first" until the renderer happened to fire its own focusProject IPC
 * — a race that caused the "Redo from..." dropdown to error out
 * immediately after a desktop process restart.
 *
 * Fix: createSession populates `sessionContext` synchronously whenever
 * the stored record carries a non-ambient `projectSlug`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationManager } from '../../src/server/ConversationManager.js';
import { recordSession } from '../../src/agent/pi/sessionStore.js';

describe('ConversationManager.createSession resume restores sessionContext', () => {
  let projectsDir: string;
  let configDir: string;
  let piSessionsDir: string;
  let originalProjectsDir: string | undefined;
  let originalConfigDir: string | undefined;
  let originalPiSessionsDir: string | undefined;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'kshana-resume-projects-'));
    configDir = mkdtempSync(join(tmpdir(), 'kshana-resume-config-'));
    piSessionsDir = join(configDir, 'pi-sessions');
    mkdirSync(piSessionsDir, { recursive: true });
    mkdirSync(join(projectsDir, 'demo.kshana'), { recursive: true });
    writeFileSync(
      join(projectsDir, 'demo.kshana', 'project.json'),
      JSON.stringify({
        version: '3.0',
        name: 'demo',
        templateId: 'narrative',
        style: 'noir',
        targetDuration: 30,
      }),
    );
    originalProjectsDir = process.env['KSHANA_PROJECTS_DIR'];
    originalConfigDir = process.env['KSHANA_CONFIG_DIR'];
    originalPiSessionsDir = process.env['KSHANA_PI_SESSIONS_DIR'];
    process.env['KSHANA_PROJECTS_DIR'] = projectsDir;
    process.env['KSHANA_CONFIG_DIR'] = configDir;
    process.env['KSHANA_PI_SESSIONS_DIR'] = piSessionsDir;
  });

  afterEach(() => {
    if (originalProjectsDir === undefined) delete process.env['KSHANA_PROJECTS_DIR'];
    else process.env['KSHANA_PROJECTS_DIR'] = originalProjectsDir;
    if (originalConfigDir === undefined) delete process.env['KSHANA_CONFIG_DIR'];
    else process.env['KSHANA_CONFIG_DIR'] = originalConfigDir;
    if (originalPiSessionsDir === undefined) delete process.env['KSHANA_PI_SESSIONS_DIR'];
    else process.env['KSHANA_PI_SESSIONS_DIR'] = originalPiSessionsDir;
    rmSync(projectsDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  function makeCm(): ConversationManager {
    return new ConversationManager({
      llmConfig: { baseUrl: 'x', apiKey: 'x', model: 'x' } as never,
    });
  }

  it('a freshly-created session has no sessionContext (sanity)', () => {
    const cm = makeCm();
    const session = cm.createSession();
    // No project focused, no resume → sessionContext stays undefined.
    expect((cm as any).sessions.get(session.id).sessionContext).toBeUndefined();
  });

  it('a resumed session whose stored record has a project slug gets sessionContext populated synchronously', () => {
    // Seed the session store as if the desktop had focused "demo" on
    // session 'persisted-1' in a prior run.
    const persistedId = 'persisted-1';
    const sessionFile = join(piSessionsDir, 'demo', `${persistedId}.jsonl`);
    mkdirSync(join(piSessionsDir, 'demo'), { recursive: true });
    writeFileSync(sessionFile, '');
    recordSession(persistedId, 'demo', sessionFile);

    // New manager (simulates a desktop process restart — empty
    // in-memory sessions Map). Resume the stored id.
    const cm = makeCm();
    const resumed = cm.createSession('local', undefined, 'interactive', persistedId);
    expect(resumed.id).toBe(persistedId);

    const internal = (cm as any).sessions.get(persistedId);
    expect(internal.focusedProject).toBe('demo');
    // The load-bearing assertion: sessionContext is set NOW, not
    // after the renderer happens to call focusProject.
    expect(internal.sessionContext).toBeDefined();
    expect(internal.sessionContext.projectDir).toContain('demo');
  });

  it('survives the project folder being deleted out from under a stored session', () => {
    // Stored session points at a project that no longer exists on
    // disk. createSession must not throw — the renderer can still
    // re-focus to a different project, or surface the error later
    // via an explicit focusProject call.
    const persistedId = 'persisted-orphan';
    const sessionFile = join(piSessionsDir, 'demo', `${persistedId}.jsonl`);
    mkdirSync(join(piSessionsDir, 'demo'), { recursive: true });
    writeFileSync(sessionFile, '');
    recordSession(persistedId, 'demo', sessionFile);

    // Delete the project folder so resolveProjectDir throws inside
    // the restore path.
    rmSync(join(projectsDir, 'demo.kshana'), { recursive: true, force: true });

    const cm = makeCm();
    const resumed = cm.createSession('local', undefined, 'interactive', persistedId);
    expect(resumed.id).toBe(persistedId);
    const internal = (cm as any).sessions.get(persistedId);
    // Session exists in the Map (key insight — invalidateNodes etc.
    // will fail with the actual reason rather than "Session not found").
    expect(internal).toBeDefined();
    // sessionContext is still undefined (best effort, can't restore
    // what isn't there) — caller must re-focus.
    expect(internal.sessionContext).toBeUndefined();
  });
});
