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
import { resolveProjectDir } from '../../agent/pi/tools/resolveProjectDir.js';
import { getProjectsDir } from '../../agent/pi/paths.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as GenericProjectFile & {
    bundleSource?: string;
  };

  // Every project runs through the bundle architecture. project.json
  // MUST declare a bundleSource; without one we fail loudly rather
  // than silently fall through to a legacy path that no longer exists.
  if (!project.bundleSource) {
    throw new Error(
      `Project at ${projectDir} has no bundleSource in project.json. ` +
      `All projects now run through the bundle architecture. Set ` +
      `'bundleSource' to 'built-in:narrative_prompt_relay' or ` +
      `'built-in:narrative_shot_by_shot'.`,
    );
  }
  ctx.hooks.onNotification({
    level: 'info',
    message: `dispatch via bundle: ${project.bundleSource}`,
  });
  const { runProjectViaBundle } = await import('./runProjectViaBundle.js');
  const result = await runProjectViaBundle({
    projectDir,
    ...(params.stage ? { stopAt: params.stage } : {}),
    signal: ctx.signal,
    log: (m) => ctx.hooks.onNotification({ level: 'info', message: m }),
  });
  if (!result.ok) {
    throw new Error(result.error ?? 'bundle run failed');
  }
  if (result.finalVideoAbs) {
    ctx.hooks.onNotification({
      level: 'info',
      message: `bundle complete. Final video: ${result.finalVideoAbs}`,
    });
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
