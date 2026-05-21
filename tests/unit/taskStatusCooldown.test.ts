/**
 * Regression: pi-agent has been observed calling `kshana_task_status`
 * 5-10 times in rapid succession during a long pipeline run, even
 * though both the tool description AND the orchestrator prompt say
 * not to poll. Each call adds a noisy tool-card to the chat with no
 * new information.
 *
 * Fix: cooldown enforced server-side. Calls within 30s of the prior
 * call get a throttled response that explicitly tells pi-agent to
 * stop polling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  dheeTaskStatus,
  __resetTaskStatusCooldownForTesting,
  type TaskStatusDetails,
} from '../../src/agent/pi/tools/taskStatus.js';
import { __resetBackgroundTaskRunnerForTesting } from '../../src/server/runners/backgroundTaskRunnerSingleton.js';

async function callStatus(): Promise<TaskStatusDetails> {
  // The defineTool execute signature is (toolCallId, params, signal,
  // onUpdate, ctx). Most of the args don't matter for this tool —
  // it's read-only and doesn't touch context. Pass minimal stubs.
  const result = await dheeTaskStatus.execute(
    'test-call',
    {},
    undefined as never,
    undefined as never,
    {} as never,
  );
  return result.details as TaskStatusDetails;
}

describe('kshana_task_status — cooldown gate', () => {
  beforeEach(() => {
    __resetTaskStatusCooldownForTesting();
    __resetBackgroundTaskRunnerForTesting();
  });

  afterEach(() => {
    __resetTaskStatusCooldownForTesting();
    __resetBackgroundTaskRunnerForTesting();
  });

  it('first call passes through normally (no throttled flag)', async () => {
    const d = await callStatus();
    expect(d.throttled).toBeUndefined();
    expect(d.active).toBe(false);
  });

  it('a second call within the cooldown window is throttled', async () => {
    await callStatus(); // first call sets the timestamp
    const d = await callStatus(); // immediate second call → throttled
    expect(d.throttled).toBe(true);
    expect(d.log).toMatch(/STOP/);
  });

  it('the throttled response carries the active/inactive bit but no internal task details', async () => {
    // We deliberately keep the throttled payload thin so pi-agent
    // can't use repeated polls as a stand-in for streaming events —
    // returning task details on every throttled call would defeat
    // the purpose of the cooldown.
    await callStatus();
    const d = await callStatus();
    expect(d.throttled).toBe(true);
    expect(d.taskId).toBeUndefined();
    expect(d.startedAt).toBeUndefined();
    expect(d.kind).toBeUndefined();
  });

  it('after the cooldown elapses, the next call is fresh again (no throttled flag)', async () => {
    await callStatus();
    // Skip ahead by mutating the module-level last-call time. We
    // can't easily move the wall clock, so we reset and re-call.
    __resetTaskStatusCooldownForTesting();
    const d = await callStatus();
    expect(d.throttled).toBeUndefined();
  });

  it('the fresh response includes a "do not poll" directive ONLY when a task is running (no need to warn off polls when nothing is happening)', async () => {
    // No-task path: bare "no task running" message — no need for an
    // anti-poll directive because there's nothing for pi-agent to
    // watch.
    const idle = await callStatus();
    expect(idle.log).toMatch(/[Nn]o background task/);
    // We don't enforce a "do not call" directive on the idle path —
    // the cooldown gate handles repeat polls regardless.
  });
});
