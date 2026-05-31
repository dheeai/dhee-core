import { readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getProjectsDir } from "../paths.js";
import { resolveProjectDir } from "./resolveProjectDir.js";

const Params = Type.Object({
  project: Type.String({ description: "Project name" }),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to the project folder. Pass when the host has already focused a workspace folder outside the default projects directory.",
    }),
  ),
  path: Type.String({
    description: "Path inside the project folder, e.g. project.json, scenes/scene_1.md",
  }),
});

export interface ReadArtifactDetails {
  projectDir: string;
  resolvedPath: string;
  bytes: number;
}

export const dheeReadArtifact = defineTool({
  name: "dhee_read_artifact",
  label: "dhee read-artifact",
  description: "Read a file inside a dhee project folder. Path is resolved against the resolved project directory. Reads outside the project folder are rejected.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>): Promise<AgentToolResult<ReadArtifactDetails>> {
    const projectDir = resolveProjectDir({
      name: params.project,
      basePath: getProjectsDir(),
      ...(params.projectDir ? { projectDir: params.projectDir } : {}),
    });
    const target = resolve(projectDir, params.path);
    const rel = relative(projectDir, target);
    if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(target) !== target) {
      throw new Error(`Path '${params.path}' resolves outside project '${params.project}'`);
    }
    const content = await readFile(target, "utf8");
    return {
      content: [{ type: "text", text: content }],
      details: { projectDir, resolvedPath: target, bytes: Buffer.byteLength(content, "utf8") },
    };
  },
});
