import { readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getProjectsDir } from "../paths.js";

const Params = Type.Object({
  project: Type.String({ description: "Project name" }),
  path: Type.String({
    description: "Path inside the project folder, e.g. project.json, scenes/scene_1.md",
  }),
});

export interface ReadArtifactDetails {
  resolvedPath: string;
  bytes: number;
}

export const dheeReadArtifact = defineTool({
  name: "dhee_read_artifact",
  label: "dhee read-artifact",
  description: "Read a file inside a dhee project folder. Path is resolved against <project>.dhee/. Reads outside the project folder are rejected.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>): Promise<AgentToolResult<ReadArtifactDetails>> {
    const projectDir = resolve(getProjectsDir(), `${params.project}.dhee`);
    const target = resolve(projectDir, params.path);
    const rel = relative(projectDir, target);
    if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(target) !== target) {
      throw new Error(`Path '${params.path}' resolves outside project '${params.project}'`);
    }
    const content = await readFile(target, "utf8");
    return {
      content: [{ type: "text", text: content }],
      details: { resolvedPath: target, bytes: Buffer.byteLength(content, "utf8") },
    };
  },
});
