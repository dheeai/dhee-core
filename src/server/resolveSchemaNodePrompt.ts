/**
 * Pi-era fallback for the /api/v1/projects/:name/node-prompt/:nodeId
 * route. Pulls the shot's prompt + motionDirective + frame paths out of
 * project.scenes and shapes them into the response the Edit & Redo
 * modal expects.
 *
 * Returns null when the node id can't be parsed or the scene/shot
 * doesn't exist — the caller surfaces a 404.
 */
import { findShot, type Shot } from "../core/project/projectSchema.js";

export interface SchemaNodePromptResponse {
  nodeId: string;
  nodeType: string;
  prompt: Record<string, unknown>;
  /** Path relative to <project>.dhee/, for shot_video preview. Caller turns this into a URL. */
  firstFramePath?: string;
  /**
   * Deterministic on-disk prompt-file path the caller should try to read.
   * If present and the file exists, its contents (parsed JSON) supersede
   * the synthesized `prompt` field — that gives us the original
   * frames/references structure the Edit modal expects.
   */
  promptFilePath?: string;
}

const SHOT_NODE_RE = /^(shot_image_prompt|shot_motion_directive|shot_image|shot_video):scene_(\d+)_shot_(\d+)$/;

export function resolveSchemaNodePrompt(
  project: Record<string, unknown>,
  nodeId: string,
): SchemaNodePromptResponse | null {
  const m = SHOT_NODE_RE.exec(nodeId);
  if (!m) return null;
  const typeId = m[1]!;
  const sceneNum = parseInt(m[2]!, 10);
  const shotNum = parseInt(m[3]!, 10);

  const shot: Shot | undefined = findShot(project, sceneNum, shotNum);
  if (!shot) return null;

  // Two filename conventions live in repo today:
  //   image  prompts: prompts/images/shots/scene-<N>-shot-<M>.json   (hyphens)
  //   motion prompts: prompts/motion/scene_<N>_shot_<M>.json         (underscores)
  const imageShotFile = `scene-${sceneNum}-shot-${shotNum}.json`;
  const motionShotFile = `scene_${sceneNum}_shot_${shotNum}.json`;
  switch (typeId) {
    case "shot_image_prompt":
    case "shot_image":
      return {
        nodeId,
        nodeType: typeId,
        prompt: { imagePrompt: shot.prompt ?? "" },
        promptFilePath: `prompts/images/shots/${imageShotFile}`,
      };
    case "shot_motion_directive":
      return {
        nodeId,
        nodeType: typeId,
        prompt: { motionDirective: shot.motionDirective ?? "" },
        promptFilePath: `prompts/motion/${motionShotFile}`,
      };
    case "shot_video":
      return {
        nodeId,
        nodeType: typeId,
        prompt: { motionDirective: shot.motionDirective ?? "" },
        promptFilePath: `prompts/motion/${motionShotFile}`,
        ...(shot.firstFrame?.path ? { firstFramePath: shot.firstFrame.path } : {}),
      };
    default:
      return null;
  }
}
