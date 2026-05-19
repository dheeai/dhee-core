/**
 * TDD tests for `decideCancelActions` — the cancel-path decision
 * helper. Each `it` enumerates a real failure mode the cancel path
 * has historically silently swallowed (see cancelDecision.ts header
 * for the 2026-05-19 stuck-Stopping incident that motivated the
 * extraction).
 *
 * The failure modes covered here are FM1, FM2, FM3, FM4, FM8 from
 * the cancel-path review:
 *
 *   FM1 (the smoking gun): runner.cancel must NOT be gated by
 *     sessionId-match. Single-session model — if a runner task is
 *     active, it's the user's work.
 *   FM2: session.abortController undefined → no-op for that lane,
 *     still try other lanes.
 *   FM3: session.agent undefined → same.
 *   FM4: runner idle (active=null) → cancelRunnerTaskId stays null
 *     but other lanes still fire.
 *   FM8: structured outcome distinguishes "session not found" from
 *     "session found but had nothing to cancel" so cancelTask's
 *     return value stops lying.
 */
import { describe, expect, it } from 'vitest';
import { decideCancelActions } from '../../src/server/cancelDecision.js';

describe('decideCancelActions', () => {
  describe('no_session — sessionId did not match any tracked session', () => {
    it('signals nothing and returns no_session', () => {
      expect(
        decideCancelActions({
          sessionExists: false,
          hasAgent: false,
          hasAbortController: false,
          runnerActiveTaskId: null,
        }),
      ).toEqual({
        signalAgent: false,
        fireAbortController: false,
        interruptComfy: false,
        cancelRunnerTaskId: null,
        outcome: 'no_session',
      });
    });

    it('ignores the runner / agent / abortController flags entirely when no session', () => {
      // Even if upstream-checked state suggests work exists, no session
      // means we have no authority to cancel — return clean no-op.
      expect(
        decideCancelActions({
          sessionExists: false,
          hasAgent: true,
          hasAbortController: true,
          runnerActiveTaskId: 'task-123',
        }),
      ).toEqual({
        signalAgent: false,
        fireAbortController: false,
        interruptComfy: false,
        cancelRunnerTaskId: null,
        outcome: 'no_session',
      });
    });
  });

  describe('FM1 — runner.cancel is not gated by sessionId', () => {
    it('cancels the runner task whenever one is active (regardless of any session-id details)', () => {
      // The motivating bug: a session-rename (clearChatHistory mints
      // a fresh id; new project create flow) caused cancelTask to skip
      // runner.cancel because active.spec.sessionId no longer matched
      // the current sessionId. Removing the gate means: if the runner
      // is active, it gets cancelled — period.
      const result = decideCancelActions({
        sessionExists: true,
        hasAgent: true,
        hasAbortController: true,
        runnerActiveTaskId: 'task-abc',
      });
      expect(result.cancelRunnerTaskId).toBe('task-abc');
    });

    it('still passes the task id through when only the runner is active (no agent yet)', () => {
      const result = decideCancelActions({
        sessionExists: true,
        hasAgent: false,
        hasAbortController: false,
        runnerActiveTaskId: 'task-orphan',
      });
      expect(result.cancelRunnerTaskId).toBe('task-orphan');
    });
  });

  describe('FM2/FM3 — undefined agent / abortController lanes are skipped without affecting others', () => {
    it('skips signalAgent when no agent attached, still fires the controller', () => {
      const result = decideCancelActions({
        sessionExists: true,
        hasAgent: false,
        hasAbortController: true,
        runnerActiveTaskId: null,
      });
      expect(result.signalAgent).toBe(false);
      expect(result.fireAbortController).toBe(true);
    });

    it('skips fireAbortController when no controller attached, still signals the agent', () => {
      const result = decideCancelActions({
        sessionExists: true,
        hasAgent: true,
        hasAbortController: false,
        runnerActiveTaskId: null,
      });
      expect(result.signalAgent).toBe(true);
      expect(result.fireAbortController).toBe(false);
    });
  });

  describe('FM4 — idle runner returns null cancelRunnerTaskId without aborting other lanes', () => {
    it('cancelRunnerTaskId is null but other lanes proceed', () => {
      const result = decideCancelActions({
        sessionExists: true,
        hasAgent: true,
        hasAbortController: true,
        runnerActiveTaskId: null,
      });
      expect(result.cancelRunnerTaskId).toBeNull();
      expect(result.signalAgent).toBe(true);
      expect(result.fireAbortController).toBe(true);
    });
  });

  describe('FM8 — structured outcome distinguishes session-found-but-idle from session-not-found', () => {
    it('returns no_active_work when session exists but everything is idle', () => {
      const result = decideCancelActions({
        sessionExists: true,
        hasAgent: false,
        hasAbortController: false,
        runnerActiveTaskId: null,
      });
      expect(result.outcome).toBe('no_active_work');
      // ComfyUI interrupt still fires — process-global, harmless if nothing to cancel.
      expect(result.interruptComfy).toBe(true);
    });

    it('returns signals_dispatched when at least one lane will fire', () => {
      expect(
        decideCancelActions({
          sessionExists: true,
          hasAgent: true,
          hasAbortController: false,
          runnerActiveTaskId: null,
        }).outcome,
      ).toBe('signals_dispatched');
      expect(
        decideCancelActions({
          sessionExists: true,
          hasAgent: false,
          hasAbortController: true,
          runnerActiveTaskId: null,
        }).outcome,
      ).toBe('signals_dispatched');
      expect(
        decideCancelActions({
          sessionExists: true,
          hasAgent: false,
          hasAbortController: false,
          runnerActiveTaskId: 'task-x',
        }).outcome,
      ).toBe('signals_dispatched');
    });
  });

  describe('ComfyUI interrupt — always fires when session exists', () => {
    it('fires even when no agent / controller / runner work (covers in-process probe scripts)', () => {
      // A probe / in-process script can submit a ComfyUI prompt outside
      // the runner. If user clicks Stop with a fresh session in this
      // state, we still want to release the GPU. Cheap & idempotent on
      // the ComfyUI side.
      const result = decideCancelActions({
        sessionExists: true,
        hasAgent: false,
        hasAbortController: false,
        runnerActiveTaskId: null,
      });
      expect(result.interruptComfy).toBe(true);
    });

    it('does NOT fire when session is missing (would have no authority)', () => {
      const result = decideCancelActions({
        sessionExists: false,
        hasAgent: false,
        hasAbortController: false,
        runnerActiveTaskId: null,
      });
      expect(result.interruptComfy).toBe(false);
    });
  });

  describe('full-engagement happy path', () => {
    it('all four signals fire when every lane has work and a session exists', () => {
      expect(
        decideCancelActions({
          sessionExists: true,
          hasAgent: true,
          hasAbortController: true,
          runnerActiveTaskId: 'task-1',
        }),
      ).toEqual({
        signalAgent: true,
        fireAbortController: true,
        interruptComfy: true,
        cancelRunnerTaskId: 'task-1',
        outcome: 'signals_dispatched',
      });
    });
  });
});
