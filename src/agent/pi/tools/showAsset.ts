import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, isAbsolute, join, sep } from "node:path";
import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getProjectsDir } from "../paths.js";
import { findShot } from "../../../core/project/projectSchema.js";
import { resolveProjectDir } from "./resolveProjectDir.js";
import type { MediaCallback } from "./runTo.js";

interface ManifestEntry {
  id: string;
  type: string;
  path: string;
  scene_number?: number;
  version?: number;
  createdAt: number;
  nodeId?: string;
  metadata?: Record<string, unknown>;
}

export interface ShowDetails {
  /** Path relative to <project>.dhee/. The frontend renders inline when this matches an image/video extension. */
  file_path: string;
  /** Absolute project root used to resolve this asset. */
  projectDir?: string;
  /** Absolute on-disk path for renderers/tools that should not rediscover the project root. */
  absolute_file_path?: string;
  asset_id: string;
  asset_type: string;
  created_at: number;
}

interface LoadedProject {
  project: Record<string, unknown>;
  projectDir: string;
}

interface LoadedManifest {
  entries: ManifestEntry[];
  projectDir?: string;
}

async function loadProject(
  projectName: string,
  projectDirOverride?: string,
): Promise<LoadedProject | null> {
  try {
    const projectDir = resolveProjectDir({
      name: projectName,
      basePath: getProjectsDir(),
      ...(projectDirOverride ? { projectDir: projectDirOverride } : {}),
    });
    const raw = await readFile(join(projectDir, "project.json"), "utf8");
    return { project: JSON.parse(raw) as Record<string, unknown>, projectDir };
  } catch {
    return null;
  }
}

async function loadManifest(
  projectName: string,
  projectDirOverride?: string,
): Promise<LoadedManifest> {
  try {
    const projectDir = resolveProjectDir({
      name: projectName,
      basePath: getProjectsDir(),
      ...(projectDirOverride ? { projectDir: projectDirOverride } : {}),
    });
    const raw = await readFile(join(projectDir, "assets", "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as { assets?: ManifestEntry[] };
    return { entries: parsed.assets ?? [], projectDir };
  } catch {
    return { entries: [] };
  }
}

function pickLatest(entries: ManifestEntry[]): ManifestEntry | undefined {
  return [...entries].sort((a, b) => b.createdAt - a.createdAt)[0];
}

function shotFilenamePrefix(scene: number, shot: number): string {
  return `s${scene}shot${shot}_`;
}

function absoluteAssetPath(projectDir: string, path: string): string {
  return isAbsolute(path) ? path : join(projectDir, path);
}

function frameResult(
  ref: { path: string; createdAt: number } | undefined,
  notFound: string,
  projectDir?: string,
): AgentToolResult<ShowDetails | { found: false }> {
  if (!ref) {
    return {
      content: [{ type: "text", text: notFound }],
      details: { found: false, ...(projectDir ? { projectDir } : {}) },
    };
  }
  return {
    content: [{ type: "text", text: `${ref.path} (created ${new Date(ref.createdAt).toISOString()})` }],
    details: {
      file_path: ref.path,
      ...(projectDir
        ? { projectDir, absolute_file_path: absoluteAssetPath(projectDir, ref.path) }
        : {}),
      asset_id: ref.path,
      asset_type: "scene_image",
      created_at: ref.createdAt,
    },
  };
}

function manifestResult(
  entry: ManifestEntry | undefined,
  notFound: string,
  projectDir?: string,
): AgentToolResult<ShowDetails | { found: false }> {
  if (!entry) {
    return {
      content: [{ type: "text", text: notFound }],
      details: { found: false, ...(projectDir ? { projectDir } : {}) },
    };
  }
  return {
    content: [{ type: "text", text: `${entry.path} (created ${new Date(entry.createdAt).toISOString()})` }],
    details: {
      file_path: entry.path,
      ...(projectDir
        ? { projectDir, absolute_file_path: absoluteAssetPath(projectDir, entry.path) }
        : {}),
      asset_id: entry.id,
      asset_type: entry.type,
      created_at: entry.createdAt,
    },
  };
}

const ShotFrameParams = Type.Object({
  project: Type.String({ description: "Project name" }),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to the project folder. Pass when the host has already focused a workspace folder outside the default projects directory.",
    }),
  ),
  scene: Type.Number({ description: "Scene number, e.g. 1" }),
  shot: Type.Number({ description: "Shot number within the scene, e.g. 2" }),
});

/**
 * Reject calls where `scene` or `shot` are missing / non-positive
 * (which previously slipped through typebox runtime as `undefined` when
 * the LLM forgot the arg, then turned into a literal "s1shotundefined_"
 * prefix scan that returned a "No first-frame found" text result with
 * no media event — the chat showed ✓ on the tool call but rendered
 * nothing, and the agent often missed the failure-text and pressed on.
 *
 * Throwing here surfaces a real error the agent has to react to.
 */
function validateShotFrameParams(
  params: { project: string; scene: number; shot: number },
  toolLabel: string,
): void {
  if (typeof params.scene !== "number" || !Number.isFinite(params.scene) || params.scene < 1) {
    throw new Error(
      `${toolLabel}: 'scene' is required and must be a positive number (got ${JSON.stringify(params.scene)}). Pass scene=N where N is the 1-based scene number.`,
    );
  }
  if (typeof params.shot !== "number" || !Number.isFinite(params.shot) || params.shot < 1) {
    throw new Error(
      `${toolLabel}: 'shot' is required and must be a positive number (got ${JSON.stringify(params.shot)}). Pass shot=M where M is the 1-based shot number within the scene. If you don't know the shot, call kshana_list_items to enumerate them first.`,
    );
  }
}

/**
 * Factory functions return a fresh tool wired to an optional onMedia
 * callback. When supplied (PiSessionAgent's chat path always
 * supplies it), every successful resolution fires onMedia so the
 * chat panel renders an inline image/video bubble. Without it (CLI
 * smoke tests, legacy callers), the tool still returns the path in
 * `details` — just no chat-side rendering.
 *
 * The named exports below (`dheeShowFirstFrame` etc.) preserve the
 * pre-factory shape for any caller that imports them directly. They
 * are equivalent to `createShow*Tool({})` (no media emission).
 */
export interface ShowAssetOpts {
  onMedia?: MediaCallback;
}

export function createShowFirstFrameTool(opts: ShowAssetOpts = {}): ToolDefinition {
  return defineTool({
    name: "dhee_show_first_frame",
    label: "dhee show first-frame",
    description:
      "Show the latest generated first-frame image for a specific shot. Reads from project.json's scenes tree first, falls back to the manifest for legacy projects. Renders the image inline in chat when used from a desktop session.",
    parameters: ShotFrameParams,
    async execute(_id, params: Static<typeof ShotFrameParams>) {
      validateShotFrameParams(params, "kshana_show_first_frame");
      const loaded = await loadProject(params.project, params.projectDir);
      const shot = loaded ? findShot(loaded.project, params.scene, params.shot) : undefined;
      if (loaded && shot?.firstFrame) {
        opts.onMedia?.({
          kind: "image",
          project: params.project,
          projectDir: loaded.projectDir,
          path: shot.firstFrame.path,
          source: "dhee_show_first_frame",
        });
        return frameResult(shot.firstFrame, "", loaded.projectDir);
      }
      const manifest = await loadManifest(params.project, params.projectDir);
      const prefix = shotFilenamePrefix(params.scene, params.shot);
      const matches = manifest.entries.filter(
        (e) => e.type === "scene_image" && e.path.includes(`${prefix}first_frame`),
      );
      const latest = pickLatest(matches);
      if (latest) {
        opts.onMedia?.({
          kind: "image",
          project: params.project,
          ...(manifest.projectDir ? { projectDir: manifest.projectDir } : {}),
          path: latest.path,
          source: "dhee_show_first_frame",
        });
      }
      return manifestResult(
        latest,
        `No first-frame image found for scene ${params.scene} shot ${params.shot} in '${params.project}'.`,
        manifest.projectDir,
      );
    },
  });
}

export function createShowLastFrameTool(opts: ShowAssetOpts = {}): ToolDefinition {
  return defineTool({
    name: "dhee_show_last_frame",
    label: "dhee show last-frame",
    description:
      "Show the latest generated last-frame image for a specific shot. Reads from project.json's scenes tree first, falls back to the manifest. Renders inline.",
    parameters: ShotFrameParams,
    async execute(_id, params: Static<typeof ShotFrameParams>) {
      validateShotFrameParams(params, "kshana_show_last_frame");
      const loaded = await loadProject(params.project, params.projectDir);
      const shot = loaded ? findShot(loaded.project, params.scene, params.shot) : undefined;
      if (loaded && shot?.lastFrame) {
        opts.onMedia?.({
          kind: "image",
          project: params.project,
          projectDir: loaded.projectDir,
          path: shot.lastFrame.path,
          source: "dhee_show_last_frame",
        });
        return frameResult(shot.lastFrame, "", loaded.projectDir);
      }
      const manifest = await loadManifest(params.project, params.projectDir);
      const prefix = shotFilenamePrefix(params.scene, params.shot);
      const matches = manifest.entries.filter(
        (e) => e.type === "scene_image" && e.path.includes(`${prefix}last_frame`),
      );
      const latest = pickLatest(matches);
      if (latest) {
        opts.onMedia?.({
          kind: "image",
          project: params.project,
          ...(manifest.projectDir ? { projectDir: manifest.projectDir } : {}),
          path: latest.path,
          source: "dhee_show_last_frame",
        });
      }
      return manifestResult(
        latest,
        `No last-frame image found for scene ${params.scene} shot ${params.shot} in '${params.project}'.`,
        manifest.projectDir,
      );
    },
  });
}

export function createShowShotVideoTool(opts: ShowAssetOpts = {}): ToolDefinition {
  return defineTool({
    name: "dhee_show_shot_video",
    label: "dhee show shot-video",
    description:
      "Show the latest rendered shot video clip. Reads from project.json's scenes tree first, falls back to the manifest. Renders inline.",
    parameters: ShotFrameParams,
    async execute(_id, params: Static<typeof ShotFrameParams>) {
      validateShotFrameParams(params, "kshana_show_shot_video");
      const loaded = await loadProject(params.project, params.projectDir);
      const shot = loaded ? findShot(loaded.project, params.scene, params.shot) : undefined;
      if (loaded && shot?.video) {
        opts.onMedia?.({
          kind: "video",
          project: params.project,
          projectDir: loaded.projectDir,
          path: shot.video.path,
          source: "dhee_show_shot_video",
        });
        return {
          content: [{ type: "text", text: `${shot.video.path} (created ${new Date(shot.video.createdAt).toISOString()})` }],
          details: {
            file_path: shot.video.path,
            projectDir: loaded.projectDir,
            absolute_file_path: absoluteAssetPath(loaded.projectDir, shot.video.path),
            asset_id: shot.video.path,
            asset_type: "scene_video",
            created_at: shot.video.createdAt,
          },
        };
      }
      const manifest = await loadManifest(params.project, params.projectDir);
      const prefix = shotFilenamePrefix(params.scene, params.shot);
      const matches = manifest.entries.filter(
        (e) => e.type === "scene_video" && e.path.includes(prefix),
      );
      const latest = pickLatest(matches);
      if (latest) {
        opts.onMedia?.({
          kind: "video",
          project: params.project,
          ...(manifest.projectDir ? { projectDir: manifest.projectDir } : {}),
          path: latest.path,
          source: "dhee_show_shot_video",
        });
      }
      return manifestResult(
        latest,
        `No video clip found for scene ${params.scene} shot ${params.shot} in '${params.project}'.`,
        manifest.projectDir,
      );
    },
  });
}

const FinalVideoParams = Type.Object({
  project: Type.String({ description: "Project name" }),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to the project folder. Pass when the host has already focused a workspace folder outside the default projects directory.",
    }),
  ),
});

export function createShowFinalVideoTool(opts: ShowAssetOpts = {}): ToolDefinition {
  return defineTool({
    name: "dhee_show_final_video",
    label: "dhee show final-video",
    description:
      "Show the assembled final video for a project. Reads project.finalVideo first, falls back to manifest. Renders inline.",
    parameters: FinalVideoParams,
    async execute(_id, params: Static<typeof FinalVideoParams>) {
      const loaded = await loadProject(params.project, params.projectDir);
      const finalVideo = loaded?.project["finalVideo"] as { path: string; createdAt: number } | undefined;
      if (loaded && finalVideo) {
        opts.onMedia?.({
          kind: "video",
          project: params.project,
          projectDir: loaded.projectDir,
          path: finalVideo.path,
          source: "dhee_show_final_video",
        });
        return {
          content: [{ type: "text", text: `${finalVideo.path} (created ${new Date(finalVideo.createdAt).toISOString()})` }],
          details: {
            file_path: finalVideo.path,
            projectDir: loaded.projectDir,
            absolute_file_path: absoluteAssetPath(loaded.projectDir, finalVideo.path),
            asset_id: finalVideo.path,
            asset_type: "final_video",
            created_at: finalVideo.createdAt,
          },
        };
      }
      const manifest = await loadManifest(params.project, params.projectDir);
      const matches = manifest.entries.filter((e) => e.type === "final_video");
      const latest = pickLatest(matches);
      if (latest) {
        opts.onMedia?.({
          kind: "video",
          project: params.project,
          ...(manifest.projectDir ? { projectDir: manifest.projectDir } : {}),
          path: latest.path,
          source: "dhee_show_final_video",
        });
      }
      return manifestResult(
        latest,
        `No final video found for '${params.project}'.`,
        manifest.projectDir,
      );
    },
  });
}

// ── Generic image-by-path show tool ─────────────────────────────────
// For ref images (setting / character / object) and any other on-disk
// image the agent wants to surface in chat. The shot-specific show
// tools above are great for the structured shot pipeline, but the
// agent often needs to display an arbitrary image — e.g. after
// reading SettingRef_observationdeckexit_*.png, the agent should be
// able to *show* it in the chat, not just describe it textually.
//
// Earlier behavior: `read path=*.png` would return text only (the
// VLM description if oversight is on), no image rendered. The agent
// has no other channel to push an image into the chat, so the user
// got a description but never saw the actual image. This tool closes
// that gap.
//
// Path resolution: absolute paths are used as-is; relative paths are
// resolved against the project directory.
const ShowImageParams = Type.Object({
  project: Type.String({ description: "Project name." }),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to the project folder. Pass when the host has already focused a workspace folder outside the default projects directory.",
    }),
  ),
  path: Type.String({
    description:
      "Image path. Absolute paths are used as-is; relative paths are resolved against the project directory. PNG / JPG / WEBP / GIF.",
  }),
});

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function createShowImageTool(opts: ShowAssetOpts = {}): ToolDefinition {
  return defineTool({
    name: "dhee_show_image",
    label: "dhee show image",
    description:
      "Display an image in the chat. Use this whenever the user asks to SEE an image — setting refs, character refs, object refs, or any other on-disk image — and a more specific tool (dhee_show_first_frame / dhee_show_last_frame for shot frames) doesn't fit. Accepts an absolute path OR a path relative to the project directory. The chat renders an inline thumbnail. Do NOT use `read` on an image file when the user wants to see it — `read` returns text only and the image will never appear in the chat.",
    parameters: ShowImageParams,
    async execute(_id, params: Static<typeof ShowImageParams>): Promise<AgentToolResult<ShowDetails>> {
      const ext = extname(params.path).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) {
        return {
          content: [{
            type: "text",
            text: `'${params.path}' is not an image (extension '${ext || "(none)"}' is not png/jpg/jpeg/webp/gif). Use dhee_show_shot_video for videos.`,
          }],
          details: {
            file_path: params.path,
            asset_id: params.path,
            asset_type: "image",
            created_at: 0,
          },
        };
      }
      let projectDir: string;
      try {
        projectDir = resolveProjectDir({
          name: params.project,
          basePath: getProjectsDir(),
          ...(params.projectDir ? { projectDir: params.projectDir } : {}),
        });
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Could not resolve project '${params.project}': ${(err as Error).message}`,
          }],
          details: {
            file_path: params.path,
            ...(params.projectDir ? { projectDir: params.projectDir } : {}),
            asset_id: params.path,
            asset_type: "image",
            created_at: 0,
          },
        };
      }
      const absPath = isAbsolute(params.path) ? params.path : join(projectDir, params.path);
      if (!existsSync(absPath)) {
        return {
          content: [{
            type: "text",
            text: `Image not found on disk: ${absPath}`,
          }],
          details: {
            file_path: params.path,
            projectDir,
            absolute_file_path: absPath,
            asset_id: params.path,
            asset_type: "image",
            created_at: 0,
          },
        };
      }
      // Emit relative-to-project path when possible — the chat panel's
      // media handler resolves relative paths against the focused
      // project dir (see ChatPanelEmbedded.test "media_generated with
      // a relative path resolves to an absolute file:// URL").
      const emitPath = absPath.startsWith(projectDir + sep)
        ? absPath.slice(projectDir.length + 1)
        : absPath;
      opts.onMedia?.({
        kind: "image",
        project: params.project,
        projectDir,
        path: emitPath,
        source: "dhee_show_image",
      });
      return {
        content: [{ type: "text", text: `Showed image: ${emitPath}` }],
        details: {
          file_path: emitPath,
          projectDir,
          absolute_file_path: absPath,
          asset_id: absPath,
          asset_type: "image",
          created_at: 0,
        },
      };
    },
  });
}

// ── Backwards-compat named exports ──────────────────────────────────
// Equivalent to `createShow*Tool({})` (no onMedia). Kept so existing
// imports from tools/index.ts and tests don't have to change.
export const dheeShowFirstFrame = createShowFirstFrameTool();
export const dheeShowLastFrame = createShowLastFrameTool();
export const dheeShowShotVideo = createShowShotVideoTool();
export const dheeShowFinalVideo = createShowFinalVideoTool();
export const dheeShowImage = createShowImageTool();
