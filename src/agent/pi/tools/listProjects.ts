import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getProjectsDir } from "../paths.js";

const Params = Type.Object({});

export interface ProjectSummary {
  name: string;
  title?: string;
  style?: string;
  phase?: string;
  templateId?: string;
  hasProjectJson: boolean;
}

export interface ListProjectsDetails {
  count: number;
  projects: ProjectSummary[];
}

export const dheeListProjects = defineTool({
  name: "dhee_list_projects",
  label: "dhee list-projects",
  description: "List all dhee projects in the repo. Includes both `*.dhee` directories (canonical) and bare-name folders that contain a `project.json` (dhee-desktop's NewProjectDialog convention). Returns each project's name, current phase, style, and title where available.",
  parameters: Params,
  async execute(_id, _params: Static<typeof Params>): Promise<AgentToolResult<ListProjectsDetails>> {
    const entries = await readdir(getProjectsDir(), { withFileTypes: true });
    // Two conventions are accepted:
    //   1. `<name>.dhee/` (canonical, every dhee-core CLI project)
    //   2. `<name>/` containing `project.json` (dhee-desktop's
    //      NewProjectDialog default)
    // Pre-fix this filtered to (1) only, hiding desktop-created
    // projects entirely — pi-agent then guessed the active project
    // from whatever .dhee sibling happened to exist.
    const candidates: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.endsWith(".dhee")) {
        candidates.push(e.name);
        continue;
      }
      // Bare-name folder qualifies only when it actually carries a
      // project.json — otherwise random sibling folders in the
      // workspace would pollute the listing.
      try {
        await stat(join(getProjectsDir(), e.name, "project.json"));
        candidates.push(e.name);
      } catch {
        // No project.json — not a dhee project.
      }
    }
    const projectDirs = candidates.sort();

    const summaries: ProjectSummary[] = [];
    for (const dirname of projectDirs) {
      const name = dirname.replace(/\.dhee$/, "");
      const projectJson = join(getProjectsDir(), dirname, "project.json");
      let summary: ProjectSummary = { name, hasProjectJson: false };
      try {
        await stat(projectJson);
        const raw = await readFile(projectJson, "utf8");
        const parsed = JSON.parse(raw) as {
          title?: string;
          style?: string;
          currentPhase?: string;
          templateId?: string;
        };
        summary = {
          name,
          title: parsed.title,
          style: parsed.style,
          phase: parsed.currentPhase,
          templateId: parsed.templateId,
          hasProjectJson: true,
        };
      } catch {
        // No project.json or unparseable — keep minimal summary.
      }
      summaries.push(summary);
    }

    const text = formatSummaries(summaries);
    return {
      content: [{ type: "text", text }],
      details: { count: summaries.length, projects: summaries },
    };
  },
});

function formatSummaries(projects: ProjectSummary[]): string {
  if (projects.length === 0) {
    return "No dhee projects found in the repo root.";
  }
  const lines = [`Found ${projects.length} project(s):`, ""];
  for (const p of projects) {
    const tag = p.hasProjectJson ? "" : " (no project.json — bare folder)";
    const meta = [
      p.title ? `title: ${p.title}` : null,
      p.style ? `style: ${p.style}` : null,
      p.templateId ? `template: ${p.templateId}` : null,
      p.phase ? `phase: ${p.phase}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`  ${p.name}${tag}${meta ? `\n      ${meta}` : ""}`);
  }
  return lines.join("\n");
}
