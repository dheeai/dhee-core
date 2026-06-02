/**
 * dhee_show_file — show an arbitrary on-disk file inline in the chat.
 *
 * Companion to dhee_show_node_output: use this when the path is not
 * a bundle node's outputPath (e.g. user-uploaded reference images,
 * exported timelines, screenshot scratch files). The chat panel
 * renders inline based on extension; the tool's text reply is a
 * short acknowledgement.
 *
 * SAFETY: returns an error if the path does not exist on disk. Does
 * NOT validate that the file is "safe" to show — the agent decides
 * whether to call this; the user supplied the path.
 */

import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

const Params = Type.Object({
  filePath: Type.String({
    description: 'Absolute path to the file to show. Must exist on disk.',
  }),
  caption: Type.Optional(
    Type.String({
      description: 'Optional one-line caption shown above the inline media.',
    }),
  ),
});

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);

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

export function makeShowFileTool() {
  return defineTool({
    name: 'dhee_show_file',
    label: 'Show file',
    description:
      "Display an arbitrary on-disk file inline in the chat (image, video, or audio). Use for files that are NOT bundle node outputs (e.g. user-supplied reference images, exported timelines). For bundle-node artifacts, prefer dhee_show_node_output — that one resolves the path via walkState and gives the user a node-id reference back.",
    parameters: Params,
    async execute(_id, params) {
      if (!isAbsolute(params.filePath)) {
        return textResult(`filePath must be absolute, got: ${params.filePath}`, true);
      }
      if (!existsSync(params.filePath)) {
        return textResult(`File does not exist: ${params.filePath}`, true);
      }
      const ext = extname(params.filePath).toLowerCase();
      const assetType = inferAssetType(ext);
      const stats = statSync(params.filePath);
      const headline = params.caption
        ? `${params.caption} — ${params.filePath}`
        : `${params.filePath} (${assetType}, ${stats.size} bytes)`;
      return textResult(headline, false, {
        file_path: params.filePath,
        asset_type: assetType,
        ...(params.caption ? { caption: params.caption } : {}),
        created_at: Math.floor(stats.mtimeMs),
      });
    },
  });
}

export const dheeShowFileTool = makeShowFileTool();
