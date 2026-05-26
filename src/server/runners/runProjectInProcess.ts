/**
 * Project-level dispatcher. Reads `project.json` → `renderMethod` and
 * routes the project end-to-end through the appropriate path:
 *
 *   - `shot_by_shot` → `runExecutor()` runs the existing pipeline to
 *     completion (LLM → Klein refs + first + last frames → 6 LTX FL2V
 *     renders → ffmpeg assembly with watermark).
 *
 *   - `prompt_relay` → `runExecutor()` runs upstream stages with a
 *     stage gate at `shot_image` (LLM + Klein first frames only — no
 *     last frames since the LTX Director uses first-frame anchors
 *     only). Then `walkBundle()` dispatches the `ltx_prompt_relay`
 *     bundle to render the video stage (LTX Director one or more
 *     chunks → ffmpeg concat + watermark).
 *
 * Unifies the two paths behind one entry point so hosts (CLI scripts,
 * BackgroundTaskRunner, pi-agent tools, packaged desktop IPC) don't
 * need to know which method a project uses. Per `[[surface-deferred-work]]`,
 * the architectural choice of "which renderer drives a project" is a
 * project property, not an action — this dispatcher enforces that.
 *
 * Returns a unified result describing what ran, what produced the
 * final video, and the path on disk.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runExecutor, type RunExecutorOpts, type RunExecutorResult } from './runExecutor.js';
import { walkBundle, loadBundle } from '../../dag/walker.js';
import {
  DEFAULT_RENDER_METHOD,
  getProjectRenderMethod,
  type RenderMethod,
} from '../../core/project/renderMethods.js';
import type { GenericProjectFile } from '../../core/templates/types.js';
import { REPO_ROOT } from '../../agent/pi/paths.js';

export interface RunProjectOpts {
  projectDir: string;
  /** Pre-loaded project.json. If absent, dispatcher reads it from disk. */
  project?: GenericProjectFile;
  /**
   * Override the project's declared renderMethod for this run. Useful
   * for one-off experiments (e.g. "render this shot_by_shot project
   * via prompt_relay this time"). Persists nothing; the field on disk
   * is untouched.
   */
  methodOverride?: RenderMethod | undefined;
  /**
   * Forward to `runExecutor` for stage gating + isolated-redo. When
   * the method is `prompt_relay`, the dispatcher injects its own
   * stage gate at `shot_image`; a caller-supplied stage gate is
   * applied to the *executor pass only* (the bundle step runs to
   * completion regardless).
   */
  runExecutorExtras?: Omit<RunExecutorOpts, 'project' | 'projectDir'>;
  /** Defaults to 'ltx_prompt_relay'. Only consulted for prompt_relay method. */
  bundleId?: string;
  /** Scenes to render via the bundle. Only consulted for prompt_relay. */
  scenes?: number[];
  /** Logger. Defaults to console. */
  log?: (msg: string) => void;
}

export interface RunProjectResult {
  /** The method that actually ran (after override + default resolution). */
  method: RenderMethod;
  /** True iff everything completed and a final video landed on disk. */
  ok: boolean;
  /** Reason for failure if !ok. */
  error?: string;
  /** Absolute path to the final video. shot_by_shot → assets/videos/final/final_video.mp4; prompt_relay → assets/videos/final/dag_relay_final.mp4. */
  finalVideoAbs?: string;
  /** Executor pass result (always present — both methods run executor). */
  executor: RunExecutorResult;
  /** Bundle pass result (prompt_relay only). */
  bundle?: { ok: boolean; outputPath?: string; error?: string };
}

function loadProjectJson(projectDir: string): GenericProjectFile {
  const p = join(projectDir, 'project.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as GenericProjectFile;
}

export async function runProjectInProcess(opts: RunProjectOpts): Promise<RunProjectResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const project = opts.project ?? loadProjectJson(opts.projectDir);

  const declaredMethod = getProjectRenderMethod(project as unknown as Record<string, unknown>);
  const method = opts.methodOverride ?? declaredMethod;

  log(`runProjectInProcess: method=${method}${opts.methodOverride ? ` (override; declared=${declaredMethod})` : ''}`);

  // ── shot_by_shot: existing executor runs the whole thing ─────────
  if (method === 'shot_by_shot') {
    const executor = await runExecutor({
      projectDir: opts.projectDir,
      project,
      target: opts.runExecutorExtras?.target ?? {},
      ...(opts.runExecutorExtras ?? {}),
    });
    const finalAbs = join(opts.projectDir, 'assets/videos/final/final_video.mp4');
    return {
      method,
      ok: executor.status === 'completed',
      ...(executor.status === 'completed' ? {} : { error: executor.error ?? executor.rawResultStatus }),
      finalVideoAbs: finalAbs,
      executor,
    };
  }

  // ── prompt_relay: executor (gated at shot_image) then bundle ─────
  if (method === 'prompt_relay') {
    // Caller may have asked for an earlier stage gate. Use whichever
    // comes first ("shot_image" or caller's stage) by hand — but for
    // v1 we only support either "full upstream" (caller's gate <= shot_image)
    // or "all the way" (no caller gate). If the caller provided a stage
    // gate, honor it and skip the bundle (means they're iterating
    // upstream, not producing a final).
    const callerExtras = opts.runExecutorExtras ?? { target: {} };
    const callerStage = callerExtras.target?.stage;
    const callerWantsEarlierStage = callerStage && callerStage !== 'shot_image' && callerStage !== 'final_video';

    const executor = await runExecutor({
      projectDir: opts.projectDir,
      project,
      ...callerExtras,
      target: {
        ...callerExtras.target,
        stage: callerStage ?? 'shot_image',
      },
    });
    // runExecutor maps both real completion AND paused_at_stage to
    // 'completed' (see mapExecutorStatus.ts). Any other status means
    // the executor pass didn't finish what we asked for.
    if (executor.status !== 'completed') {
      return {
        method,
        ok: false,
        error: `executor pass failed: ${executor.error ?? executor.rawResultStatus}`,
        executor,
      };
    }
    if (callerWantsEarlierStage) {
      log(`runProjectInProcess: caller requested early stage gate '${callerStage}' — skipping bundle dispatch`);
      return { method, ok: true, executor };
    }

    // Discover scenes if caller didn't specify. v1: read scene_*.json files.
    const sceneIds = opts.scenes ?? discoverSceneIds(opts.projectDir);
    if (sceneIds.length === 0) {
      return {
        method,
        ok: false,
        error: 'prompt_relay: no scenes found to render via bundle',
        executor,
      };
    }

    // Load bundle. v1: pinned to ltx_prompt_relay unless caller overrides.
    // Resolve against the kshana-core package root (REPO_ROOT) — NOT
    // process.cwd(). When kshana-core is loaded as a library by a host
    // (desktop Electron, packaged CLI), cwd is the host's working dir,
    // not kshana-core's source root. Using cwd silently fails ENOENT
    // and the dispatcher returns "ok:false" with a confusing error.
    const bundleId = opts.bundleId ?? 'ltx_prompt_relay';
    const bundlePath = resolve(REPO_ROOT, `src/dag/bundles/${bundleId}.json`);
    const bundle = loadBundle(bundlePath);

    log(`runProjectInProcess: dispatching bundle '${bundle.id}' v${bundle.version} on scenes ${sceneIds.join(', ')}`);
    const walkResult = await walkBundle({
      projectDir: opts.projectDir,
      bundle,
      cli: { sceneIds },
      log,
    });

    if (!walkResult.ok) {
      return {
        method,
        ok: false,
        error: `bundle pass failed: ${walkResult.error}`,
        executor,
        bundle: { ok: false, ...(walkResult.error ? { error: walkResult.error } : {}) },
      };
    }
    return {
      method,
      ok: true,
      finalVideoAbs: walkResult.goal!.outputAbs,
      executor,
      bundle: { ok: true, outputPath: walkResult.goal!.outputRel },
    };
  }

  return {
    method: DEFAULT_RENDER_METHOD,
    ok: false,
    error: `Unknown render method '${method}' — valid: shot_by_shot, prompt_relay`,
    executor: { status: 'failed', rawResultStatus: 'unknown_method' } as RunExecutorResult,
  };
}

function discoverSceneIds(projectDir: string): number[] {
  try {
    const dir = join(projectDir, 'prompts/videos/scenes');
    return readdirSync(dir)
      .map((f) => f.match(/^scene_(\d+)\.json$/)?.[1])
      .filter((s): s is string => !!s)
      .map((s) => parseInt(s, 10))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
