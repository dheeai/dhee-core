/**
 * dhee_show_node_output — show a bundle node's output file inline in
 * the chat panel.
 *
 * Different from dhee_read_artifact (which inlines text content or
 * returns path+size for binaries): show_node_output returns a
 * `details.file_path` envelope the renderer detects and renders
 * inline as <img>/<video>/<audio> per extension. The text content
 * is just a short human acknowledgement.
 *
 * Resolves outputPath via walkState (same lookup as read_artifact).
 * Works for any bundle node, not just the executor-era scene/shot
 * concepts the old `dhee_show_first_frame` / `dhee_show_shot_video`
 * tools assumed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  nodeId: Type.String({
    description:
      "Node id from the bundle. For collection nodes pair with itemId. Examples: 'final_video', 'shot_image', 'character_image', 'plot'.",
  }),
  itemId: Type.Optional(
    Type.String({
      description: "For collection nodes, the specific item to show (e.g. 'scene_1_shot_3').",
    }),
  ),
});

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);

interface NodeEntry {
  status?: string;
  outputPath?: string;
  itemId?: string;
}

interface ProjectJsonLite {
  walkState?: { nodes?: Record<string, NodeEntry> };
}

function inferAssetType(ext: string): 'image' | 'video' | 'audio' | 'unknown' {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'unknown';
}

function textResult(text: string, isError = false, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

export function makeShowNodeOutputTool() {
  return defineTool({
    name: 'dhee_show_node_output',
    label: 'Show node output',
    description:
      "Display a bundle node's output file inline in the chat. The chat panel renders images, videos, and audio inline; other file types appear as a path. Use this after dhee_start_run / dhee_regenerate_node when you want the user to see what was generated. For arbitrary on-disk files outside the bundle's walkState (e.g. user-uploaded refs), use dhee_show_file instead.",
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
          `Node '${key}' is ${entry.status ?? 'unknown'} and has no outputPath.`,
          true,
        );
      }
      const abs = isAbsolute(entry.outputPath)
        ? entry.outputPath
        : resolve(params.projectDir, entry.outputPath);
      if (!existsSync(abs)) {
        return textResult(
          `Node '${key}' outputPath '${entry.outputPath}' does not exist on disk.`,
          true,
        );
      }
      const ext = extname(abs).toLowerCase();
      const assetType = inferAssetType(ext);
      const stats = statSync(abs);
      return textResult(
        `${abs} (${assetType}, ${stats.size} bytes)`,
        false,
        {
          file_path: abs,
          asset_type: assetType,
          node_id: params.nodeId,
          item_id: params.itemId ?? null,
          created_at: Math.floor(stats.mtimeMs),
        },
      );
    },
  });
}

export const dheeShowNodeOutputTool = makeShowNodeOutputTool();
