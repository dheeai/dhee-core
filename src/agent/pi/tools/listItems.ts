import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectsDir } from "../paths.js";
import type { ProjectFile, ExecutorState } from "../../../server/agentOps.js";
import { resolveProjectDir, ProjectDirNotFoundError } from "./resolveProjectDir.js";

const Params = Type.Object({
  project: Type.String({ description: "Project name" }),
  type: Type.Optional(
    Type.String({ description: "Filter by node typeId, e.g. shot_image, shot_video_prompt" }),
  ),
  status: Type.Optional(
    Type.String({ description: "Filter by status: pending, running, terminal, failed" }),
  ),
  grep: Type.Optional(
    Type.String({ description: "Regex match against node id" }),
  ),
});

export interface ListItemsDetails {
  status: string;
  log: string;
  total: number;
  matches: number;
}

function failure(message: string): { content: { type: "text"; text: string }[]; details: ListItemsDetails } {
  return {
    content: [{ type: "text", text: message }],
    details: { status: "failed", log: message, total: 0, matches: 0 },
  };
}

/**
 * `terminal` is the union of completed | failed | skipped — a node is
 * "done one way or another." Mirrors the same shorthand the CLI uses.
 */
function statusMatches(filter: string | undefined, status: string): boolean {
  if (!filter) return true;
  if (filter === 'terminal') return status === 'completed' || status === 'failed' || status === 'skipped';
  return status === filter;
}

export const dheeListItems = defineTool({
  name: "dhee_list_items",
  label: "dhee list-items",
  description:
    "List nodes in a dhee project's dependency graph. Optionally filter by typeId, status, or a regex over node ids.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>) {
    let projectDir: string;
    try {
      projectDir = resolveProjectDir({
        name: params.project,
        basePath: getProjectsDir(),
      });
    } catch (err) {
      if (err instanceof ProjectDirNotFoundError) return failure(err.message);
      throw err;
    }
    const projectJsonPath = join(projectDir, "project.json");
    if (!existsSync(projectJsonPath)) return failure(`project.json not found in ${projectDir}`);

    const project = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as ProjectFile;
    const state: ExecutorState | undefined = project.executorState;
    const nodes = Object.values(state?.nodes ?? {});

    let grepRe: RegExp | null = null;
    if (params.grep) {
      try { grepRe = new RegExp(params.grep); } catch (err) {
        return failure(`Invalid grep regex: ${(err as Error).message}`);
      }
    }

    const filtered = nodes.filter(n => {
      if (params.type && n.typeId !== params.type) return false;
      if (!statusMatches(params.status, n.status)) return false;
      if (grepRe && !grepRe.test(n.id)) return false;
      return true;
    });

    const sorted = [...filtered].sort((a, b) => a.id.localeCompare(b.id));
    const lines = sorted.map(n => {
      const errSuffix = n.error ? ` — ${n.error.split('\n')[0]}` : '';
      return `  ${n.id} [${n.status}]${errSuffix}`;
    });
    const header = `Project: ${project.title} — ${filtered.length}/${nodes.length} matching nodes`;
    const filters: string[] = [];
    if (params.type) filters.push(`type=${params.type}`);
    if (params.status) filters.push(`status=${params.status}`);
    if (params.grep) filters.push(`grep=${params.grep}`);
    const filterLine = filters.length > 0 ? ` (filters: ${filters.join(', ')})` : '';

    const text = [`${header}${filterLine}`, ...lines].join('\n');
    return {
      content: [{ type: "text", text }],
      details: { status: "completed", log: text, total: nodes.length, matches: filtered.length },
    };
  },
});
