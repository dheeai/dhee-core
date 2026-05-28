/**
 * dhee_read_artifact — read the produced artifact for a node.
 *
 * For text-shaped files (md, json, txt, srt, etc.) returns the
 * content inline. For binary/media (png, jpg, mp4, mp3, wav, etc.)
 * returns the resolved path + file size — bytes don't belong in an
 * LLM context, and pi has separate image/video display affordances
 * the user wires up if they want inline previews.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  nodeId: Type.String({
    description:
      "Node id from the bundle (e.g. 'story', 'shot_image_prompt', 'shot_image'). For collection nodes pair with itemId.",
  }),
  itemId: Type.Optional(
    Type.String({
      description:
        "Optional item id for collection nodes (e.g. 'scene_1_shot_3'). When provided we look up the 'nodeId:itemId' walkState entry.",
    }),
  ),
});

const TEXT_EXTENSIONS = new Set(['.md', '.json', '.txt', '.srt', '.vtt', '.log', '.csv']);
const TEXT_INLINE_LIMIT_BYTES = 64 * 1024;

interface NodeEntry {
  status?: string;
  outputPath?: string;
  itemId?: string;
}
interface ProjectJsonLite {
  walkState?: { nodes?: Record<string, NodeEntry> };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function makeReadArtifactTool() {
  return defineTool({
    name: 'dhee_read_artifact',
    label: 'Read artifact',
    description:
      "Read the file a node produced. Text artifacts (md/json/text) are returned inline; binary/media artifacts return path + size. Use after dhee_get_status reveals a 'completed' node you want to inspect.",
    parameters: Params,
    async execute(_id, params) {
      const projectJsonPath = join(params.projectDir, 'project.json');
      if (!existsSync(projectJsonPath)) {
        return textResult(`project.json not found at ${projectJsonPath}`, true);
      }
      let project: ProjectJsonLite;
      try {
        project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
      } catch (err) {
        return textResult(`project.json failed to parse: ${(err as Error).message}`, true);
      }
      const nodes = project.walkState?.nodes ?? {};
      const key = params.itemId ? `${params.nodeId}:${params.itemId}` : params.nodeId;
      const entry = nodes[key];
      if (!entry) {
        return textResult(`Node '${key}' not found in walkState. Has it run yet?`, true);
      }
      if (!entry.outputPath) {
        return textResult(
          `Node '${key}' is ${entry.status ?? 'unknown'} and has no outputPath. Nothing to read.`,
          true,
        );
      }
      const abs = isAbsolute(entry.outputPath)
        ? entry.outputPath
        : resolve(params.projectDir, entry.outputPath);
      if (!existsSync(abs)) {
        return textResult(
          `Node '${key}' outputPath '${entry.outputPath}' does not exist on disk (file deleted?).`,
          true,
        );
      }
      const ext = extname(abs).toLowerCase();
      const size = statSync(abs).size;
      if (TEXT_EXTENSIONS.has(ext)) {
        if (size > TEXT_INLINE_LIMIT_BYTES) {
          return textResult(
            `${abs} (${formatBytes(size)}) — too large to inline. Use read on the file directly if you need it.`,
          );
        }
        const content = readFileSync(abs, 'utf8');
        return textResult(`${abs} (${formatBytes(size)}):\n\n${content}`);
      }
      return textResult(`${abs} (${formatBytes(size)}, binary; not inlined).`);
    },
  });
}

export const dheeReadArtifactTool = makeReadArtifactTool();
