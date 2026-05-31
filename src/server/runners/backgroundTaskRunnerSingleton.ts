/**
 * Process-wide singleton instance of `BackgroundTaskRunner`.
 *
 * The runner is the single source of truth for "what long dhee
 * operation is currently running" across the host. The pi-agent
 * dispatch tools (`dhee_dispatch_run_to`, etc.) talk to this
 * instance; the dheeCoreManager subscribes to its events and
 * forwards them to the originating chat session's IPC stream.
 *
 * The singleton's `executor` understands every supported `TaskKind`
 * — for the MVP that's `run_to`, with the others to follow as
 * they're plumbed.
 *
 * Tests should NEVER use this singleton directly. Construct a
 * fresh `BackgroundTaskRunner` with a stub executor instead.
 */

import {
  BackgroundTaskRunner,
  type ExecutorCancelled,
  type TaskExecutionContext,
} from './BackgroundTaskRunner.js';
import { runExecutor } from './runExecutor.js';
import { resolveProjectDir } from '../../agent/pi/tools/resolveProjectDir.js';
import { getProjectsDir } from '../../agent/pi/paths.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRunTarget } from './classifyRunTarget.js';
import { resolveNodeId, type ExecutorState } from '../../core/project/projectTypes.js';
import type { GenericProjectFile } from '../../core/templates/types.js';
import { clearStaleStopFile } from './preflightStopFile.js';

async function executeRunTo(ctx: TaskExecutionContext): Promise<void | ExecutorCancelled> {
  const params = ctx.spec.params as {
    projectDir?: string;
    stage?: string;
    skip_media?: boolean;
    /**
     * 'all' (default) → drain everything pending in the graph
     * 'last_invalidated' → run ONLY the ids stored on
     *   `executorState.lastInvalidatedIds` by the most-recent
     *   `dhee_invalidate` call. Honors the user's "redo this and
     *   stop, don't auto-cascade" rule.
     */
    scope?: 'all' | 'last_invalidated';
  };

  const projectDir = resolveProjectDir({
    name: ctx.spec.projectName,
    basePath: getProjectsDir(),
    ...(params.projectDir ? { projectDir: params.projectDir } : {}),
  });

  // A stale `.executor.stop` from a prior incarnation (process killed
  // mid-cancel, host crashed, etc.) would otherwise kill this dispatch
  // in milliseconds. Clear it before starting. Fresh sentinels (mtime
  // within the last minute) are preserved so a concurrent cancel still
  // wins.
  if (clearStaleStopFile(projectDir)) {
    ctx.hooks.onNotification({
      level: 'info',
      message: 'Cleared stale .executor.stop sentinel from a previous run.',
    });
  }

  const projectJsonPath = join(projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) {
    throw new Error(`project.json not found in ${projectDir}`);
  }
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as GenericProjectFile;

  let resolvedTarget: { stage?: string; nodeId?: string };
  const classified = classifyRunTarget(params.stage ?? null);
  if (classified.alias) {
    const state = (project as unknown as { executorState?: ExecutorState })
      .executorState;
    if (!state) {
      throw new Error(
        `Cannot resolve alias '${classified.alias}' — project has no executorState yet. Run dhee_run_to without a target first to bootstrap.`,
      );
    }
    const resolved = resolveNodeId(state, classified.alias);
    if (!resolved) {
      throw new Error(`Unknown alias: '${classified.alias}'.`);
    }
    resolvedTarget = { nodeId: resolved };
  } else {
    resolvedTarget = {
      ...(classified.stage ? { stage: classified.stage } : {}),
      ...(classified.nodeId ? { nodeId: classified.nodeId } : {}),
    };
  }

  // Last-invalidated whitelist: read on dispatch (not lazy) so a
  // concurrent invalidate can't slip a stale list in mid-run. Empty
  // list when scope='last_invalidated' but nothing was previously
  // invalidated — the executor will exit immediately rather than
  // silently fall through to "run everything", which would surprise
  // the user.
  let runOnly: string[] | undefined;
  if (params.scope === 'last_invalidated') {
    const state = (project as unknown as {
      executorState?: { lastInvalidatedIds?: string[] };
    }).executorState;
    runOnly = state?.lastInvalidatedIds ?? [];
    ctx.hooks.onNotification({
      level: 'info',
      message:
        runOnly.length === 0
          ? 'scope=last_invalidated, but no nodes were previously invalidated — nothing to run.'
          : `scope=last_invalidated — running ONLY the ${runOnly.length} previously-invalidated node(s).`,
    });
  }

  // The legacy in-executor VLM-review gate (consumer of vlmEnabledForRun)
  // has been removed — semantic image judgment is now ConversationManager's
  // supervisor path (asset event → describeImageWithVLM → pi-agent turn).
  // The `piOversight`/`vlmJudge` runtime constraint is enforced there
  // directly (gates 1+2 of `runSupervisorInvocation`). Nothing here
  // needs to plumb a snapshot any more.

  const result = await runExecutor({
    project,
    projectDir,
    target: {
      ...resolvedTarget,
      ...(params.skip_media ? { skipMedia: true } : {}),
      ...(runOnly ? { runOnly } : {}),
    },
    signal: ctx.signal,
    name: 'task-runner-run-to',
    onTool: (info) => ctx.hooks.onTool(info),
    onResult: (info) => ctx.hooks.onResult(info),
    onNotification: (info) => ctx.hooks.onNotification(info),
    ...(ctx.hooks.onAsset
      ? {
          onAsset: (event) => {
            ctx.hooks.onAsset?.({
              kind: event.kind,
              filePath: event.filePath,
              projectDir,
              ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
              ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
            });
          },
        }
      : {}),
  });

  if (result.status === 'failed') {
    throw new Error(result.error ?? 'run_to failed');
  }
  // Cancellation can come from two paths:
  //   - AbortController.abort() (set by `runner.cancel()` from the host)
  //     — the runner sees `signal.aborted` and emits 'cancelled'
  //   - `.executor.stop` sentinel consumed by ExecutorAgent — runExecutor
  //     returns `status: 'cancelled'` but the AbortController was never
  //     tripped. Without the explicit return below, runActive() would
  //     classify the task as 'completed' and the chat session would
  //     never see the cancellation, even though no work happened.
  if (result.status === 'cancelled') {
    return { cancelled: true };
  }
  return;
}

// IMPORTANT: this singleton must be process-wide. tsup builds
// multiple entry bundles (dist/server/manager.js, dist/server/runners,
// dist/agent/pi, dist/index) and each one inlines its own copy of
// this module — so a per-module `let singleton` would create one
// runner instance per bundle. ConversationManager would subscribe
// to instance A; the desktop's IPC cancel handler (which loads
// `dhee-core/runners`) would call .cancel() on instance B and the
// running task would never abort. Pin on `globalThis` so all bundles
// resolve to the same instance.
const SINGLETON_KEY = '__dhee_background_task_runner__';

interface SingletonHolder {
  [SINGLETON_KEY]?: BackgroundTaskRunner;
}

function holder(): SingletonHolder {
  return globalThis as unknown as SingletonHolder;
}

export function getBackgroundTaskRunner(): BackgroundTaskRunner {
  const g = holder();
  let singleton = g[SINGLETON_KEY];
  if (!singleton) {
    singleton = new BackgroundTaskRunner(async (ctx) => {
      switch (ctx.spec.kind) {
        case 'run_to':
          await executeRunTo(ctx);
          return;
        case 'regen':
        case 'render_scene_bundle':
        case 'audit_fidelity':
          throw new Error(
            `Background task kind '${ctx.spec.kind}' is not yet wired to an executor.`,
          );
        default: {
          const _exhaustive: never = ctx.spec.kind;
          throw new Error(`Unknown task kind: ${String(_exhaustive)}`);
        }
      }
    });
    g[SINGLETON_KEY] = singleton;
  }
  return singleton;
}

/** Test-only — drop the singleton so the next get rebuilds. */
export function __resetBackgroundTaskRunnerForTesting(): void {
  delete holder()[SINGLETON_KEY];
}
