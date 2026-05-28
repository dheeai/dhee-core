/**
 * dhee_run_bundle — dispatch a bundle DAG run for a project.
 *
 * Awaits the run synchronously. The pi-coding-agent loop will keep
 * the tool call open until the runner resolves; the LLM provider's
 * connection isn't held open during that wait (tool execution
 * happens between LLM round-trips), so multi-minute runs are fine.
 *
 * For long-lived hosts (the desktop), the tool can be swapped for a
 * version that dispatches into BackgroundTaskRunner and returns a
 * taskId immediately. That's a separate concern from the CLI driver.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import type {
  RunProjectViaBundleOpts,
  RunProjectViaBundleResult,
} from '../../../server/runners/runProjectViaBundle.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  stopAt: Type.Optional(
    Type.String({
      description:
        "Optional node id to stop after (e.g. 'shot_image' to halt before video generation). Useful for staged review.",
    }),
  ),
  /**
   * Vertex-friendly representation of runOnly: a JSON string of an
   * array (per Landmine 3 in DRIVING_PI_FROM_CLAUDE_CODE.md), but
   * we also accept a real array if the model emits one.
   */
  runOnly: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional list of node ids to run only (with their downstream). Equivalent to right-click-regenerate from the UI but for arbitrary nodes.',
    }),
  ),
});

export interface RunBundleDeps {
  /** Injected for tests. Production default = the real runner. */
  runProjectViaBundle?: (opts: RunProjectViaBundleOpts) => Promise<RunProjectViaBundleResult>;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

async function defaultRunner(opts: RunProjectViaBundleOpts): Promise<RunProjectViaBundleResult> {
  const mod = await import('../../../server/runners/runProjectViaBundle.js');
  return mod.runProjectViaBundle(opts);
}

export function makeRunBundleTool(deps: RunBundleDeps = {}) {
  const runner = deps.runProjectViaBundle ?? defaultRunner;
  return defineTool({
    name: 'dhee_run_bundle',
    label: 'Run bundle',
    description:
      'Dispatch the bundle DAG for a project. Returns when the run finishes (success or failure). Pass stopAt to halt at an earlier stage, or runOnly to re-run specific nodes (cascades to their downstream).',
    parameters: Params,
    async execute(_id, params, signal) {
      const projectJsonPath = join(params.projectDir, 'project.json');
      if (!existsSync(projectJsonPath)) {
        return textResult(`project.json not found at ${projectJsonPath}`, true);
      }
      const opts: RunProjectViaBundleOpts = {
        projectDir: params.projectDir,
        ...(params.stopAt ? { stopAt: params.stopAt } : {}),
        ...(params.runOnly ? { runOnly: params.runOnly } : {}),
        ...(signal ? { signal } : {}),
      };
      let result: RunProjectViaBundleResult;
      try {
        result = await runner(opts);
      } catch (err) {
        return textResult(`runProjectViaBundle threw: ${(err as Error).message}`, true);
      }
      if (!result.ok) {
        return textResult(`Bundle run failed: ${result.error ?? '(no error message)'}`, true);
      }
      const lines = [`Bundle run completed.`];
      if (result.finalVideoAbs) lines.push(`Final video: ${result.finalVideoAbs}`);
      return textResult(lines.join('\n'));
    },
  });
}

export const dheeRunBundleTool = makeRunBundleTool();
