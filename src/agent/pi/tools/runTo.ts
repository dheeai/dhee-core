import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runExecutor } from "../../../server/runners/runExecutor.js";
import { classifyRunTarget } from "../../../server/runners/classifyRunTarget.js";
import { resolveNodeId, type ExecutorState } from "../../../core/project/projectTypes.js";
import { getProjectsDir } from "../paths.js";
import {
  resolveProjectDir,
  ProjectDirNotFoundError,
} from "./resolveProjectDir.js";
import type { GenericProjectFile } from "../../../core/templates/types.js";
import type { AssetEvent } from "./parseAssetLines.js";

export interface MediaEvent extends AssetEvent {
  /** Project name (no .dhee suffix) — captured from the tool params. */
  project: string;
  /** Tool that produced this asset, for downstream display. */
  source: string;
}

export type MediaCallback = (event: MediaEvent) => void;

const Params = Type.Object({
  project: Type.String({ description: "Project name" }),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to the project folder. Pass this when the host (e.g. dhee-desktop) created the project at a workspace path that doesn't follow the default `<name>.dhee` convention. When omitted, the tool probes <projectsDir>/<name>.dhee and then <projectsDir>/<name>.",
    }),
  ),
  stage: Type.Optional(
    Type.String({
      description:
        "Stage to pause at, e.g. character_image, shot_image, shot_video. Or a node id like shot_image:scene_1_shot_2. Omit to run to completion.",
    }),
  ),
  skip_media: Type.Optional(
    Type.Boolean({ description: "Skip ComfyUI image/video generation; only run LLM prompt stages." }),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal('all'), Type.Literal('last_invalidated')], {
      description:
        "Run scope. 'all' (default) drains every pending node in the graph (continue-from-here). 'last_invalidated' runs ONLY the nodes set by the most-recent dhee_invalidate call — leaves all other pending work alone. Use this after dhee_invalidate when the user wants a single targeted regeneration without auto-cascading into other unfinished work.",
    }),
  ),
});

interface RunToDetails {
  status: string;
  stopReason: string | null;
  log: string;
}

function failure(message: string): { content: { type: "text"; text: string }[]; details: RunToDetails } {
  return {
    content: [{ type: "text", text: message }],
    details: { status: "failed", stopReason: null, log: message },
  };
}

export function createRunToTool(opts?: {
  onMedia?: MediaCallback;
  /**
   * Session id used to route runner events back to the originating
   * chat. When set, `dhee_run_to` dispatches to the background
   * task runner and returns immediately — keeping the chat
   * responsive while the run executes detached. When unset (legacy
   * CLI / test paths), the tool runs inline, blocking until done.
   */
  sessionId?: string;
}): ToolDefinition {
  return defineTool({
    name: "dhee_run_to",
    label: "dhee run-to",
    description:
      "Drive the dhee pipeline on a project up to a stage (or to completion). Returns immediately when run from a desktop chat session — the run executes off the agent's tool-call loop on the background task runner so chat stays responsive. Progress streams in as discrete events.",
    parameters: Params,
    executionMode: "sequential",
    async execute(_id, params: Static<typeof Params>, signal, onUpdate) {
      // Desktop / chat path: dispatch to the runner and return fast.
      // The runner emits events back through ConversationManager →
      // the originating session's IPC stream → the chat.
      if (opts?.sessionId) {
        const { getBackgroundTaskRunner } = await import(
          "../../../server/runners/backgroundTaskRunnerSingleton.js"
        );
        const runner = getBackgroundTaskRunner();
        const result = runner.dispatch({
          kind: "run_to",
          projectName: params.project,
          sessionId: opts.sessionId,
          params: {
            ...(params.projectDir ? { projectDir: params.projectDir } : {}),
            ...(params.stage ? { stage: params.stage } : {}),
            ...(params.skip_media ? { skip_media: params.skip_media } : {}),
            ...(params.scope ? { scope: params.scope } : {}),
          },
        });
        if (result.status === "started") {
          const text = `Started run_to task ${result.taskId}${params.stage ? ` (stage='${params.stage}')` : ""}. Progress will stream below.`;
          return {
            content: [{ type: "text", text }],
            details: { status: "running", stopReason: null, log: text },
          };
        }
        const text = `Cannot start: task ${result.activeTaskId} (${result.activeTaskKind}) is already running on '${result.activeProjectName}'. Use dhee_task_cancel to abort it, or wait.`;
        return {
          content: [{ type: "text", text }],
          details: { status: "rejected", stopReason: null, log: text },
        };
      }

      // Legacy inline path (no sessionId, e.g. CLI smoke tests).
      let projectDir: string;
      try {
        projectDir = resolveProjectDir({
          name: params.project,
          basePath: getProjectsDir(),
          ...(params.projectDir ? { projectDir: params.projectDir } : {}),
        });
      } catch (err) {
        if (err instanceof ProjectDirNotFoundError) {
          // Surface the attempted paths so the LLM doesn't try to
          // "fix" by renaming/mv'ing the folder.
          return failure(
            `${err.message}. Pass projectDir as an absolute path if the project lives outside the default projects directory; do NOT rename the folder.`,
          );
        }
        return failure((err as Error).message);
      }
      const projectJsonPath = join(projectDir, "project.json");
      if (!existsSync(projectJsonPath)) return failure(`project.json not found in ${projectDir}`);
      const project = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as GenericProjectFile;

      // Resolve target. Aliases (`scene_1_shot_2.image`) need the
      // project's executorState; bare stages and full node ids don't.
      let resolvedTarget: { stage?: string; nodeId?: string };
      try {
        const classified = classifyRunTarget(params.stage ?? null);
        if (classified.alias) {
          const state = (project as unknown as { executorState?: ExecutorState }).executorState;
          if (!state) {
            return failure(
              `Cannot resolve alias '${classified.alias}' — project has no executorState yet. Run dhee_run_to without a target first to bootstrap.`,
            );
          }
          const resolved = resolveNodeId(state, classified.alias);
          if (!resolved) {
            return failure(
              `Unknown alias: '${classified.alias}'. No matching node in this project's graph.`,
            );
          }
          resolvedTarget = { nodeId: resolved };
        } else {
          resolvedTarget = {
            ...(classified.stage ? { stage: classified.stage } : {}),
            ...(classified.nodeId ? { nodeId: classified.nodeId } : {}),
          };
        }
      } catch (err) {
        return failure((err as Error).message);
      }

      // Stream progress text via onUpdate so chat shows live status.
      const logLines: string[] = [];
      const pushLog = (line: string) => {
        logLines.push(line);
        onUpdate?.({
          content: [{ type: "text", text: line }],
          details: { status: "running", stopReason: null, log: logLines.join("\n") },
        });
      };

      // Inline path: same last-invalidated whitelist semantics as the
      // dispatch path so CLI / smoke-test invocations honor scope too.
      let inlineRunOnly: string[] | undefined;
      if (params.scope === 'last_invalidated') {
        const state = (project as unknown as {
          executorState?: { lastInvalidatedIds?: string[] };
        }).executorState;
        inlineRunOnly = state?.lastInvalidatedIds ?? [];
      }

      const result = await runExecutor({
        project,
        projectDir,
        target: {
          ...resolvedTarget,
          ...(params.skip_media ? { skipMedia: true } : {}),
          ...(inlineRunOnly ? { runOnly: inlineRunOnly } : {}),
        },
        ...(signal ? { signal } : {}),
        name: "pi-agent-run-to",
        onTool: (info) => {
          const hint = info.nodeId ? ` ${info.nodeId}` : "";
          pushLog(`  [${info.toolName}]${hint}`);
        },
        onResult: (info) => {
          if (info.filePath) pushLog(`    → ${info.filePath}`);
          else if (info.status) pushLog(`    → ${info.status}`);
        },
        onNotification: (info) => {
          pushLog(`  [${info.level}] ${info.message}`);
        },
        ...(opts?.onMedia
          ? {
              onAsset: (event) => {
                opts.onMedia!({
                  kind: event.kind,
                  path: event.filePath,
                  project: params.project,
                  source: "dhee_run_to",
                });
              },
            }
          : {}),
      });

      const summary =
        result.status === "completed"
          ? `Run finished. status=${result.status} stopReason=${result.stopReason ?? "(none)"}`
          : result.status === "cancelled"
            ? `Run cancelled by user.`
            : `Run failed. status=${result.status} stopReason=${result.stopReason ?? "(none)"}${result.error ? ` error=${result.error}` : ""}`;
      logLines.push(summary);

      return {
        content: [{ type: "text", text: summary }],
        details: {
          status: result.status,
          stopReason: result.stopReason,
          log: logLines.join("\n"),
        },
      };
    },
  });
}

/** Backwards-compatible export used by the TUI / smoke paths (no media bridge). */
export const dheeRunTo: ToolDefinition = createRunToTool();
