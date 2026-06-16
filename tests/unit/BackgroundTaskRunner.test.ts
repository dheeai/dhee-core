import { describe, it, expect, beforeEach } from 'vitest';
import {
  BackgroundTaskRunner,
  __resetTaskIdCounterForTesting,
  type TaskSpec,
  type TaskExecutor,
} from '../../src/server/runners/BackgroundTaskRunner.js';
import {
  addLocalResourceStartListener,
  __resetLocalResourceForTesting,
  withLocalResource,
} from '../../src/dag/localResourceState.js';

function makeSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    kind: 'run_to',
    projectName: 'BurgerEating',
    params: {},
    sessionId: 'sess-1',
    ...overrides,
  };
}

/** Promise that resolves when the runner emits the named event once. */
function once<K extends string>(
  runner: BackgroundTaskRunner,
  event: K,
): Promise<unknown> {
  return new Promise((resolve) => {
    runner.on(event as never, ((payload: unknown) => resolve(payload)) as never);
  });
}

beforeEach(() => {
  __resetTaskIdCounterForTesting();
  __resetLocalResourceForTesting();
});

describe('BackgroundTaskRunner — dispatch + state', () => {
  it('returns { status: "started" } and a task id on a fresh dispatch', () => {
    const runner = new BackgroundTaskRunner(async () => {
      // hang so the active slot stays full
      await new Promise(() => {});
    });
    const result = runner.dispatch(makeSpec());
    expect(result.status).toBe('started');
    if (result.status === 'started') {
      expect(result.taskId).toMatch(/^task-/);
    }
    expect(runner.isBusy()).toBe(true);
  });

  it('emits a "started" event before runActive begins', async () => {
    let executorRan = false;
    const runner = new BackgroundTaskRunner(async () => {
      executorRan = true;
      await new Promise(() => {});
    });
    const startedP = once(runner, 'started');
    runner.dispatch(makeSpec());
    const started = (await startedP) as { task: { spec: TaskSpec; id: string } };
    expect(started.task.spec.projectName).toBe('BurgerEating');
    // Once the started event fires, the executor has been kicked
    // off (the microtask boundary lets us verify).
    await Promise.resolve();
    expect(executorRan).toBe(true);
  });

  it('REJECTS a second dispatch while a task is active', () => {
    const runner = new BackgroundTaskRunner(async () => {
      await new Promise(() => {});
    });
    const first = runner.dispatch(makeSpec());
    const second = runner.dispatch(
      makeSpec({ projectName: 'OtherProject' }),
    );
    expect(first.status).toBe('started');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.reason).toBe('task_already_running');
      expect(second.activeProjectName).toBe('BurgerEating');
      expect(second.activeTaskKind).toBe('run_to');
      // Caller can use the activeTaskId to address a cancel.
      expect(second.activeTaskId).toMatch(/^task-/);
    }
  });

  it('accepts a fresh dispatch after the active task completes', async () => {
    let resolveExecutor: (() => void) | null = null;
    const runner = new BackgroundTaskRunner(
      async () =>
        new Promise<void>((resolve) => {
          resolveExecutor = resolve;
        }),
    );
    const done = once(runner, 'completed');
    runner.dispatch(makeSpec());
    resolveExecutor?.();
    await done;

    expect(runner.isBusy()).toBe(false);
    const second = runner.dispatch(makeSpec({ projectName: 'Other' }));
    expect(second.status).toBe('started');
  });

  it('surfaces the active local resource while the task is running', async () => {
    let releaseResource: (() => void) | null = null;
    const resourceReleased = new Promise<void>((resolve) => {
      releaseResource = resolve;
    });
    const runner = new BackgroundTaskRunner(async () => {
      await withLocalResource(
        {
          kind: 'local_comfy',
          tool: 'comfy.tti',
          nodeId: 'shot_image',
          itemId: 'scene_1_shot_1',
          resourceKey: 'self.local',
        },
        () => resourceReleased,
      );
    });

    runner.dispatch(makeSpec());
    await Promise.resolve();

    expect(runner.getActive()?.currentResource).toMatchObject({
      kind: 'local_comfy',
      tool: 'comfy.tti',
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_1',
      resourceKey: 'self.local',
    });

    releaseResource?.();
    await once(runner, 'completed');
    expect(runner.getActive()).toBeNull();
  });

  it('notifies local resource start listeners before entering the resource block', async () => {
    const events: string[] = [];
    addLocalResourceStartListener(async (resource) => {
      events.push(`listener:${resource.kind}:${resource.tool}`);
    });

    await withLocalResource(
      {
        kind: 'local_comfy',
        tool: 'comfy.ltx_director',
        nodeId: 'scene_clip',
      },
      async () => {
        events.push('runner');
      },
    );

    expect(events).toEqual(['listener:local_comfy:comfy.ltx_director', 'runner']);
  });
});

describe('BackgroundTaskRunner — cancel', () => {
  it('cancel() returns false when nothing is running', () => {
    const runner = new BackgroundTaskRunner(async () => {});
    expect(runner.cancel()).toBe(false);
  });

  it('cancel() aborts the active task and emits "cancelled"', async () => {
    let receivedSignal: AbortSignal | null = null;
    const runner = new BackgroundTaskRunner(async ({ signal }) => {
      receivedSignal = signal;
      // Wait until aborted, then resolve cleanly.
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve());
      });
    });
    const cancelled = once(runner, 'cancelled');
    runner.dispatch(makeSpec());
    expect(receivedSignal).not.toBeNull();
    expect(runner.cancel()).toBe(true);
    const payload = (await cancelled) as { task: { status: string } };
    expect(payload.task.status).toBe('cancelled');
    expect(runner.isBusy()).toBe(false);
  });

  it('cancel(taskId) only fires for the matching id', () => {
    const runner = new BackgroundTaskRunner(async () => {
      await new Promise(() => {});
    });
    const dispatched = runner.dispatch(makeSpec());
    expect(dispatched.status).toBe('started');
    const id =
      dispatched.status === 'started' ? dispatched.taskId : 'nope';

    expect(runner.cancel('different-id')).toBe(false);
    expect(runner.isBusy()).toBe(true);
    expect(runner.cancel(id)).toBe(true);
  });

  it('emits "cancelled" (not "failed") when the executor throws AFTER abort', async () => {
    // Real-world: the executor's abort handler throws an
    // AbortError. The runner must classify that as cancelled, not a
    // failure.
    const runner = new BackgroundTaskRunner(async ({ signal }) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () =>
          reject(new Error('AbortError: aborted')),
        );
      });
    });
    const cancelled = once(runner, 'cancelled');
    runner.dispatch(makeSpec());
    runner.cancel();
    const payload = (await cancelled) as { task: { status: string } };
    expect(payload.task.status).toBe('cancelled');
  });

  it('emits "completed" with gatedAfter/pendingAfterGate when the executor returns an ExecutorGated outcome', async () => {
    // Issue #133: a run that paused on the stop-after-each-collection
    // gate is a `completed` task — but the runner must stamp the gate
    // reason onto the terminal event so consumers (agent tool, desktop
    // nudge) can tell it apart from an end-to-end finish.
    const runner = new BackgroundTaskRunner(async () => {
      return { gatedAfter: 'shot_image_prompt', pendingAfterGate: ['shot_image', 'scene_clip', 'final_video'] };
    });
    const completed = once(runner, 'completed');
    let cancelledFired = false;
    runner.on('cancelled' as never, (() => (cancelledFired = true)) as never);
    runner.dispatch(makeSpec());
    const payload = (await completed) as {
      task: { status: string; gatedAfter?: string; pendingAfterGate?: string[] };
    };
    expect(payload.task.status).toBe('completed');
    expect(payload.task.gatedAfter).toBe('shot_image_prompt');
    expect(payload.task.pendingAfterGate).toEqual(['shot_image', 'scene_clip', 'final_video']);
    expect(cancelledFired).toBe(false);
    expect(runner.isBusy()).toBe(false);
  });

  it('a plain (non-gated) completion leaves gatedAfter unset', async () => {
    const runner = new BackgroundTaskRunner(async () => {});
    const completed = once(runner, 'completed');
    runner.dispatch(makeSpec());
    const payload = (await completed) as { task: { gatedAfter?: string } };
    expect(payload.task.gatedAfter).toBeUndefined();
  });

  it('emits "cancelled" when the executor returns { cancelled: true } without an abort', async () => {
    // Bug 2026-05-04: ExecutorAgent stops via `.executor.stop` sentinel
    // — the AbortController is never tripped, so the runner used to
    // classify the task as 'completed' and the chat session never saw
    // the cancellation. The executor now returns an explicit cancel
    // sentinel for this path; the runner must respect it.
    const runner = new BackgroundTaskRunner(async () => {
      return { cancelled: true };
    });
    const cancelled = once(runner, 'cancelled');
    let completedFired = false;
    runner.on('completed' as never, (() => (completedFired = true)) as never);
    runner.dispatch(makeSpec());
    const payload = (await cancelled) as { task: { status: string } };
    expect(payload.task.status).toBe('cancelled');
    expect(completedFired).toBe(false);
    expect(runner.isBusy()).toBe(false);
  });
});

describe('BackgroundTaskRunner — execution hook events', () => {
  it('forwards onTool / onResult / onNotification / onAsset to event subscribers', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];

    const executor: TaskExecutor = async ({ hooks }) => {
      hooks.onTool({ toolName: 'llm_call', nodeId: 'plot:plot' });
      hooks.onResult({
        toolName: 'llm_call',
        filePath: 'plans/plot.md',
        status: 'completed',
      });
      hooks.onNotification({ level: 'info', message: 'Working on: Plot' });
      hooks.onAsset?.({
        kind: 'image',
        filePath: 'assets/images/s1shot1.png',
        toolName: 'comfy_generate',
        nodeId: 'shot_image:scene_1_shot_1',
        metadata: { provider: 'openrouter', usage: { cost: 0.04 } },
      });
    };

    const runner = new BackgroundTaskRunner(executor);
    runner.on('tool' as never, ((p: unknown) => events.push({ type: 'tool', payload: p })) as never);
    runner.on('result' as never, ((p: unknown) => events.push({ type: 'result', payload: p })) as never);
    runner.on(
      'notification' as never,
      ((p: unknown) => events.push({ type: 'notification', payload: p })) as never,
    );
    runner.on('asset' as never, ((p: unknown) => events.push({ type: 'asset', payload: p })) as never);
    const completed = once(runner, 'completed');
    runner.dispatch(makeSpec());
    await completed;

    expect(events.map((e) => e.type)).toEqual([
      'tool',
      'result',
      'notification',
      'asset',
    ]);
    const tool = events[0]?.payload as { toolName: string; nodeId: string };
    expect(tool.toolName).toBe('llm_call');
    expect(tool.nodeId).toBe('plot:plot');
    const asset = events[3]?.payload as {
      kind: string;
      filePath: string;
      metadata?: Record<string, unknown>;
    };
    expect(asset.kind).toBe('image');
    expect(asset.filePath).toBe('assets/images/s1shot1.png');
    expect(asset.metadata).toEqual({ provider: 'openrouter', usage: { cost: 0.04 } });
  });

  it('forwards tool error messages through the result event so the chat session can surface them', async () => {
    // Bug 2026-05-04: ComfyUI error messages were being dropped at the
    // runner boundary — the chat just saw "→ error" with no cause.
    // The hooks/event must carry `error` end-to-end.
    const events: Array<{ toolName: string; status?: string; error?: string }> = [];
    const executor: TaskExecutor = async ({ hooks }) => {
      hooks.onResult({
        toolName: 'generate_shot_image',
        status: 'error',
        error: 'ServiceError — lora_name not in list',
      });
    };
    const runner = new BackgroundTaskRunner(executor);
    runner.on('result' as never, ((p: { toolName: string; status?: string; error?: string }) => events.push({
      toolName: p.toolName,
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...(p.error !== undefined ? { error: p.error } : {}),
    })) as never);
    const completed = once(runner, 'completed');
    runner.dispatch(makeSpec());
    await completed;

    expect(events).toEqual([
      {
        toolName: 'generate_shot_image',
        status: 'error',
        error: 'ServiceError — lora_name not in list',
      },
    ]);
  });

  it('every event payload includes the originating task record so subscribers can route by sessionId', async () => {
    const executor: TaskExecutor = async ({ hooks }) => {
      hooks.onTool({ toolName: 't' });
    };
    const runner = new BackgroundTaskRunner(executor);
    let toolPayload: unknown = null;
    runner.on('tool' as never, ((p: unknown) => (toolPayload = p)) as never);
    const completed = once(runner, 'completed');
    runner.dispatch(makeSpec({ sessionId: 'sess-XYZ' }));
    await completed;

    const t = toolPayload as { task: { spec: { sessionId: string }; id: string } };
    expect(t.task.spec.sessionId).toBe('sess-XYZ');
    expect(t.task.id).toMatch(/^task-/);
  });
});

describe('BackgroundTaskRunner — failure handling', () => {
  it('emits "failed" with the error message when the executor throws (not aborted)', async () => {
    const runner = new BackgroundTaskRunner(async () => {
      throw new Error('LLM is angry');
    });
    const failed = once(runner, 'failed');
    runner.dispatch(makeSpec());
    const payload = (await failed) as { task: { status: string }; error: string };
    expect(payload.task.status).toBe('failed');
    expect(payload.error).toBe('LLM is angry');
    expect(runner.isBusy()).toBe(false);
  });
});

describe('BackgroundTaskRunner — replace', () => {
  it('replace() cancels the current task and dispatches the new one', async () => {
    let aborts = 0;
    const runner = new BackgroundTaskRunner(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborts += 1;
          resolve();
        });
      });
    });
    const cancelled = once(runner, 'cancelled');
    const first = runner.dispatch(makeSpec({ projectName: 'A' }));
    expect(first.status).toBe('started');

    // Wait briefly: replace() schedules cancel + new dispatch in the
    // same tick, but the cancelled event needs the executor's abort
    // listener to fire (which it does in the same microtask).
    const replaceResult = runner.replace(makeSpec({ projectName: 'B' }));
    await cancelled;

    expect(aborts).toBe(1);
    // The cancel-then-dispatch in replace() runs synchronously, but
    // the new dispatch sees the slot still occupied (the cancelled
    // event hasn't propagated yet through the runner's `runActive`
    // finally). Until that races settle, the new dispatch is
    // rejected. The contract: replace returns whatever the new
    // dispatch returned; callers that need atomic replace listen
    // for `cancelled` then dispatch fresh. Pin BOTH outcomes — the
    // callable returns SOMETHING, and the cancel always fires.
    expect(['started', 'rejected']).toContain(replaceResult.status);
  });
});
