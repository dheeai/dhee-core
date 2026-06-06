/**
 * Process-wide singleton for the BackgroundTaskRunner. Every project
 * runs through the bundle architecture via runProjectViaBundle.
 */
import {
  BackgroundTaskRunner,
  type ExecutorCancelled,
  type TaskExecutionContext,
} from './BackgroundTaskRunner.js';
import { getProjectsDir } from '../../agent/pi/paths.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface GenericProjectFile { bundleSource?: string; [k: string]: unknown }

function resolveProjectDir(opts: { name: string; basePath: string; projectDir?: string }): string {
  if (opts.projectDir) return resolve(opts.projectDir);
  return resolve(opts.basePath, opts.name);
}

async function executeRunTo(ctx: TaskExecutionContext): Promise<void | ExecutorCancelled> {
  const params = ctx.spec.params as {
    projectDir?: string;
    stage?: string;
  };
  const projectDir = resolveProjectDir({
    name: ctx.spec.projectName,
    basePath: getProjectsDir(),
    ...(params.projectDir ? { projectDir: params.projectDir } : {}),
  });
  const projectJsonPath = join(projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) {
    throw new Error(`project.json not found in ${projectDir}`);
  }
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as GenericProjectFile;
  if (!project.bundleSource) {
    throw new Error(
      `Project at ${projectDir} has no bundleSource in project.json. ` +
      `All projects run through the bundle architecture. Set ` +
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
  if (!result.ok) throw new Error(result.error ?? 'bundle run failed');
  if (result.gatedAfter) {
    ctx.hooks.onNotification({
      level: 'info',
      message:
        `⏸ Paused after collection node '${result.gatedAfter}' — ` +
        `stop-after-each-collection is on. Resume to continue.`,
    });
    return;
  }
  if (result.finalVideoAbs) {
    ctx.hooks.onNotification({
      level: 'info',
      message: `bundle complete. Final video: ${result.finalVideoAbs}`,
    });
  }
  return;
}

const SINGLETON_KEY = '__dhee_background_task_runner__';
interface SingletonHolder { [SINGLETON_KEY]?: BackgroundTaskRunner }
function holder(): SingletonHolder { return globalThis as unknown as SingletonHolder; }

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
            `Background task kind '${ctx.spec.kind}' is not yet wired to the bundle architecture.`,
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

export function __resetBackgroundTaskRunnerForTesting(): void {
  delete holder()[SINGLETON_KEY];
}
