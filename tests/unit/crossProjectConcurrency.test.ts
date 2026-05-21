/**
 * Cross-project concurrency guard.
 *
 * Two sessions on DIFFERENT projects must not generate at the same
 * time — the pipeline's process-global `activeProjectDir` would race
 * and silently corrupt project.json. The same-project case is fine
 * (JobManager already serializes there).
 */
import { describe, it, expect } from 'vitest';
import { ConversationManager } from '../../src/server/ConversationManager.js';

interface ConversationManagerInternals {
  sessions: Map<
    string,
    {
      state: { status: string };
      focusedProject?: string;
    }
  >;
  findCrossProjectConflict(
    currentSessionId: string,
    currentFocusedProject: string | undefined,
  ): string | null;
}

function asInternal(cm: ConversationManager): ConversationManagerInternals {
  return cm as unknown as ConversationManagerInternals;
}

function newManager(): ConversationManager {
  return new ConversationManager({
    llmConfig: { baseUrl: 'x', apiKey: 'x', model: 'x' } as never,
  });
}

function seedSession(
  cm: ConversationManager,
  id: string,
  status: 'idle' | 'running',
  focusedProject?: string,
): void {
  asInternal(cm).sessions.set(id, {
    state: { status },
    ...(focusedProject !== undefined ? { focusedProject } : {}),
  });
}

describe('ConversationManager cross-project concurrency guard', () => {
  it('returns null when no other session is running', () => {
    const cm = newManager();
    seedSession(cm, 'a', 'idle', 'projectA');
    seedSession(cm, 'b', 'idle', 'projectB');

    const conflict = asInternal(cm).findCrossProjectConflict('a', 'projectA');
    expect(conflict).toBeNull();
  });

  it('returns null when the other running session is on the SAME project', () => {
    const cm = newManager();
    seedSession(cm, 'a', 'idle', 'projectA');
    seedSession(cm, 'b', 'running', 'projectA');

    const conflict = asInternal(cm).findCrossProjectConflict('a', 'projectA');
    expect(conflict).toBeNull();
  });

  it('returns the other project slug when a different-project session is running', () => {
    const cm = newManager();
    seedSession(cm, 'a', 'idle', 'projectA');
    seedSession(cm, 'b', 'running', 'projectB');

    const conflict = asInternal(cm).findCrossProjectConflict('a', 'projectA');
    expect(conflict).toBe('projectB');
  });

  it('does not flag ambient (no focusedProject) running sessions', () => {
    const cm = newManager();
    seedSession(cm, 'a', 'idle', 'projectA');
    seedSession(cm, 'b', 'running'); // ambient — focusedProject undefined

    const conflict = asInternal(cm).findCrossProjectConflict('a', 'projectA');
    expect(conflict).toBeNull();
  });

  it('does not flag a currentSession self-check (same id)', () => {
    const cm = newManager();
    seedSession(cm, 'a', 'running', 'projectA');

    // Even though session 'a' is running, asking the guard about 'a' itself
    // should not return its own focusedProject as a conflict.
    const conflict = asInternal(cm).findCrossProjectConflict('a', 'projectA');
    expect(conflict).toBeNull();
  });

  it('returns one of multiple running conflicts (any is enough to block)', () => {
    const cm = newManager();
    seedSession(cm, 'a', 'idle', 'projectA');
    seedSession(cm, 'b', 'running', 'projectB');
    seedSession(cm, 'c', 'running', 'projectC');

    const conflict = asInternal(cm).findCrossProjectConflict('a', 'projectA');
    expect(['projectB', 'projectC']).toContain(conflict);
  });

  it('flags conflict even when current session has no focused project (caller is ambient, other is named)', () => {
    const cm = newManager();
    seedSession(cm, 'a', 'idle'); // ambient
    seedSession(cm, 'b', 'running', 'projectB');

    const conflict = asInternal(cm).findCrossProjectConflict('a', undefined);
    expect(conflict).toBe('projectB');
  });
});
