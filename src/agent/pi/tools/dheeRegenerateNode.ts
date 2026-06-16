/**
 * dhee_regenerate_node — invalidate a single node (optionally a
 * single item of a collection node) and dispatch the follow-up bundle
 * run in the background so that node + downstream re-runs.
 *
 * This must not block inside the agent turn: image/video jobs can take
 * minutes, and the chat agent's own turn signal may abort long-running
 * tool calls. The desktop right-click path already routes through the
 * tracked BackgroundTaskRunner; this agent tool now follows the same
 * async shape as `dhee_start_run`.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import {
  invalidateNodes,
  regenerateNode,
  type RunProjectViaBundleFn,
} from '../../../dag/projectRegen.js';
import { isWalkLocked } from '../../../dag/projectWalkLock.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  nodeId: Type.String({ description: 'Bundle node id to regenerate.' }),
  itemId: Type.Optional(
    Type.String({
      description:
        "For collection nodes, the specific item to regenerate (e.g. 'scene_1_shot_3'). Omit to regenerate the whole node.",
    }),
  ),
});

export interface RegenerateNodeDeps {
  /** Production default = the process-wide background runner singleton. */
  getBackgroundTaskRunner?: () => BackgroundTaskRunner | Promise<BackgroundTaskRunner>;
  /**
   * Legacy test/headless seam. Production does not use this path because
   * it blocks the agent turn for the full media run.
   */
  runProjectViaBundle?: RunProjectViaBundleFn;
  /**
   * Max regenerations of the SAME (projectDir, nodeId[:itemId]) key the
   * tool will dispatch for the life of this tool instance (one chat
   * session). Once a key hits the cap, further regens are refused
   * WITHOUT a paid runner call. Defaults to {@link DEFAULT_MAX_REGENS_PER_KEY}.
   *
   * This is the guard for the 2026-06-04 credit-burn incident, where the
   * agent looped ~12x regenerating one node, each a paid generation. The
   * walker's reviewLoopMax caps its internal re-walks; this caps the
   * agent driving the tool from the outside.
   */
  maxRegensPerKey?: number;
}

/**
 * A single node regenerated this many times in one session is already
 * pathological — stop before the ~12x real-world blowout. The agent can
 * still pick an existing version, critique differently, or start a fresh
 * run; this only refuses MORE paid regens of the same node.
 */
export const DEFAULT_MAX_REGENS_PER_KEY = 10;

interface DispatchResultStarted {
  status: 'started';
  taskId: string;
}
interface DispatchResultRejected {
  status: 'rejected';
  reason: string;
  activeTaskId: string;
  activeProjectName: string;
}
type DispatchResult = DispatchResultStarted | DispatchResultRejected;

interface BackgroundTaskRunner {
  getActive?: () => null | {
    id: string;
    spec: {
      kind: string;
      projectName: string;
      projectDir?: string;
      sessionId: string;
      params?: { projectDir?: string };
    };
  };
  dispatch(spec: {
    kind: 'run_to';
    projectName: string;
    params: { projectDir: string };
    sessionId: string;
  }): DispatchResult;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

async function defaultGetBackgroundTaskRunner(): Promise<BackgroundTaskRunner> {
  const mod = await import('../../../server/runners/backgroundTaskRunnerSingleton.js');
  return mod.getBackgroundTaskRunner() as unknown as BackgroundTaskRunner;
}

export function makeRegenerateNodeTool(deps: RegenerateNodeDeps = {}) {
  const cap = deps.maxRegensPerKey ?? DEFAULT_MAX_REGENS_PER_KEY;
  // Per-instance (≈ per chat session) tally of how many times each key
  // has been dispatched. Lives in this closure so a fresh tool gets a
  // fresh budget.
  const regensByKey = new Map<string, number>();

  return defineTool({
    name: 'dhee_regenerate_node',
    label: 'Regenerate node',
    description:
      "Invalidate a single node (or a single collection item) and re-run it + everything downstream. Use when the user is unhappy with one specific output. Don't use to re-run the whole project — call dhee_start_run for that.",
    parameters: Params,
    async execute(_id, params, signal) {
      const key = params.itemId ? `${params.nodeId}:${params.itemId}` : params.nodeId;
      const projectJsonPath = join(params.projectDir, 'project.json');
      if (!existsSync(projectJsonPath)) {
        return textResult(`project.json not found at ${projectJsonPath}`, true);
      }

      // Budget gate (credit-burn guard): refuse a (cap+1)th regen of the
      // same key BEFORE any paid runner call. Scoped per projectDir so
      // two projects don't share a budget.
      const budgetKey = `${params.projectDir}::${key}`;
      const used = regensByKey.get(budgetKey) ?? 0;
      if (used >= cap) {
        return textResult(
          `Regeneration limit reached for '${key}' — ${cap} regenerations this session. ` +
            `Refusing to spend more credits re-rolling the same node. Instead: pick an existing ` +
            `candidate (dhee_list_versions → dhee_select_version), critique it differently ` +
            `(dhee_critique_node), or start a fresh run if this is intentional.`,
          true,
        );
      }
      regensByKey.set(budgetKey, used + 1);

      // Back-compat for unit tests/headless callers that inject the old
      // synchronous runner seam. The exported production tool below does
      // not set this dep, so real chat-driven regenerations stay detached.
      if (deps.runProjectViaBundle) {
        const result = await regenerateNode({
          projectDir: params.projectDir,
          nodeId: params.nodeId,
          ...(params.itemId ? { itemId: params.itemId } : {}),
          ...(signal ? { signal } : {}),
          runProjectViaBundle: deps.runProjectViaBundle,
        });
        if (!result.ok) {
          return textResult(
            `Regenerate of '${key}' failed: ${result.error ?? '(no error)'}`,
            true,
          );
        }
        return textResult(`Regenerated '${key}'. Downstream nodes cascade-rerun via walker.`);
      }

      const runner = deps.getBackgroundTaskRunner
        ? await deps.getBackgroundTaskRunner()
        : await defaultGetBackgroundTaskRunner();
      const active = runner.getActive?.();
      if (active) {
        return textResult(
          `Another bundle run is already in flight (taskId=${active.id} on project '${active.spec.projectName}'). Stop it first with dhee_stop_run, or wait for it to finish.`,
          true,
        );
      }
      if (isWalkLocked(params.projectDir)) {
        return textResult(
          `cannot regenerate '${key}': a walk is already in progress for this project. Stop it first with dhee_stop_run, or wait for it to finish, then retry.`,
          true,
        );
      }

      const inv = await invalidateNodes({
        projectDir: params.projectDir,
        nodeIds: [key],
        source: 'chat-regenerate',
      });
      if (inv.error) {
        return textResult(`Regenerate of '${key}' failed: ${inv.error}`, true);
      }

      const dispatch = runner.dispatch({
        kind: 'run_to',
        projectName: basename(params.projectDir),
        params: { projectDir: params.projectDir },
        sessionId: `dhee_regenerate_node:${basename(params.projectDir)}`,
      });

      if (dispatch.status === 'rejected') {
        return textResult(
          `Another bundle run is already in flight (taskId=${dispatch.activeTaskId} on project '${dispatch.activeProjectName}'). Stop it first with dhee_stop_run, or wait for it to finish.`,
          true,
        );
      }

      return textResult(
        `Regeneration of '${key}' started in the background (taskId=${dispatch.taskId}). It will continue while we talk; I'll be notified when it finishes.`,
      );
    },
  });
}

export const dheeRegenerateNodeTool = makeRegenerateNodeTool();
