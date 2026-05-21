/**
 * `dhee_invalidate` — unified invalidation tool.
 *
 * Replaces the old triple of `dhee_regen` + `dhee_reset` (LLM) and
 * the UI's redoNode IPC. One operation: pick a selection, mark those
 * nodes pending. Never runs — the user explicitly says go via
 * `dhee_run_to`. Two run modes are then available downstream:
 *   - `dhee_run_to`                          → continue from here
 *     (runs every pending node in the graph)
 *   - `dhee_run_to scope='last_invalidated'` → run ONLY what was
 *     just invalidated (uses the whitelist this op writes to
 *     `executorState.lastInvalidatedIds`).
 *
 * Three selection modes:
 *   - `node`  — single node id or alias  (e.g. "scene_1_shot_2.prompt")
 *   - `type`  — every node of a typeId    (e.g. "shot_image_prompt")
 *   - `stage` — type cone via TEMPLATE_DEPS (e.g. "shot_image_prompt")
 */
import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getProjectsDir } from "../paths.js";
import { resolveProjectDir, ProjectDirNotFoundError } from "./resolveProjectDir.js";
import { selectInvalidationIds } from "../../../core/planner/selectInvalidationIds.js";
import { applyInvalidation } from "../../../core/planner/applyInvalidation.js";
import type { ProjectFile } from "../../../core/project/projectTypes.js";

const Params = Type.Object({
  project: Type.String({ description: "Project name." }),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to the project folder. Pass when the host (e.g. dhee-desktop) created the project at a workspace path that doesn't follow the default `<name>.dhee` convention.",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description:
        "Single node id (e.g. 'shot_image:scene_1_shot_2') or friendly alias ('scene_1_shot_2.image', 'scene_2.svp'). Mutually exclusive with `type` and `stage`.",
    }),
  ),
  type: Type.Optional(
    Type.String({
      description:
        "TypeId — selects EVERY node of this type across the project (e.g. 'shot_image_prompt' → all per-shot prompts plus the type-level collection node). Mutually exclusive with `node` and `stage`.",
    }),
  ),
  stage: Type.Optional(
    Type.String({
      description:
        "Stage alias (e.g. 'shot_image_prompt', 'shot_video') — selects the start type's full type cone via TEMPLATE_DEPS. Use this to invalidate a stage AND every downstream stage by type. Mutually exclusive with `node` and `type`.",
    }),
  ),
});

export interface InvalidateDetails {
  status: "completed" | "failed";
  log: string;
  invalidated: string[];
  notFound: string[];
}

function failure(message: string): AgentToolResult<InvalidateDetails> {
  return {
    content: [{ type: "text", text: message }],
    details: { status: "failed", log: message, invalidated: [], notFound: [] },
  };
}

export const dheeInvalidate = defineTool({
  name: "dhee_invalidate",
  label: "dhee invalidate",
  description:
    "Invalidate a selection of nodes (mark them pending) so the next dhee_run_to regenerates them. Three selection modes: `node` (single id/alias), `type` (every node of a typeId), `stage` (type cone — start type plus every downstream type). Cascades to transitive dependents — invalidating a single shot_video also marks the dependent final_video pending so the next run actually re-renders it. Does NOT run the pipeline — call dhee_run_to after. Use `dhee_run_to scope='last_invalidated'` to run ONLY the just-invalidated set (which now includes the cascaded dependents).\n\nPer-shot regen taxonomy — pick the right node id for the user's intent:\n  - 'redo whole shot N' → call this tool TWICE: `shot_image:scene_N_shot_M` AND `shot_image_last_frame:scene_N_shot_M`. (Both get cascaded to video + final_video.)\n  - 'redo only the LAST frame of shot N' → `shot_image_last_frame:scene_N_shot_M` ONLY. First frame stays; last frame re-renders against existing first frame as base; video re-stitches.\n  - 'redo only the FIRST frame of shot N' → rare; first-frame invalidation cascades to last_frame anyway, so this is effectively a whole-shot redo. Confirm with the user that they actually want this and not a whole-shot regen.\n  - 'redo just the video of shot N (motion changed, keep frames)' → `shot_video:scene_N_shot_M`.\n  - 'rewrite the image prompt for shot N' → `shot_image_prompt:scene_N_shot_M` (cascades everything: prompt → first frame → last frame → video → final_video).\n\nIMPORTANT: invalidating a node re-runs its producer LLM, which writes a fresh file and overwrites whatever is on disk. If you just hand-wrote that file (e.g. authored a motion directive at `prompts/motion/scene_N_shot_M.json` or an image prompt at `prompts/images/shots/scene-N-shot-M.json`), invalidate the CONSUMER node, not the producer — e.g. `shot_video:scene_N_shot_M` (not `shot_motion_directive:…`) to keep an authored motion directive, or `shot_image:scene_N_shot_M` (not `shot_image_prompt:…`) to keep an authored image prompt. Invalidating the producer wipes your text on the next dispatch.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>): Promise<AgentToolResult<InvalidateDetails>> {
    let projectDir: string;
    try {
      projectDir = resolveProjectDir({
        name: params.project,
        basePath: getProjectsDir(),
        ...(params.projectDir ? { projectDir: params.projectDir } : {}),
      });
    } catch (err) {
      if (err instanceof ProjectDirNotFoundError) return failure(err.message);
      throw err;
    }

    const projectJsonPath = join(projectDir, "project.json");
    if (!existsSync(projectJsonPath)) {
      return failure(`project.json not found in ${projectDir}`);
    }

    const project = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as ProjectFile;
    if (!project.executorState || !project.executorState.nodes) {
      return failure(
        "Cannot invalidate — project has no executorState. Run a stage first (dhee_run_to).",
      );
    }

    let ids: string[];
    try {
      ids = selectInvalidationIds(project.executorState, {
        ...(params.node !== undefined ? { node: params.node } : {}),
        ...(params.type !== undefined ? { type: params.type } : {}),
        ...(params.stage !== undefined ? { stage: params.stage } : {}),
      });
    } catch (err) {
      return failure((err as Error).message);
    }

    if (ids.length === 0) {
      const target =
        params.node ?? params.type ?? params.stage ?? "(none)";
      return failure(
        `No nodes matched the selection '${target}'. Check dhee_list_items for available ids/types.`,
      );
    }

    const result = applyInvalidation(
      project as unknown as { executorState: typeof project.executorState },
      ids,
    );
    writeFileSync(projectJsonPath, JSON.stringify(project, null, 2), "utf-8");

    const summary =
      `Invalidated ${result.invalidated.length} node(s): ` +
      `${result.invalidated.slice(0, 8).join(", ")}` +
      `${result.invalidated.length > 8 ? `, …(+${result.invalidated.length - 8} more)` : ""}` +
      `. Use dhee_run_to to continue from here, or dhee_run_to scope='last_invalidated' to run ONLY this set.`;

    return {
      content: [{ type: "text", text: summary }],
      details: {
        status: "completed",
        log: summary,
        invalidated: result.invalidated,
        notFound: result.notFound,
      },
    };
  },
});
