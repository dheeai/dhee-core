/**
 * Phase 2 (Pattern B): the `shot_image_last_frame:X` node owns its
 * own artifact. It runs `edit_first_frame` against the upstream
 * `shot_image:X`'s first_frame and writes the result to its own
 * `outputPath`.
 *
 * This replaces the Phase 1 `bridgeLastFrameFromShotImage` mirror,
 * which copied an artifact already produced inside `executeShotImage`.
 * The mirror could go stale when the upstream was invalidated without
 * cascading to the bridge — Phase 2 closes that gap by giving the
 * bridge node a real producer.
 *
 * I/O is fully injected (executor, fs, edit-image call, ref resolver,
 * mode flag) so the helper is unit-testable without a real provider
 * or filesystem.
 */
import type { ExecutionNode } from './types.js';

export interface ExecuteShotImageLastFrameExecutorLike {
  getNode(id: string): ExecutionNode | undefined;
}

export interface FrameReference {
  refId?: string;
  type?: string;
}

export interface EditImageLayeredArgs {
  prompt: string;
  sourceImagePath: string;
  refPaths: string[];
  outputDir: string;
  filenamePrefix: string;
}

export interface ExecuteShotImageLastFrameDeps {
  executor: ExecuteShotImageLastFrameExecutorLike;
  projectDir: string;
  fs: {
    existsSync(p: string): boolean;
    readFileSync(p: string, encoding: 'utf-8'): string;
    mkdirSync(p: string, opts: { recursive: true }): void;
  };
  /**
   * Run the edit_first_frame call. Returns the absolute path to the
   * produced image. Layering (>4 refs) is handled inside the
   * implementation — the helper just hands off the resolved inputs.
   */
  editImageLayered(args: EditImageLayeredArgs): Promise<string>;
  /**
   * Translate refIds (e.g. "character:elara") to absolute file paths
   * on disk. The helper passes this whatever it found in the prompt
   * JSON; the executor side is responsible for filtering out refs
   * whose source artifacts haven't been generated yet.
   */
  resolveRefIds(refs: FrameReference[]): string[];
  log?(message: string): void;
}

export type ExecuteShotImageLastFrameResult =
  | { action: 'complete'; outputPath?: string }
  | { action: 'fail'; error: string };

interface FrameBlock {
  imagePrompt?: string;
  generationMode?: string;
  references?: FrameReference[];
}

interface PromptJson {
  aspectRatio?: string;
  negativePrompt?: string;
  frames?: {
    first_frame?: FrameBlock;
    last_frame?: FrameBlock;
    mid_frame?: FrameBlock;
  };
}

function stripCodeFences(s: string): string {
  let cleaned = s.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned;
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+/, '').replace(/\/+$/, '')))
    .filter((p) => p.length > 0)
    .join('/');
}

function relativeTo(projectDir: string, absPath: string): string {
  const prefix = projectDir.endsWith('/') ? projectDir : `${projectDir}/`;
  if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  return absPath;
}

export async function executeShotImageLastFrame(
  node: ExecutionNode,
  deps: ExecuteShotImageLastFrameDeps,
): Promise<ExecuteShotImageLastFrameResult> {
  if (!node.itemId) {
    return { action: 'fail', error: 'shot_image_last_frame node has no itemId' };
  }
  const itemId = node.itemId;
  const log = deps.log ?? (() => {});

  const upstreamId = `shot_image:${itemId}`;
  const upstream = deps.executor.getNode(upstreamId);
  if (!upstream) {
    return { action: 'fail', error: `${upstreamId} not found upstream` };
  }
  const firstFrameRel = upstream.outputPaths?.['first_frame'] ?? upstream.outputPath;
  if (!firstFrameRel) {
    return {
      action: 'fail',
      error: `${upstreamId} has no first_frame artifact yet`,
    };
  }

  const promptId = `shot_image_prompt:${itemId}`;
  const promptNode = deps.executor.getNode(promptId);
  if (!promptNode?.outputPath) {
    return { action: 'fail', error: `${promptId} not completed` };
  }
  const promptAbs = joinPath(deps.projectDir, promptNode.outputPath);
  if (!deps.fs.existsSync(promptAbs)) {
    return { action: 'fail', error: `prompt JSON not found at ${promptAbs}` };
  }

  let parsed: PromptJson;
  try {
    parsed = JSON.parse(stripCodeFences(deps.fs.readFileSync(promptAbs, 'utf-8'))) as PromptJson;
  } catch (err) {
    return {
      action: 'fail',
      error: `prompt JSON corrupt: ${(err as Error).message}`,
    };
  }

  const lastFrameBlock = parsed.frames?.last_frame;
  // Single-frame shot: planner only produced first_frame. Bridge has
  // nothing to do — complete cleanly so shot_video can still run i2v.
  if (!lastFrameBlock?.imagePrompt) {
    log(`shot_image_last_frame:${itemId}: no last_frame block in prompt — no-op complete`);
    return { action: 'complete' };
  }

  // Incremental retry: if we already have an outputPath from a prior
  // attempt AND it's still on disk, reuse it. Mirrors the same
  // short-circuit that executeShotImage does for first_frame.
  if (node.outputPath) {
    const existingAbs = joinPath(deps.projectDir, node.outputPath);
    if (deps.fs.existsSync(existingAbs)) {
      log(`shot_image_last_frame:${itemId}: outputPath exists on disk (incremental retry)`);
      return { action: 'complete', outputPath: node.outputPath };
    }
  }

  // Resolve refs: prefer last_frame's explicit refs; fall back to
  // first_frame's refs when last_frame omits them. Common pattern: the
  // LLM lists refs only in the frame that introduces a new character /
  // setting and omits them from the other frame.
  const lastRefs = lastFrameBlock.references ?? [];
  const firstRefs = parsed.frames?.first_frame?.references ?? [];
  const refsToUse = lastRefs.length > 0 ? lastRefs : firstRefs;
  const refPaths = deps.resolveRefIds(refsToUse);

  const sourceImagePath = joinPath(deps.projectDir, firstFrameRel);
  const outputDir = joinPath(deps.projectDir, 'assets', 'images');
  deps.fs.mkdirSync(outputDir, { recursive: true });

  const filenamePrefix = `${itemId}_last_frame`;
  log(
    `shot_image_last_frame:${itemId}: edit_first_frame from ${firstFrameRel} (${refPaths.length} refs)`,
  );

  let absOut: string;
  try {
    absOut = await deps.editImageLayered({
      prompt: lastFrameBlock.imagePrompt,
      sourceImagePath,
      refPaths,
      outputDir,
      filenamePrefix,
    });
  } catch (err) {
    return { action: 'fail', error: `edit_first_frame failed: ${(err as Error).message}` };
  }

  const relPath = relativeTo(deps.projectDir, absOut);
  node.outputPath = relPath;
  return { action: 'complete', outputPath: relPath };
}
