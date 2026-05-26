/**
 * ExecutorAgent
 *
 * A drop-in replacement for GenericAgent that uses DependencyGraphExecutor
 * to drive the workflow deterministically. Presents the same event interface
 * so ConversationManager and the WebSocket layer work unchanged.
 *
 * The LLM is called as a pure content generator per node — no tools, no file
 * I/O, no navigation decisions. All dependency resolution, file reading, file
 * writing, and progress tracking happens in deterministic code.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, statSync, renameSync } from 'fs';
import { atomicWriteFileSync } from '../../utils/atomicWrite.js';
import { join, dirname, relative } from 'path';
import { TypedEventEmitter } from '../../events/EventEmitter.js';
import type { LLMClient } from '../llm/index.js';
import type { Message, GenerateOptions } from '../llm/types.js';
import { buildRouterFromEnv, type LLMRouter, type LLMPurpose } from '../llm/index.js';
import type { GenericAgentResult } from '../agent/AgentResult.js';
import type { ExpandableTodoItem } from '../todo/index.js';
import type {
  VideoTemplate,
  GenericProjectFile,
} from '../templates/types.js';
import type {
  ExecutionNode,
  ResolvedInputs,
  UserGoal,
} from './types.js';
import { DependencyGraphExecutor } from './DependencyGraphExecutor.js';
import { addShotImageNodes } from './addShotImageNodes.js';
import { executeShotImageLastFrame } from './executeShotImageLastFrame.js';
import { BackwardPlanner } from './BackwardPlanner.js';
import { AssetScanner } from './AssetScanner.js';
import { resolveInputs, writeOutput, getOutputPath } from './contentResolver.js';
import { assembleSceneVideoPrompt, type SingleShot } from './sceneVideoPromptAssembler.js';
import { migrateGraphToTemplate } from './migrateGraphToTemplate.js';
// (writeFailedAttempt/clearFailedAttempt imported below from ./writeFailedAttempt.js — master replaced ./failedAttempt.js)
import { classifyValidationError, buildRetrySystemSuffix } from './validationErrorClass.js';
import { readShotContextFromSvp, readShotAnchorFromSvp, buildShotAwareReferences, shouldForceEditPrevious } from './shotReferenceMapping.js';
import { enforceAnchorMode } from './enforceAnchorMode.js';
import { getPreviousShotIdAcrossScenes } from './crossShotChaining.js';
import { shouldExpandSceneCollectionToShots } from './collectionExpansion.js';
import {
  diffShotPlanAgainstGraph,
  perShotNodeIds,
  planShotNumbersFromJson,
} from './reconcileShotPlan.js';
import { buildOutputContractBlock } from './buildOutputContractBlock.js';
import { reconcileGraphHygiene, summariseHygieneResult } from './reconcileGraphHygiene.js';
import {
  normalizeShotImagePrompt as normalizeShotImagePromptFrame,
  normalizeShotImagePromptWithRefs,
  alignFramesToFirstFrame,
  scanOTSWithSingleChar,
  type AvailableRefMinimal,
} from './shotImagePromptNormalizer.js';
import { enforceShotCanonicalRefs } from './enforceShotCanonicalRefs.js';
import { buildEmptyContentFailureReason, checkEmptyContent } from './checkEmptyContent.js';
import { retryOnEmptyLLMResponse } from './retryOnEmptyLLMResponse.js';
import {
  buildSlotManifestLine,
  stripInlineFromImageTokens,
  applyShotImageManifestPostPass,
  stripSettingFromEditFirstFrameFrames,
  normalizeDerivedFromRefId,
  resolveDerivedFromBase,
  buildReferenceMenu,
  buildTurn2UserMessage,
  isSkipHoldingBeatLFEnabled,
  parseTurn2RefsJson,
  stripLastFrameFromShotImagePromptJson,
  shouldSkipLastFrame,
  type Reference,
  type ReferenceMenuItem,
} from './shotImagePipeline.js';
import {
  isTransitionBoundaryPlannerEnabled,
  planSceneBoundaries,
  applyBoundaryPlanToScene,
  type BoundaryPlannerInput,
  type BoundaryPlannerShotInput,
} from './boundaryPlanner.js';
import { applyTransitionPlanToShotImagePrompt } from './applyTransitionPlanToShotImagePrompt.js';
import { ensureScene, ensureShot } from '../project/projectSchema.js';
import { extractCollectionItems } from './collectionExtractor.js';
import { listCollectionItemsFromDisk } from './collectionResumeFromDisk.js';
import { extractStoryEssence, StoryEssenceParseError, type StoryEssence } from './storyEssenceExtractor.js';
import { buildFailedNodesNotification } from './buildFailedNodesNotification.js';
import { findBlockingFailures, shouldAwaitPendingMediaOnExit } from './executorTermination.js';
import { writeFailedAttempt, clearFailedAttempt } from './writeFailedAttempt.js';
import { buildStoryEssenceBlock } from './storyEssenceContextBlock.js';
import { canonicalShotVideoDeps, sanitizeShotVideoDeps } from './shotVideoCanonicalDeps.js';
import { syncSceneArtifacts } from './syncSceneArtifacts.js';
import { buildShotAudioBlock } from './buildShotAudioBlock.js';
import { buildShotNarrationDirective } from './buildShotNarrationDirective.js';
import { skipEmptyCollectionAndDependents } from './skipEmptyCollection.js';
import {
  expectedShotNumberFromItemId,
  validateShotNumber,
  validateRefMentions,
} from './shotImagePromptValidation.js';
import { healStaleMatchingDeps } from './stateHeal.js';
import { isStageGateSatisfied, isNodeGateSatisfied, resolveStageToTypeIds } from './stages.js';
import { consumeStopFile } from './stopFile.js';
import type { ArtifactCategory } from '../templates/types.js';
import { resolveGuide, loadContentTypeSkills, type SkillResolutionContext } from '../prompts/loader.js';
// Media generation imports
import {
  submitImageGeneration,
  parsePromptFile,
  jobs as mediaJobs,
} from '../../tasks/video/tools.js';
import { comfyProgressBus, type ComfyProgressHandler } from '../../services/comfyui/index.js';
import {
  loadTimeline,
  saveTimeline,
  createTimelineSkeleton,
  updateSegmentLayers,
  upsertSceneShots,
  setSegmentTransition,
  validateTimeline,
} from '../timeline/TimelineManager.js';
import { assembleVideos, resolveSegmentFilePaths } from '../timeline/FFmpegAssembler.js';
import {
  buildSnapshot as buildFinalVideoSnapshot,
  diffSnapshots as diffFinalVideoSnapshots,
  type FinalVideoSnapshot,
} from '../timeline/finalVideoSnapshot.js';
import type { Timeline, SegmentDescriptor, TimelineLayerEntry } from '../timeline/types.js';
import type { TodoNodeInfo } from '../../events/events.js';
import { fitShotDurations } from './shotDurationFit.js';
import { scanMultiSpeakerShots, scanAmbiguousSpeakerTag } from './dialogueValidation.js';
import { validateWithSchema, normalizeSceneVideoPrompt, getPromptSchema, maxTokensForJsonNode, shotPlanSchema, singleShotSchema } from './schemas.js';
import {
  validateContinuitySequence,
  checkPositionContinuity,
  formatWarnings as formatContinuityWarnings,
  shouldRerollShot,
} from './continuityValidator.js';
import { getProviderRegistry } from '../../services/providers/index.js';
import { getWorkflowModeRegistry } from '../../services/providers/WorkflowModeRegistry.js';
import { shouldGenerateExtraFrame, isPromptRelayMode } from '../../services/providers/videoStrategy.js';
import type { SceneBundleShot, SceneBundleResult } from './sceneBundleRenderer.js';
import type { CharacterId } from '../../services/providers/promptRelayGlobalPrompt.js';
import { SceneBundleLockMap } from './sceneBundleLockMap.js';
import { checkSceneBundleEligibility } from './sceneBundleEligibility.js';
import { addAsset } from '../../tasks/video/workflow/index.js';
import { captureFinalVideoCreated } from '../../server/posthog.js';

/**
 * Configuration for creating an ExecutorAgent.
 */
export interface ExecutorAgentConfig {
  template: VideoTemplate;
  project: GenericProjectFile;
  projectDir: string;
  goal: UserGoal;
  /** Name shown in events */
  name?: string;
  /**
   * When true, media generation (image/video via ComfyUI) runs in parallel
   * with LLM prompt generation. Use this when the image/video provider is on
   * a separate server from the LLM. When false (default), everything runs
   * serially — suitable when LLM and ComfyUI share the same machine.
   */
  parallelMediaGeneration?: boolean;
  /**
   * Stop the executor after any node of this type completes.
   * Used for testing — run one step at a time.
   * Example: stopAfterNodeType: 'plot' — runs until plot completes, then stops.
   */
  stopAfterNodeType?: string;
  /**
   * Stop the executor when every node of a given stage is terminal.
   *
   * A "stage" is a user-facing alias (e.g. 'character_image') that may
   * cover multiple typeIds (character_image + setting_image + object_image)
   * and multiple per-item children (character_image:alice, :bob, :glitch).
   * The gate fires only once ALL of them are in a terminal status
   * (completed | skipped | failed).
   *
   * Unlike stopAfterNodeType (which fires after the FIRST node of a type
   * completes — retained for legacy test-mode), this is the production
   * surface for the `/run-to <stage>` user command. See stages.ts for
   * the canonical alias table.
   */
  stopAtStage?: string;
  /**
   * Pause execution as soon as a SPECIFIC node id terminates. Sister
   * of `stopAtStage` but on a single node — drives the per-shot
   * interactive flow (`pnpm run-to <project> shot_image:scene_1_shot_1`):
   * generate one image, pause for review, edit/regen if needed, then
   * `pnpm run-to <project> shot_video:scene_1_shot_1` for that shot's
   * video. Without this, run-to could only target an entire stage.
   */
  stopAfterNode?: string;
  /**
   * Skip media generation (ComfyUI calls). Only generates LLM prompts.
   * Used for testing — validates prompt structure without calling image/video providers.
   */
  skipMediaGeneration?: boolean;
}

interface ParsedSceneBreakdownShot {
  shotNumber: number;
  shotType: string;
  duration: number;
  label: string;
  transition?: import('../timeline/types.js').TransitionType | 'cut';
  metadata: Record<string, unknown>;
}

interface ParsedSceneBreakdown {
  sceneId: string;
  outputPath?: string;
  shots: ParsedSceneBreakdownShot[];
  shotItems: Array<{ itemId: string; name: string }>;
  shotDescriptors: Array<{ label: string; duration: number; metadata?: Record<string, unknown> }>;
  expectedTimelineSegmentIds: string[];
}

interface SceneMaterializationResult {
  sceneId: string;
  shotCount: number;
  shotItems: Array<{ itemId: string; name: string }>;
  expectedTimelineSegmentIds: string[];
  actualTimelineSegmentIds: string[];
  graphSatisfied: boolean;
  timelineSatisfied: boolean;
  success: boolean;
  failureReason?: string;
  outputPath?: string;
}

/**
 * Category-specific system prompt instructions for the executor.
 * These are tool-free — the LLM generates content directly from pre-loaded context.
 */
const CATEGORY_PROMPTS: Record<ArtifactCategory, string> = {
  concept: `You are a creative writer. Generate a detailed plot outline or concept document.
Write in clear prose. Include key themes, character motivations, and narrative arc.
Output ONLY the content.`,

  structure: `You are a creative writer. Generate a detailed narrative or structural document.
Write rich, engaging prose with dialogue, description, and pacing.
Output ONLY the content.`,

  entity: `You are a creative writer specializing in character and entity profiles.
Create a detailed profile including physical description, personality, motivations, and background.
Output ONLY the profile content.`,

  environment: `You are a creative writer specializing in setting and environment descriptions.
Create a vivid, detailed description of the location including atmosphere, key features, and sensory details.
Output ONLY the description.`,

  segment: `You are a creative writer specializing in cinematic scene descriptions.
Create a detailed, shootable scene description with visual direction.
Output ONLY the scene content.`,

  visual_ref: `You are an expert reference image prompt engineer.
Output ONLY valid JSON.

The JSON must follow this exact structure:
{
  "imagePrompt": "<detailed image generation prompt — flowing prose, 80-250 words>",
  "negativePrompt": "<things to avoid>",
  "aspectRatio": "<ratio like 16:9, 1:1, etc.>"
}

Follow the guide instructions EXACTLY — especially regarding background, lighting, and pose.`,

  clip: `You are a video direction expert.
Follow the guide instructions to produce the motion prompt.
Output ONLY the JSON result.`,

  final: `You are a video assembly specialist.
Generate assembly instructions for combining video clips into a final video.`,
};

/**
 * ExecutorAgent — drives the dependency graph deterministically.
 *
 * Extends TypedEventEmitter so ConversationManager can listen to events
 * using the same pattern as GenericAgent.
 */
export class ExecutorAgent extends TypedEventEmitter {
  private llm: LLMClient;
  private router: LLMRouter;
  /**
   * In-memory lock: tracks which project directories have an active executor.
   * Prevents multiple ExecutorAgent instances in the same process from
   * running concurrently on the same project (e.g. multiple WebSocket sessions).
   */
  private static activeProjects = new Map<string, { sessionId: string; startedAt: number }>();

  private executor: DependencyGraphExecutor;
  private config: ExecutorAgentConfig;
  private running = false;
  private stopped = false;
  /**
   * Per-run cancel handle. Reset at the top of every `run()` so a
   * stop from a previous run doesn't leak into the next one. The
   * signal is threaded into every `generateForNode` LLM call so
   * `stop()` aborts in-flight streams immediately — without this,
   * reasoning-model streams (1-7 min per call) keep running until
   * natural completion or their internal 200s self-timeout, which
   * made cancel feel broken.
   */
  private runAbortController: AbortController = new AbortController();
  /**
   * Resolved typeIds for the current `/run-to <stage>` gate. Null when no
   * gate is active. Set from config.stopAtStage at construction time and
   * from `setStopAtStage(stage | null)` at runtime per-task.
   */
  private stopAtStageTypeIds: Set<string> | null = null;
  /**
   * Single-node pause target. Set from config.stopAfterNode at
   * construction time and from `setStopAfterNode(id | null)` at
   * runtime. Sister of stopAtStageTypeIds; both gates run in parallel
   * — whichever fires first wins.
   */
  private stopAfterNodeId: string | null = null;
  /**
   * Why the executor last stopped. Reset at the top of each run().
   * Read by ConversationManager/WebSocketHandler to distinguish
   * "paused at stage gate" from "completed" / "cancelled" / "failed"
   * so the UI can show the right banner.
   */
  private stopReason: 'complete' | 'paused_at_stage' | 'cancelled' | 'failed' | null = null;
  /** Where the last stop() call came from — used to tag abort errors. */
  private lastStopOrigin: 'user' | 'shutdown' | null = null;
  /**
   * Loaded from prompts/story_essence.json after the story_essence node
   * completes (or at startup if the file already exists). Threaded into
   * the hierarchical scene extractor and the scene-prose context block
   * so every downstream prompt is tuned to the story's editorial intent.
   * Null when essence hasn't been generated yet.
   */
  private storyEssence: StoryEssence | null = null;
  private sceneSummaries = new Map<string, string>(); // scene_1 → summary text
  // scene_1 → on-screen duration in seconds, populated by the duration-first
  // extractor (sum of beat durations). Used in lieu of `target/sceneCount`
  // even-split when present. Persisted alongside scene_summaries.json.
  private sceneEstimatedDurations = new Map<string, number>();
  private _initialized = false;
  private logPath: string;
  private lockFilePath: string;
  private currentPhase = '';
  private retriedNodes = new Set<string>();
  /**
   * Last error captured by a helper (executeStoryEssenceNode, executeShotImage,
   * executeFinalAssembly, etc.) before it returned null. The run-loop dispatch
   * site reads this when calling `executor.markFailed`, so the user-facing
   * notification + summary surfaces the *actual* failure ("402 Credits exhausted",
   * "ComfyUI: workflow not found", etc.) rather than a generic
   * "Story essence extraction failed". Cleared on consumption so a subsequent
   * unrelated failure doesn't inherit the previous error.
   */
  private lastNodeError: string | null = null;

  /**
   * Read and clear `lastNodeError`. Call sites use this when invoking
   * `executor.markFailed` so the actual cause (set by the helper that
   * returned null) reaches the user-facing notification + summary.
   * Falls back to the supplied generic string if no helper captured
   * an error.
   */
  private consumeLastNodeError(fallback: string): string {
    const captured = this.lastNodeError;
    this.lastNodeError = null;
    return captured && captured.trim().length > 0 ? captured : fallback;
  }
  /** Pending media generation promises (parallel mode) */
  private pendingMedia = new Map<string, Promise<string | null>>();
  /** prompt_relay mode: shot_video nodes for the same scene share one
   *  bundle-rendering pass. Lock value is a Map<shotNumber, path>
   *  because long scenes split into multiple chunks — different shots
   *  in the same scene may resolve to different bundle files. First
   *  arrival fires the render; later arrivals await the same promise.
   *  On null/throw the lock clears so the next caller retries (handles
   *  the race where shot_video fires before sibling shot_images are
   *  ready). */
  private sceneBundleLocks = new SceneBundleLockMap<Map<number, string>>();
  /** prompt_relay: scenes we've already determined cannot be rendered
   *  as a bundle (e.g. > 20 shots, > 1000 frames). These never retry —
   *  the cap is structural, not transient. Subsequent shot_videos for
   *  the scene skip the relay path entirely and go per-shot. */
  private unbundleableScenes = new Set<number>();
  /** Timeline state — populated during execution, saved to timeline.json */
  private timeline: Timeline | null = null;
  /** Tracks how many times a dependency was regenerated for a given parent node (loop protection) */
  private depRegenCounts = new Map<string, number>();
  /**
   * When set, the next run() only executes nodes in this set (filters readyNodes).
   * Used by redoNode to isolate redo to the targeted node, so other pending work
   * in the graph does not auto-resume. Cleared at the start of each run().
   */
  private redoOnlyNodes: Set<string> | null = null;
  /**
   * Shot node IDs that have already had a continuity-reroll hint injected.
   * Prevents the hint from being applied twice on re-runs of the same node.
   */
  private retriedContinuity = new Set<string>();

  private static readonly NON_CUT_TRANSITION_DURATIONS: Partial<Record<import('../timeline/types.js').TransitionType, number>> = {
    flash_to_white: 200,
    dip_to_black: 800,
    fade: 500,
    crossfade: 500,
    dissolve: 500,
    wipe_left: 500,
    wipe_right: 500,
    wipe_up: 500,
    wipe_down: 500,
    circle_open: 500,
    circle_close: 500,
    radial: 500,
    slide_left: 500,
    slide_right: 500,
  };

  constructor(llm: LLMClient, config: ExecutorAgentConfig) {
    super();
    this.llm = llm;
    this.config = config;
    // Resolve the stage gate up-front if provided via config. Throws early on
    // invalid stage names so misconfiguration fails at construction, not
    // silently during the loop.
    if (config.stopAtStage) {
      const resolved = resolveStageToTypeIds(config.stopAtStage);
      if (!resolved) {
        throw new Error(
          `Unknown stopAtStage: '${config.stopAtStage}'. See stages.ts VALID_STAGES.`,
        );
      }
      this.stopAtStageTypeIds = new Set(resolved);
    }
    if (config.stopAfterNode) {
      this.stopAfterNodeId = config.stopAfterNode;
    }
    // Build per-call router. When LLM_ROUTING_ENABLED=false (default), every
    // purpose resolves to the default client so behavior is unchanged.
    this.router = buildRouterFromEnv(config.projectDir);
    if (this.router.isEnabled()) {
      // Best-effort: log routing status to the executor log after initialization
      setImmediate(() => this.log('LLM routing ENABLED — per-purpose model selection active'));
    }

    // Set up log file — try project dir first, fall back to cwd
    const projectLogsDir = join(config.projectDir, 'logs');
    const cwdLogsDir = join(process.cwd(), 'logs');
    const logsDir = existsSync(config.projectDir) ? projectLogsDir : cwdLogsDir;
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    this.logPath = join(logsDir, 'executor.log');
    this.lockFilePath = join(config.projectDir, '.executor.lock');
    // Roll over the log if the existing file has crossed the size cap.
    // The executor.log is append-only across runs; without this, a
    // single deadlock-and-spin episode can grow it to GBs (we hit 5 GB
    // on story_begins_girl_sprinting-2 today). Keep the last 3 rolled
    // files so recent runs are still inspectable.
    this.rotateLogIfNeeded(this.logPath, 50 * 1024 * 1024, 3);
    this.log('=== ExecutorAgent initialized ===');
    this.log(`Template: ${config.template.id}, Goal: ${config.goal.description}`);
    this.log(`Target artifacts: ${config.goal.targetArtifacts.join(', ')}`);
    this.log(`Preferences: ${JSON.stringify(config.goal.preferences)}`);

    // Build or restore executor
    if (config.project.executorState) {
      this.executor = DependencyGraphExecutor.fromState(
        config.project.executorState,
        config.template,
      );
      // Reset stuck nodes from previous session:
      // - 'failed' nodes: transient errors, retry them
      // - 'in_progress'/'ready' nodes: server crashed mid-execution, reset to pending
      const stuckNodes = this.executor.getAllNodes().filter(
        n => n.status === 'failed' || n.status === 'in_progress' || n.status === 'ready',
      );
      if (stuckNodes.length > 0) {
        this.log(`Resetting ${stuckNodes.length} stuck node(s) for retry: ${stuckNodes.map(n => `${n.id}(${n.status})`).join(', ')}`);
        for (const node of stuckNodes) {
          this.executor.invalidateNode(node.id);
        }
      }

      // Repair missing nodes: if a node references a dependency that doesn't exist,
      // recreate it from the template. This fixes graph corruption from manual resets.
      this.repairMissingNodes();

      // Heal stale matching-scope deps that an earlier buggy version of the
      // dangling-dep cleanup may have silently stripped (see stateHeal.ts).
      // Safe to run on every resume — idempotent when deps are healthy.
      try {
        const report = healStaleMatchingDeps(this.executor, config.template);
        if (report.added > 0) {
          this.log(`State heal: restored ${report.added} stale matching-scope dep(s)`);
          for (const d of report.details) {
            this.log(`  ${d.nodeId} ← ${d.restoredDep}`);
          }
          this.persistState();
        }
      } catch (err) {
        this.log(`State heal skipped: ${(err as Error).message}`);
      }

      // Graph-template migration: a project persisted under an older
      // template may be missing per-item nodes the current template now
      // declares (e.g. scene_shot_plan, shot_breakdown added in the
      // hierarchical-breakdown refactor), and may carry stale dep edges
      // on nodes whose contract changed. The migration synthesizes the
      // missing nodes, prunes deps that are no longer declared, and
      // cascade-invalidates nodes whose contract drifted so they re-run
      // under the new flow. Nodes whose contract is unchanged keep
      // their status + outputPath — no rework of completed upstream.
      try {
        const report = migrateGraphToTemplate(this.executor, config.template);
        if (
          report.synthesized.length > 0 ||
          report.rewired.length > 0 ||
          report.invalidated.length > 0 ||
          report.deleted.length > 0
        ) {
          this.log(
            `Graph migration: deleted=${report.deleted.length} ` +
            `synthesized=${report.synthesized.length} ` +
            `rewired=${report.rewired.length} invalidated=${report.invalidated.length}`,
          );
          for (const d of report.deleted) this.log(`  − ${d}`);
          for (const s of report.synthesized) this.log(`  + ${s.id} (${s.reason})`);
          for (const r of report.rewired) this.log(`  ~ ${r.id}`);
          this.persistState();
        }
      } catch (err) {
        this.log(`Graph migration skipped: ${(err as Error).message}`);
      }
    } else {
      const scanner = new AssetScanner(config.template);
      const scanResult = scanner.scan(config.projectDir, config.project);
      const planner = new BackwardPlanner(config.template);
      const plan = planner.buildPlan(config.goal, scanResult.registry);
      this.executor = DependencyGraphExecutor.fromPlan(plan, config.template);
    }

    // Wire the persistence callback so every public mutation on the
    // executor flushes to project.json. This kills the desync class of
    // bug where a kill between an in-memory mutation (e.g.
    // expandCollection) and the next persistState() call would leave
    // the executor's persisted state behind. The 22 manual
    // persistState() calls scattered through this file remain as
    // belt-and-suspenders but new mutation sites no longer have to
    // remember to persist.
    this.executor.setOnMutation(() => this.persistState());
  }

  /**
   * Acquire a project-level lock to prevent concurrent executor runs.
   * Uses an in-memory static map (handles same-process concurrency from multiple
   * WebSocket sessions) plus a lock file (handles cross-process concurrency).
   */
  private acquireProjectLock(): boolean {
    const projectDir = this.config.projectDir;
    const sessionId = this.config.name ?? 'unknown';

    // 1. Check in-memory lock (same-process concurrency)
    const existing = ExecutorAgent.activeProjects.get(projectDir);
    if (existing) {
      // Stale lock check: if the lock is older than 30 minutes, assume it's stale
      // (executor crashed, WebSocket dropped, server hot-reloaded without cleanup)
      const ageMs = Date.now() - existing.startedAt;
      const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
      if (ageMs > STALE_THRESHOLD_MS) {
        this.log(`Removing stale in-memory lock (session=${existing.sessionId}, age=${Math.round(ageMs / 60000)}m)`);
        ExecutorAgent.activeProjects.delete(projectDir);
      } else {
        this.log(`LOCK BLOCKED (in-memory): project already has active executor from session=${existing.sessionId}, started=${new Date(existing.startedAt).toISOString()}`);
        return false;
      }
    }

    // 2. Check file-based lock (cross-process concurrency)
    try {
      if (existsSync(this.lockFilePath)) {
        const lockContent = readFileSync(this.lockFilePath, 'utf-8');
        const match = lockContent.match(/pid=(\d+)/);
        if (match) {
          const lockPid = parseInt(match[1]!, 10);
          if (lockPid !== process.pid) {
            try {
              process.kill(lockPid, 0);
              // Different process is still alive
              this.log(`LOCK BLOCKED (file): another process is running (pid=${lockPid})`);
              return false;
            } catch {
              // Process is dead — stale lock
              this.log(`Removing stale lock file (pid=${lockPid} is dead)`);
            }
          }
        }
      }
    } catch { /* ignore file errors */ }

    // 3. Acquire both locks
    ExecutorAgent.activeProjects.set(projectDir, { sessionId, startedAt: Date.now() });
    try {
      writeFileSync(this.lockFilePath, `pid=${process.pid}\nsession=${sessionId}\nstarted=${new Date().toISOString()}\n`);
    } catch { /* file lock is best-effort */ }

    this.log(`Lock acquired (session=${sessionId}, pid=${process.pid})`);
    return true;
  }

  /**
   * Release the project-level lock.
   */
  private releaseProjectLock(): void {
    const projectDir = this.config.projectDir;

    // Release in-memory lock
    ExecutorAgent.activeProjects.delete(projectDir);

    // Release file lock
    try {
      if (existsSync(this.lockFilePath)) {
        unlinkSync(this.lockFilePath);
      }
    } catch { /* ignore */ }

    this.log(`Lock released (pid=${process.pid})`);
  }

  /**
   * Write a timestamped line to the executor log.
   */
  private log(message: string): void {
    try {
      const timestamp = new Date().toISOString();
      appendFileSync(this.logPath, `[${timestamp}] ${message}\n`);
    } catch {
      // Ignore logging errors
    }
  }

  /**
   * If the log file is at/above `maxBytes`, rotate it:
   *   executor.log.{keep} is dropped (if it exists),
   *   executor.log.{keep-1} → .{keep},
   *   ...
   *   executor.log.1 → .2,
   *   executor.log → .1
   * The next append creates a fresh executor.log.
   *
   * Best-effort: any fs error is swallowed so a permissions glitch
   * doesn't take down the executor at startup.
   */
  private rotateLogIfNeeded(logPath: string, maxBytes: number, keep: number): void {
    try {
      if (!existsSync(logPath)) return;
      const size = statSync(logPath).size;
      if (size < maxBytes) return;

      // Drop the oldest if we already have `keep` rolled files.
      const oldest = `${logPath}.${keep}`;
      if (existsSync(oldest)) {
        try { unlinkSync(oldest); } catch { /* ignore */ }
      }

      // Shift the existing rolled files: .{N-1} → .{N}, etc.
      for (let i = keep - 1; i >= 1; i--) {
        const from = `${logPath}.${i}`;
        const to = `${logPath}.${i + 1}`;
        if (existsSync(from)) {
          try { renameSync(from, to); } catch { /* ignore */ }
        }
      }

      // Rotate the current file to .1
      try { renameSync(logPath, `${logPath}.1`); } catch { /* ignore */ }
    } catch {
      // Best-effort — never fail the executor for a log issue.
    }
  }

  /**
   * Get the LLMClient configured for a specific call purpose.
   * When LLM_ROUTING_ENABLED=false (default), returns the default client.
   * When enabled, resolves via the router's purpose/tier/default chain.
   */
  private llmFor(purpose: LLMPurpose): LLMClient {
    return this.router.isEnabled() ? this.router.getClient(purpose) : this.llm;
  }

  /**
   * Return the model name that will be used for a given LLM call purpose.
   * Used for UI display — each tool_call event attaches this so the user can
   * see which model produced a given prompt/output. Works with or without
   * per-purpose routing enabled.
   */
  private modelFor(purpose: LLMPurpose): string {
    try {
      return this.router.resolveConfig(purpose).model ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Map an artifact node typeId to an LLM purpose for per-call routing.
   * Unknown types fall back to content.scene as a reasonable default.
   */
  private purposeForNode(node: ExecutionNode): LLMPurpose {
    switch (node.typeId) {
      case 'story':           return 'content.story';
      case 'plot':            return 'content.plot';
      case 'character':       return 'content.character';
      case 'setting':         return 'content.setting';
      case 'object':          return 'content.setting'; // similar scope to setting
      case 'scene':           return 'content.scene';
      case 'world_style':     return 'content.world_style';
      case 'character_image': return 'content.character';
      case 'setting_image':   return 'content.setting';
      case 'object_image':    return 'content.setting';
      case 'scene_video_prompt':    return 'structured.scene_breakdown';
      case 'shot_image_prompt':     return 'content.shot_image_prompt';
      case 'shot_motion_directive': return 'content.shot_motion_directive';
      default:                return 'content.scene';
    }
  }

  /**
   * Resolve an array of LLM reference objects ({refId, type, ...}) to absolute file paths.
   * Uses the same resolution logic as image_text_to_image — looks up each refId in the
   * executor graph and returns paths to completed .png files.
   */
  private resolveRefIds(references: Array<{ refId?: string; type?: string }>): string[] {
    if (!references || references.length === 0) return [];
    const paths: string[] = [];
    for (const ref of references) {
      if (!ref.refId) continue;
      const refNode = this.executor.getNode(ref.refId);
      if (refNode?.outputPath?.endsWith('.png')) {
        paths.push(join(this.config.projectDir, refNode.outputPath));
      }
    }
    return paths;
  }

  /**
   * Edit an image with layered references. FLUX Klein supports up to 4 refs per call.
   * When there are more refs than fit in one pass, this iterates:
   *   Pass 1: base image + refs[0..3] → intermediate image
   *   Pass 2: intermediate + refs[4..7] → intermediate image
   *   ...until all refs are applied.
   */
  private async editImageLayered(
    editPrompt: string,
    baseImagePath: string,
    referenceImages: string[],
    outputDir: string,
    filenamePrefix: string,
  ): Promise<string> {
    const provider = getProviderRegistry().getImageEditor();
    if (!provider?.editImage) {
      throw new Error('No image editor available');
    }

    const BATCH_SIZE = 4;
    let currentBase = baseImagePath;

    if (referenceImages.length <= BATCH_SIZE) {
      // Single pass — no layering needed
      const result = await provider.editImage({
        editPrompt,
        baseImagePath: currentBase,
        referenceImages,
        outputDir,
        filenamePrefix,
      });
      return result.filePath;
    }

    // Multiple passes — layer refs in batches
    const totalPasses = Math.ceil(referenceImages.length / BATCH_SIZE);
    for (let pass = 0; pass < totalPasses; pass++) {
      const batch = referenceImages.slice(pass * BATCH_SIZE, (pass + 1) * BATCH_SIZE);
      const isLastPass = pass === totalPasses - 1;
      const passPrefix = isLastPass ? filenamePrefix : `${filenamePrefix}_layer${pass + 1}`;

      this.log(`  Layered edit pass ${pass + 1}/${totalPasses}: ${batch.length} refs`);

      const result = await provider.editImage({
        editPrompt,
        baseImagePath: currentBase,
        referenceImages: batch,
        outputDir,
        filenamePrefix: passPrefix,
      });
      currentBase = result.filePath;
    }

    return currentBase;
  }

  /**
   * Emit a phase transition if the node's category differs from current phase.
   */
  private emitPhaseIfChanged(node: ExecutionNode): void {
    const typeDef = this.config.template.artifactTypes[node.typeId];
    const category = typeDef?.category ?? 'concept';

    // Use node typeId for more specific phase names, fall back to category
    const typePhaseNames: Record<string, string> = {
      plot: 'Plot Development',
      story: 'Story Writing',
      character: 'Character Development',
      setting: 'Setting Development',
      scene: 'Scene Breakdown',
      world_style: 'World Style',
      character_image: 'Character Reference Images',
      setting_image: 'Setting Reference Images',
      scene_video_prompt: 'Scene Breakdown',
      shot_image_prompt: 'Shot Composition',
      shot_motion_directive: 'Shot Motion Directives',
      shot_image: 'Shot Image Generation',
      shot_video: 'Shot Video Generation',
      final_video: 'Final Assembly',
    };

    const categoryPhaseNames: Record<string, string> = {
      concept: 'Plot Development',
      structure: 'Content Writing',
      entity: 'Character Development',
      environment: 'Setting Development',
      segment: 'Scene Breakdown',
      visual_ref: 'Image Generation',
      clip: 'Video Generation',
      final: 'Final Assembly',
    };

    const phaseName = typePhaseNames[node.typeId] ?? categoryPhaseNames[category] ?? category;

    if (phaseName !== this.currentPhase) {
      const fromPhase = this.currentPhase || 'starting';
      this.currentPhase = phaseName;

      // Update project.currentPhase so it persists across sessions
      if (this.config.project.currentPhase !== undefined) {
        this.config.project.currentPhase = phaseName;
      }

      this.emit({
        type: 'phase_transition',
        fromPhase,
        toPhase: phaseName,
        displayName: phaseName,
        description: `Working on ${typeDef?.displayName ?? node.typeId}`,
      });
      this.log(`  Phase: ${fromPhase} → ${phaseName}`);
    }
  }

  /**
   * Emit todo_update with all graph nodes as todo items, sorted by dependency order.
   * Groups items by type (all characters together, all scenes together, etc.)
   */
  private emitTodoUpdate(): void {
    const nodes = this.executor.getAllNodes();

    // Sort by dependency/execution order — the order things will actually run.
    // Uses topological order from the template, then itemId for per-item nodes.
    const creationOrder = this.executor.getGraph().getCreationOrder();
    const typeOrder = new Map<string, number>();
    creationOrder.forEach((typeId, idx) => typeOrder.set(typeId, idx));

    const sorted = [...nodes].sort((a, b) => {
      // Sort by topological type order (dependency order)
      const aOrder = typeOrder.get(a.typeId) ?? 999;
      const bOrder = typeOrder.get(b.typeId) ?? 999;
      if (aOrder !== bOrder) return aOrder - bOrder;

      // Within same type, sort by itemId (scene_1 before scene_2)
      return (a.itemId ?? '').localeCompare(b.itemId ?? '');
    });

    // Determine which type-level nodes have been expanded into per-item children
    const expandedTypes = new Set<string>();
    for (const node of sorted) {
      if (node.itemId) expandedTypes.add(node.typeId);
    }

    const todos: ExpandableTodoItem[] = sorted
      .filter(node => {
        // Hide type-level nodes that have per-item children (expanded into per-scene/per-shot)
        if (!node.itemId && expandedTypes.has(node.typeId)) {
          return false;
        }
        return true;
      })
      .map(node => {
        let status: ExpandableTodoItem['status'];
        switch (node.status) {
          case 'completed': status = 'completed'; break;
          case 'in_progress': case 'ready': status = 'in_progress'; break;
          case 'failed': status = 'cancelled'; break;
          case 'skipped': status = 'completed'; break;
          default: status = 'pending'; break;
        }

        return {
          id: node.id,
          content: node.displayName,
          status,
          visible: true,
          depth: 0,
        };
      });

    // Carry a parallel array of node-shape info keyed by the same ids.
    // Kept separate from `todos` because `ExpandableTodoItem` has a
    // strict shape — this metadata doesn't fit there — and is needed
    // by the frontend Storyboard to render shot frames / videos
    // without parsing filenames.
    const nodeInfo: TodoNodeInfo[] = sorted
      .filter(node => !(!node.itemId && expandedTypes.has(node.typeId)))
      .map(node => {
        const info: TodoNodeInfo = {
          id: node.id,
          typeId: node.typeId,
          status: node.status,
        };
        if (node.itemId !== undefined) info.itemId = node.itemId;
        if (node.outputPath) info.outputPath = node.outputPath;
        if (node.outputPaths && Object.keys(node.outputPaths).length > 0) {
          info.outputPaths = node.outputPaths;
        }
        return info;
      });

    this.emit({ type: 'todo_update', todos, nodes: nodeInfo });
  }

  /**
   * Initialize the agent (matches GenericAgent interface).
   */
  async initialize(): Promise<void> {
    this._initialized = true;
  }

  /**
   * Is the `/run-to <stage>` gate satisfied? Thin wrapper around the pure
   * helper in stages.ts — kept as a method so the run loop can consult
   * it without passing graph state around.
   */
  private shouldStopForStageGate(): boolean {
    const nodes = this.executor.getAllNodes().map(n => ({ typeId: n.typeId, status: n.status, id: n.id }));
    const hasRedoIsolation = this.redoOnlyNodes !== null;
    if (isStageGateSatisfied(nodes, this.stopAtStageTypeIds, hasRedoIsolation)) return true;
    if (isNodeGateSatisfied(nodes, this.stopAfterNodeId, hasRedoIsolation)) return true;
    return false;
  }

  /**
   * Stop the agent mid-execution.
   *
   * Two cancellation channels fire in parallel:
   *
   * 1. **Server-side**: `ComfyUIClient.interrupt()` tells ComfyUI to
   *    abort the active prompt. We don't await it indefinitely — when
   *    the proxy is glitchy (typical 502 spike) the RPC can hang for
   *    many seconds. A 5s race timeout keeps `stop()` snappy and
   *    surfaces a debug log when the interrupt didn't land.
   *
   * 2. **Client-side**: `abortAllInFlightWorkflows()` closes any
   *    `queueAndWaitWS` WebSockets opened by this process and rejects
   *    their pending promises with `Error('aborted')`. Without this,
   *    a ComfyUI client blocked on a WebSocket waiting for an
   *    `execution_success` frame from a server that has already gone
   *    silent (interrupted, 502'd, network blip) had no way out —
   *    `stop()` returned but the run loop's `await` was still parked
   *    upstream, and the BackgroundTaskRunner stayed in 'running'
   *    state for a long time after the user clicked Stop.
   */
  stop(reason: 'user' | 'shutdown' = 'user'): void {
    this.stopped = true;
    this.stopReason = 'cancelled';
    this.lastStopOrigin = reason;
    // Abort in-flight LLM streams immediately. Without this, a
    // reasoning-model call (1-7 min wall-clock for DeepSeek-R /
    // o-series / Gemini-thinking) keeps running until natural
    // completion or its internal 200s self-timeout, making the
    // user-facing Cancel feel broken. The runAbortController.signal
    // is threaded into every generateForNode LLM call.
    this.runAbortController.abort();

    // Channel 1 — server-side interrupt with a 5s timeout race so a
    // hanging RPC doesn't keep the cancel pending indefinitely.
    void import('../../services/comfyui/ComfyUIClient.js').then(
      ({ ComfyUIClient, abortAllInFlightWorkflows }) => {
        const interruptPromise = new ComfyUIClient({}).interrupt();
        const timeout = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 5000),
        );
        Promise.race([interruptPromise.then(() => 'ok' as const), timeout])
          .then((outcome) => {
            if (outcome === 'timeout') {
              this.log(
                `[stop] ComfyUI /interrupt RPC timed out after 5s — server may be unreachable`,
              );
            }
          })
          .catch((err) => {
            this.log(`[stop] ComfyUI /interrupt failed: ${(err as Error).message}`);
          });

        // Channel 2 — close any in-flight WS so awaiters bail
        // immediately. Synchronous; doesn't depend on the server
        // responding to the interrupt.
        // Reason marker (`:user` / `:shutdown`) ends up in failed-node
        // error strings so auto-recovery and UX can distinguish them
        // from real failures.
        const closed = abortAllInFlightWorkflows(`agent.stop():${reason}`);
        if (closed > 0) {
          this.log(`[stop:${reason}] aborted ${closed} in-flight ComfyUI WebSocket(s)`);
        }
      },
    ).catch(() => {});
  }

  /**
   * Pin the isolated-redo whitelist to the supplied ids.
   *
   * Used by `dhee_run_to scope='last_invalidated'` (and the UI's
   * "Run only this" affordance) so the next run() executes ONLY
   * those nodes and exits when they're done — no cascade into
   * unrelated pending work in the graph.
   *
   * Pass `null` to clear the pin so a later run drains everything
   * pending. Caller responsibility: only set this when the targeted
   * nodes are already in `pending` status (the loop won't transition
   * a `completed` node back to runnable just because it's whitelisted).
   */
  setRedoOnlyNodes(ids: string[] | null): void {
    this.redoOnlyNodes = ids === null ? null : new Set(ids);
  }


  /**
   * Set or clear the `/run-to <stage>` gate at runtime. Pass a stage name
   * (e.g. `'character_image'`) to arm the gate; pass `null` to clear it.
   *
   * Called by ConversationManager per-task so the long-lived agent can
   * pick up a per-invocation `stopAtStage` without being reconstructed.
   * Throws on unknown stage names — fail fast on bad input.
   */
  /**
   * Set or clear the per-node pause target at runtime. Sister of
   * `setStopAtStage`. Pass a node id (e.g. `'shot_image:scene_1_shot_1'`)
   * to arm; pass `null` to clear.
   */
  setStopAfterNode(nodeId: string | null): void {
    this.stopAfterNodeId = nodeId;
  }

  setStopAtStage(stage: string | null): void {
    if (stage === null) {
      this.stopAtStageTypeIds = null;
      return;
    }
    const resolved = resolveStageToTypeIds(stage);
    if (!resolved) {
      throw new Error(
        `Unknown stopAtStage: '${stage}'. See stages.ts VALID_STAGES.`,
      );
    }
    this.stopAtStageTypeIds = new Set(resolved);
  }

  /**
   * Why the executor last stopped. Returns null before the first run().
   *
   * - `'complete'`: `executor.isComplete()` returned true — all target
   *   artifacts (or their graph) finished naturally.
   * - `'paused_at_stage'`: the `/run-to <stage>` gate fired (or the
   *   legacy test-only `stopAfterNodeType` fired). State is safe to
   *   resume from.
   * - `'cancelled'`: `stop()` was called externally (user hit the Stop
   *   button; WebSocket `cancel` message).
   * - `'failed'`: a node failed and self-repair couldn't recover.
   */
  getStopReason(): 'complete' | 'paused_at_stage' | 'cancelled' | 'failed' | null {
    return this.stopReason;
  }

  /**
   * Check if the agent is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get tool names (for compatibility — executor has no tools).
   */
  getToolNames(): string[] {
    return [];
  }

  /**
   * Set autonomous mode (no-op for executor — it's always deterministic).
   */
  setAutonomousMode(_enabled: boolean): void {
    // No-op
  }

  /**
   * Toggle parallel media generation at runtime.
   */
  setParallelMediaGeneration(enabled: boolean): void {
    this.config.parallelMediaGeneration = enabled;
    this.log(`Parallel media generation: ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Invalidate a node for re-execution.
   *
   * Modes:
   *   - `redoNode(nodeId)` — full shot/node redo. Cascades to all dependents,
   *     clears outputPaths entirely, all frames regenerate.
   *   - `redoNode(nodeId, { frame })` — single-frame redo. Drops just that
   *     frame from outputPaths. No cascade. Only that frame regenerates;
   *     downstream video/final are left alone.
   *   - `redoNode(nodeId, { scope: 'prompt' })` — prompt regen. Invalidates
   *     the matching shot_image_prompt AND the shot_image (so the LLM re-writes
   *     the prompt and the image regenerates). No cascade past shot_image.
   *   - `redoNode(nodeId, { scope: 'image_only' })` — invalidate JUST this
   *     shot_image node, no cascade. Used by the edit-prompt flow after the
   *     edited prompt was saved to disk — we want to regenerate the image
   *     from the edited prompt without touching the prompt node (which would
   *     re-run the LLM and overwrite edits).
   *
   * After calling this, call run('') to resume execution of the invalidated nodes.
   */
  redoNode(
    nodeId: string,
    opts: { frame?: string; scope?: 'prompt' | 'image_only' } = {},
  ): ExecutionNode[] {
    const { frame, scope } = opts;

    // image_only scope: invalidate this node AND cascade — but ONLY to
    // dependents that were already completed. If shot_video was generated,
    // regenerate it from the new image. If shot_video is still pending,
    // leave it alone — it'll pick up the new image naturally when it runs.
    //
    // Frame-specific edit (last_frame / mid_frame only):
    //   Preserve the other frames so only the edited frame regenerates.
    //   first_frame edits drop all frames (mid/last derive from first).
    if (scope === 'image_only') {
      const preserveOthers = frame === 'last_frame' || frame === 'mid_frame';
      const invalidated = this.executor.invalidateNode(nodeId, {
        cascade: true,
        cascadeOnlyCompleted: true,
        preserveFramesOther: preserveOthers,
        singleFrame: preserveOthers ? frame : undefined,
      });
      if (invalidated.length === 0) {
        this.log(`Redo image_only: node '${nodeId}' not found`);
        return [];
      }
      const frameLabel = frame ? ` [frame=${frame}]` : '';
      this.log(`Redo image_only${frameLabel}: invalidated ${invalidated.length} node(s): ${invalidated.map(n => n.id).join(', ')}`);
      this.persistState();
      this.emitTodoUpdate();
      const cascadedCount = invalidated.length - 1;
      const cascadedText = cascadedCount > 0
        ? ` (+${cascadedCount} already-completed dependent${cascadedCount > 1 ? 's' : ''})`
        : '';
      this.emit({
        type: 'notification',
        level: 'info',
        message: `Redoing ${nodeId.replace(/^shot_image:/, '')}${frame ? ` · ${frame}` : ''} (from edited prompt)${cascadedText}`,
      });
      this.redoOnlyNodes = new Set(invalidated.map(n => n.id));
      return invalidated;
    }

    // Prompt scope: invalidate shot_image_prompt + shot_image, cascade to
    // already-completed downstream (e.g. shot_video, final_video). Without
    // the cascade, a prompt re-roll regenerates the image but the existing
    // shot_video stays `completed` — silently baked from the OLD image.
    // cascadeOnlyCompleted leaves pending downstream alone; they'll pick up
    // the new image when their turn comes.
    if (scope === 'prompt') {
      const shotImageNodeId = nodeId.startsWith('shot_image_prompt:')
        ? nodeId.replace('shot_image_prompt:', 'shot_image:')
        : nodeId;
      const promptNodeId = shotImageNodeId.replace('shot_image:', 'shot_image_prompt:');

      const invalidated: ExecutionNode[] = [];
      invalidated.push(...this.executor.invalidateNode(promptNodeId, { cascade: false }));
      invalidated.push(...this.executor.invalidateNode(shotImageNodeId, { cascade: true, cascadeOnlyCompleted: true }));
      if (invalidated.length === 0) {
        this.log(`Redo prompt: nodes not found for '${shotImageNodeId}'`);
        return [];
      }
      this.log(`Redo prompt: invalidated ${invalidated.length} node(s): ${invalidated.map(n => n.id).join(', ')}`);
      this.persistState();
      this.emitTodoUpdate();
      this.emit({
        type: 'notification',
        level: 'info',
        message: `Redoing prompt for ${shotImageNodeId.replace('shot_image:', '')}`,
      });
      this.redoOnlyNodes = new Set(invalidated.map(n => n.id));
      return invalidated;
    }

    // Frame redo:
    //   - first_frame  → clear ALL outputPaths. Last/mid frames are derived
    //                    from first_frame via edit_first_frame, so they must
    //                    also regenerate to stay consistent.
    //   - mid/last     → clear just that frame. first_frame stays; the other
    //                    additional frame (if present) also stays.
    const invalidated = this.executor.invalidateNode(nodeId, frame
      ? (frame === 'first_frame'
          ? { cascade: false }  // clear all outputPaths → all frames regen
          : { cascade: false, preserveFramesOther: true, singleFrame: frame }
        )
      : undefined,
    );
    if (invalidated.length === 0) {
      this.log(`Redo: node '${nodeId}' not found or already pending`);
      return [];
    }

    const scopeLabel = frame ? `${nodeId} (frame: ${frame})` : nodeId;
    this.log(`Redo: invalidated ${invalidated.length} node(s) [scope=${scopeLabel}]: ${invalidated.map(n => n.id).join(', ')}`);
    this.persistState();
    this.emitTodoUpdate();

    // Notify UI about the cascade
    const names = invalidated.map(n => n.displayName);
    const dependentText = invalidated.length > 1
      ? ` (+${invalidated.length - 1} dependent${invalidated.length > 2 ? 's' : ''})`
      : '';
    const frameText = frame ? ` [${frame}]` : '';
    this.emit({
      type: 'notification',
      level: 'info',
      message: `Redoing ${names[0]}${frameText}${dependentText}`,
    });

    this.redoOnlyNodes = new Set(invalidated.map(n => n.id));
    return invalidated;
  }

  // ===========================================================================
  // Timeline helpers
  // ===========================================================================

  /** Send full timeline state to the frontend via WebSocket. */
  private emitTimelineUpdate(): void {
    if (!this.timeline) return;
    this.emit({
      type: 'timeline_update',
      timeline: this.timeline,
    });
  }

  /** Create timeline skeleton from all scene nodes in the dependency graph. */
  private initializeTimelineFromScenes(): void {
    const sceneNodes = this.executor.getAllNodes()
      .filter(n => n.typeId === 'scene' && n.status !== 'skipped')
      .sort((a, b) => (a.itemId ?? '').localeCompare(b.itemId ?? ''));

    if (sceneNodes.length === 0) return;

    const totalDuration = (this.config.goal.preferences.duration) ?? 30;
    const descriptors: SegmentDescriptor[] = sceneNodes.map(n => ({
      id: n.itemId ?? n.id,
      label: n.displayName,
    }));

    this.timeline = createTimelineSkeleton(totalDuration, descriptors);
    saveTimeline(this.config.projectDir, this.timeline);
    this.emitTimelineUpdate();
    this.log(`Timeline: created skeleton with ${descriptors.length} scene segments (${totalDuration}s)`);
  }

  private timelineCoversCurrentScenes(): boolean {
    if (!this.timeline) return false;

    const sceneIds = this.executor.getAllNodes()
      .filter(n => n.typeId === 'scene' && n.status !== 'skipped')
      .map(n => n.itemId ?? n.id);

    if (sceneIds.length === 0) return true;

    return sceneIds.every(sceneId =>
      this.timeline!.segments.some(s => s.id === sceneId || s.id.startsWith(`${sceneId}_shot_`))
    );
  }

  private ensureTimelineInitialized(): void {
    const hasSceneNodes = this.executor.getAllNodes().some(
      n => n.typeId === 'scene' && n.status !== 'skipped'
    );
    if (!hasSceneNodes) return;

    if (!this.timeline || !this.timelineCoversCurrentScenes()) {
      this.initializeTimelineFromScenes();
    }
  }

  private buildShotDescriptorsForScene(
    sceneId: string,
    sceneVideoPromptNode?: ExecutionNode,
    sceneVideoPromptOutputPath?: string
  ): Array<{ label: string; duration: number; metadata?: Record<string, unknown> }> {
    const promptNode = sceneVideoPromptNode ?? this.executor.getNode(`scene_video_prompt:${sceneId}`);
    const resolvedOutputPath = sceneVideoPromptOutputPath ?? promptNode?.outputPath;
    if (!resolvedOutputPath) return [];

    const svpPath = join(this.config.projectDir, resolvedOutputPath);
    if (!existsSync(svpPath)) return [];

    let svpContent = readFileSync(svpPath, 'utf-8').trim();
    if (svpContent.startsWith('```')) {
      svpContent = svpContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(svpContent);
    if (!Array.isArray(parsed.shots)) return [];

    return parsed.shots.map((shot: {
      shotNumber?: number;
      shotType?: string;
      duration?: number;
      prompt?: string;
      imagePrompt?: string;
      transition?: string;
    }) => ({
      label: `Shot ${shot.shotNumber}: ${shot.shotType ?? 'shot'}`,
      duration: shot.duration || 5,
      metadata: {
        ...(shot.shotNumber !== undefined ? { shotNumber: shot.shotNumber } : {}),
        ...(shot.shotType ? { shotType: shot.shotType } : {}),
        ...(shot.prompt ? { prompt: shot.prompt } : {}),
        ...(shot.imagePrompt ? { imagePrompt: shot.imagePrompt } : {}),
        ...(shot.transition ? { transition: shot.transition } : {}),
      },
    }));
  }

  private resolveSceneVideoPromptOutputPath(
    sceneId: string,
    sceneVideoPromptNode?: ExecutionNode,
    sceneVideoPromptOutputPath?: string,
  ): string | undefined {
    return sceneVideoPromptOutputPath
      ?? sceneVideoPromptNode?.outputPath
      ?? this.executor.getNode(`scene_video_prompt:${sceneId}`)?.outputPath;
  }

  /**
   * Post-LLM holding-beat skip for shot_image_prompt.
   *
   * Loads this shot's purpose + cameraWork from the upstream
   * scene_video_prompt JSON and runs `isHoldingBeat`. If the heuristic
   * fires, the LLM-generated `frames.last_frame` is stripped from the
   * JSON and `generationStrategy` is flipped to `'i2v'`. The downstream
   * `shot_image_last_frame` bridge no-ops on missing
   * `frames.last_frame.imagePrompt`; the video provider reads
   * `generationStrategy === 'i2v'` and routes to `ltx23_i2v_*`.
   *
   * Returns the mutated JSON string when the skip fires, or `null` when
   * the heuristic doesn't fire / the shot brief can't be resolved.
   * Callers fall back to the original `content` on null.
   *
   * Failure modes are non-fatal: any parsing / lookup error returns
   * null and the original JSON ships unchanged.
   */
  /**
   * Phase 2 orchestration hook for the transition boundary planner.
   *
   * Runs lazily — called from the shot_image_prompt post-processing
   * path. Idempotent: skips if any shot in `project.scenes[sceneNumber]`
   * already has `incomingTransition` or `needsLfAnchor` (the plan was
   * applied on a prior shot_image_prompt of the same scene).
   *
   * Sequence:
   *   1. Bail when `transitionBoundaryPlanner` flag is OFF.
   *   2. Resolve sceneNumber from the calling node's itemId.
   *   3. Check the cache (project.scenes[]).
   *   4. Load scene_video_prompt JSON → extract shots.
   *   5. Call `planSceneBoundaries` via `structured.boundary_planner` LLM.
   *   6. Ensure project.scenes[sceneNumber] + each shot exists, then
   *      apply the plan via `applyBoundaryPlanToScene`.
   *   7. Persist project.json.
   *
   * Failure modes (all non-fatal — execution continues, the flag
   * effectively no-ops for this scene):
   *   - sceneId can't be parsed
   *   - scene_video_prompt JSON missing or malformed
   *   - LLM call throws
   *   - parseBoundaryPlannerOutput returns empty plan
   *
   * The plan is per-scene, so multiple shot_image_prompts in the same
   * scene share one LLM call (the first one pays; the rest hit the
   * project.scenes cache).
   */
  private async ensureBoundaryPlanForScene(sceneId: string, sceneNumber: number): Promise<void> {
    try {
      if (!isTransitionBoundaryPlannerEnabled(
        this.config.project as { features?: { transitionBoundaryPlanner?: boolean } } | undefined,
      )) {
        return;
      }

      // Cache check — has the plan already been applied to this scene?
      const projectAny = this.config.project as {
        scenes?: Array<{
          sceneNumber?: number;
          shots?: Array<{
            shotNumber?: number;
            incomingTransition?: { operation?: string };
            needsLfAnchor?: boolean;
          }>;
        }>;
      };
      const existingScene = projectAny.scenes?.find((s) => s.sceneNumber === sceneNumber);
      const alreadyPlanned = existingScene?.shots?.some(
        (sh) => sh.incomingTransition !== undefined || sh.needsLfAnchor === true,
      );
      if (alreadyPlanned) {
        // Plan exists — skip the LLM call, but still ensure the
        // shared_frame dependency wiring is in place. This is
        // idempotent (only adds deps that don't already exist), so
        // re-runs are safe.
        this.ensureSharedFrameDepsForScene(sceneNumber, existingScene!);
        return;
      }

      // Load scene_video_prompt
      const svpOutputPath = this.resolveSceneVideoPromptOutputPath(sceneId);
      if (!svpOutputPath) return;
      const svpAbs = join(this.config.projectDir, svpOutputPath);
      if (!existsSync(svpAbs)) return;
      let svpRaw = readFileSync(svpAbs, 'utf-8').trim();
      if (svpRaw.startsWith('```')) {
        svpRaw = svpRaw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      let svp: {
        rasa?: string;
        characters?: unknown;
        shots?: Array<{
          shotNumber?: number;
          description?: string;
          purpose?: string;
          cameraWork?: string;
          dialogue?: string;
          continuityRole?: string;
        }>;
      };
      try {
        svp = JSON.parse(svpRaw);
      } catch {
        return;
      }
      const rawShots = svp.shots ?? [];
      if (rawShots.length === 0) return;

      const plannerShots: BoundaryPlannerShotInput[] = [];
      for (const s of rawShots) {
        if (typeof s.shotNumber !== 'number') continue;
        plannerShots.push({
          shotNumber: s.shotNumber,
          description: s.description ?? '',
          purpose: s.purpose ?? '',
          cameraWork: s.cameraWork ?? '',
          ...(s.dialogue ? { dialogue: s.dialogue } : {}),
          ...(s.continuityRole ? { continuityRole: s.continuityRole } : {}),
        });
      }
      if (plannerShots.length < 2) {
        // Single-shot scene — no boundaries to plan. Mark with empty
        // plan via applyBoundaryPlanToScene so the cache check above
        // returns true on retries.
        // (No-op for now — applyBoundaryPlanToScene clears stale fields
        // but with an empty plan the scene's shots stay clean; cache
        // check fails on next call and we re-enter. That's fine — the
        // bail-out at rawShots.length < 2 is cheap.)
        this.log(`  [boundary-planner] scene_${sceneNumber}: single-shot scene — no boundaries`);
        return;
      }

      const characters: string[] = Array.isArray(svp.characters)
        ? (svp.characters.filter((c) => typeof c === 'string') as string[])
        : [];
      const plannerInput: BoundaryPlannerInput = {
        sceneNumber,
        ...(svp.rasa ? { rasa: svp.rasa } : {}),
        ...(characters.length > 0 ? { characters } : {}),
        shots: plannerShots,
      };

      this.log(`  [boundary-planner] scene_${sceneNumber}: planning ${plannerShots.length} shots`);
      const llm = this.llmFor('structured.boundary_planner');
      const plan = await planSceneBoundaries(
        llm as unknown as { generateStream: (opts: Record<string, unknown>) => AsyncGenerator<{ content?: string }, unknown, unknown> },
        plannerInput,
      );

      // Ensure project.scenes[sceneNumber] + shots exist, then apply.
      // Populate shot.description so the Stage 3 mutator can look up
      // the next shot's planned description for LF-lookahead injection
      // — without this, the mutator's `nextShot.description` is
      // undefined and the injection silently no-ops.
      const sceneRef = ensureScene(this.config.project as unknown as Parameters<typeof ensureScene>[0], sceneNumber);
      for (const s of plannerShots) {
        const shotRef = ensureShot(
          this.config.project as unknown as Parameters<typeof ensureScene>[0],
          sceneNumber,
          s.shotNumber,
        );
        if (s.description && !shotRef.description) {
          shotRef.description = s.description;
        }
      }
      applyBoundaryPlanToScene(sceneRef, plan);

      // For every shared_frame boundary in the plan, amend the
      // dependency graph so shot N+1's `shot_image` node WAITS for
      // shot N's `shot_image_last_frame` bridge.
      const sceneRefForDeps = projectAny.scenes?.find((s) => s.sceneNumber === sceneNumber);
      if (sceneRefForDeps) this.ensureSharedFrameDepsForScene(sceneNumber, sceneRefForDeps);

      this.log(
        `  [boundary-planner] scene_${sceneNumber}: applied ${plan.transitions.length} transitions, ${plan.anchors.length} anchors`,
      );
      this.persistState();
    } catch (err) {
      this.log(
        `  [boundary-planner] scene_${sceneId}: planning failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Idempotent dep wiring for shared_frame boundaries.
   *
   * For each `shared_frame` transition in the scene's plan, ensure
   * shot N+1's `shot_image` node has a dependency on shot N's
   * `shot_image_last_frame` bridge. Without this dep, shot N+1's
   * reuse_prior_frame copy can execute before shot N's LF bridge has
   * produced the LF — and it silently copies shot N's FIRST frame
   * instead (the bdry2 race condition on 2026-05-23).
   *
   * Safe to call repeatedly: skips deps that already exist.
   */
  private ensureSharedFrameDepsForScene(
    sceneNumber: number,
    scene: { shots?: Array<{ shotNumber?: number; incomingTransition?: { operation?: string } }> },
  ): void {
    const shots = scene.shots ?? [];
    for (const shot of shots) {
      if (shot.incomingTransition?.operation !== 'shared_frame') continue;
      if (typeof shot.shotNumber !== 'number') continue;
      const consumerShotNum = shot.shotNumber;
      const sourceShotNum = consumerShotNum - 1;
      if (sourceShotNum < 1) continue;
      const consumerNodeId = `shot_image:scene_${sceneNumber}_shot_${consumerShotNum}`;
      const sourceLFBridgeId = `shot_image_last_frame:scene_${sceneNumber}_shot_${sourceShotNum}`;
      const consumerNode = this.executor.getNode(consumerNodeId);
      const sourceLFBridgeNode = this.executor.getNode(sourceLFBridgeId);
      if (!consumerNode || !sourceLFBridgeNode) {
        this.log(
          `  [boundary-planner] shared_frame dep amend skipped: missing ${!consumerNode ? consumerNodeId : sourceLFBridgeId}`,
        );
        continue;
      }
      if (!consumerNode.dependencies.includes(sourceLFBridgeId)) {
        consumerNode.dependencies.push(sourceLFBridgeId);
        sourceLFBridgeNode.dependents = sourceLFBridgeNode.dependents ?? [];
        if (!sourceLFBridgeNode.dependents.includes(consumerNodeId)) {
          sourceLFBridgeNode.dependents.push(consumerNodeId);
        }
        this.log(
          `  [boundary-planner] shared_frame: added dep ${consumerNodeId} ← ${sourceLFBridgeId}`,
        );
      }
    }
  }

  private applyHoldingBeatSkip(content: string, node: ExecutionNode): string | null {
    if (!node.itemId || node.typeId !== 'shot_image_prompt') return null;
    // Per-project opt-in. Default OFF — legacy behavior (full FL2V with
    // a separate LF prompt) until the project explicitly sets
    // `features.skipHoldingBeatLF: true` in project.json. See
    // docs/feature-flags.md for the flag registry.
    if (!isSkipHoldingBeatLFEnabled(this.config.project as { features?: { skipHoldingBeatLF?: boolean } } | undefined)) {
      return null;
    }
    const m = node.itemId.match(/^(scene_(\d+))_shot_(\d+)$/);
    if (!m || !m[1] || !m[2] || !m[3]) return null;
    const sceneId = m[1];
    const sceneNumber = parseInt(m[2], 10);
    const shotNumber = parseInt(m[3], 10);

    const svpOutputPath = this.resolveSceneVideoPromptOutputPath(sceneId);
    if (!svpOutputPath) return null;
    const svpAbs = join(this.config.projectDir, svpOutputPath);
    if (!existsSync(svpAbs)) return null;

    let svpRaw = readFileSync(svpAbs, 'utf-8').trim();
    if (svpRaw.startsWith('```')) {
      svpRaw = svpRaw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    let svp: { shots?: Array<{ shotNumber?: number; purpose?: string; cameraWork?: string }> };
    try {
      svp = JSON.parse(svpRaw);
    } catch {
      return null;
    }
    const shot = svp.shots?.find((s) => s.shotNumber === shotNumber);
    if (!shot) return null;

    const purpose = shot.purpose ?? '';
    const cameraWork = shot.cameraWork ?? '';

    // Boundary-planner integration: when `transitionBoundaryPlanner` is
    // ON and the scene has been planned, an LF with a downstream
    // consumer must be generated regardless of holding-beat status.
    // We look up the CURRENT shot's needsLfAnchor and the NEXT shot's
    // incomingTransition from project.scenes (the boundary planner's
    // output sink). Both reads are best-effort — if `scenes` is absent
    // or shaped unexpectedly, the lookups return undefined and
    // shouldSkipLastFrame collapses to the pure holding-beat decision.
    const projectAny = this.config.project as {
      scenes?: Array<{
        sceneNumber?: number;
        shots?: Array<{
          shotNumber?: number;
          needsLfAnchor?: boolean;
          incomingTransition?: { operation?: string };
        }>;
      }>;
      features?: { skipHoldingBeatLF?: boolean; transitionBoundaryPlanner?: boolean };
    } | undefined;
    const sceneShots = projectAny?.scenes?.find((s) => s.sceneNumber === sceneNumber)?.shots;
    const thisShotPlanned = sceneShots?.find((s) => s.shotNumber === shotNumber);
    const nextShotPlanned = sceneShots?.find((s) => s.shotNumber === shotNumber + 1);
    const nextIncoming = nextShotPlanned?.incomingTransition?.operation
      ? { operation: nextShotPlanned.incomingTransition.operation }
      : undefined;

    const skip = shouldSkipLastFrame(
      {
        purpose,
        cameraWork,
        needsLfAnchor: thisShotPlanned?.needsLfAnchor,
        nextShotIncomingTransition: nextIncoming,
      },
      projectAny,
    );
    if (!skip) return null;
    const mutated = stripLastFrameFromShotImagePromptJson(content);
    if (mutated) {
      // If skip fired while the next shot's incoming operation IS a
      // consumer (shared_frame / reuse_intent), shouldSkipLastFrame
      // has a bug — surface it. For non-consumer ops or no next shot,
      // skip is the right call; log them as informational.
      const consumerOp = nextIncoming?.operation;
      const isConsumer = consumerOp === 'shared_frame' || consumerOp === 'reuse_intent';
      const note = isConsumer
        ? ` (BUG: next shot incoming=${consumerOp} is a consumer — shouldSkipLastFrame should have returned false)`
        : nextIncoming
          ? ` (next shot incoming=${consumerOp} — no consumer, skip is correct)`
          : '';
      this.log(
        `  [shot_image_prompt holding-beat] skip-LF: ${node.itemId} (purpose=${purpose}) → i2v${note}`,
      );
    }
    return mutated;
  }

  private parseSceneBreakdown(
    sceneId: string,
    options?: {
      sceneVideoPromptNode?: ExecutionNode;
      sceneVideoPromptOutputPath?: string;
      content?: string;
    }
  ): ParsedSceneBreakdown | { sceneId: string; outputPath?: string; failureReason: string } {
    const resolvedOutputPath = this.resolveSceneVideoPromptOutputPath(
      sceneId,
      options?.sceneVideoPromptNode,
      options?.sceneVideoPromptOutputPath,
    );

    let rawContent = options?.content;
    if (!rawContent) {
      if (!resolvedOutputPath) {
        return { sceneId, outputPath: resolvedOutputPath, failureReason: 'scene_json_unavailable' };
      }
      const fullPath = join(this.config.projectDir, resolvedOutputPath);
      if (!existsSync(fullPath)) {
        return { sceneId, outputPath: resolvedOutputPath, failureReason: 'scene_json_missing_on_disk' };
      }
      rawContent = readFileSync(fullPath, 'utf-8');
    }

    let normalized = rawContent.trim();
    if (normalized.startsWith('```')) {
      normalized = normalized.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized);
    } catch (error) {
      return {
        sceneId,
        outputPath: resolvedOutputPath,
        failureReason: `scene_json_parse_error:${String(error)}`,
      };
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { shots?: unknown[] }).shots)) {
      return { sceneId, outputPath: resolvedOutputPath, failureReason: 'scene_json_missing_shots' };
    }

    const rawShots = (parsed as { shots: Array<{
      shotNumber?: number;
      shotType?: string;
      duration?: number;
      prompt?: string;
      imagePrompt?: string;
      transition?: string;
    }> }).shots;

    const sceneLabel = sceneId.replace('scene_', 'S');
    const shots: ParsedSceneBreakdownShot[] = rawShots.flatMap((shot, index) => {
      if (typeof shot.shotNumber !== 'number' || !Number.isFinite(shot.shotNumber)) {
        return [];
      }
      const shotType = shot.shotType ?? `shot_${shot.shotNumber}`;
      return [{
        shotNumber: shot.shotNumber,
        shotType,
        duration: shot.duration || 5,
        label: `Shot ${shot.shotNumber}: ${shotType}`,
        transition: shot.transition as import('../timeline/types.js').TransitionType | 'cut' | undefined,
        metadata: {
          shotNumber: shot.shotNumber,
          ...(shotType ? { shotType } : {}),
          ...(shot.prompt ? { prompt: shot.prompt } : {}),
          ...(shot.imagePrompt ? { imagePrompt: shot.imagePrompt } : {}),
          ...(shot.transition ? { transition: shot.transition } : {}),
          shotIndex: index,
        },
      }];
    });

    const shotItems = shots.map(shot => ({
      itemId: `${sceneId}_shot_${shot.shotNumber}`,
      name: `${sceneLabel} Shot ${shot.shotNumber}: ${shot.shotType}`,
    }));
    const shotDescriptors = shots.map(shot => ({
      label: shot.label,
      duration: shot.duration,
      metadata: shot.metadata,
    }));
    const expectedTimelineSegmentIds = shotItems.map(shot => shot.itemId);

    return {
      sceneId,
      outputPath: resolvedOutputPath,
      shots,
      shotItems,
      shotDescriptors,
      expectedTimelineSegmentIds,
    };
  }

  private getExpectedShotSegmentIds(
    sceneId: string,
    shotDescriptors: Array<{ metadata?: Record<string, unknown> }>
  ): string[] {
    return shotDescriptors
      .map(descriptor => descriptor.metadata?.['shotNumber'])
      .filter((shotNumber): shotNumber is number => typeof shotNumber === 'number' && Number.isFinite(shotNumber))
      .map(shotNumber => `${sceneId}_shot_${shotNumber}`);
  }

  private getSceneTimelineSegmentIds(sceneId: string): string[] {
    if (!this.timeline) return [];
    return this.timeline.segments
      .filter(s => s.id === sceneId || s.id.startsWith(`${sceneId}_shot_`))
      .map(s => s.id);
  }

  private timelineHasMaterializedScene(sceneId: string): boolean {
    return this.getSceneTimelineSegmentIds(sceneId).length > 0;
  }

  private applySceneShotTransitions(
    sceneId: string,
    promptNode?: ExecutionNode,
    sceneVideoPromptOutputPath?: string
  ): void {
    if (!this.timeline) return;

    const resolvedOutputPath = sceneVideoPromptOutputPath ?? promptNode?.outputPath;
    if (!resolvedOutputPath) return;

    const svpPath = join(this.config.projectDir, resolvedOutputPath);
    if (!existsSync(svpPath)) return;

    let svpContent = readFileSync(svpPath, 'utf-8').trim();
    if (svpContent.startsWith('```')) {
      svpContent = svpContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(svpContent);
    if (!Array.isArray(parsed.shots)) return;

    for (const shot of parsed.shots as Array<{ shotNumber: number; transition?: string }>) {
      if (!shot.transition || shot.transition === 'cut') continue;
      const transitionType = shot.transition as import('../timeline/types.js').TransitionType;
      const durationMs = ExecutorAgent.NON_CUT_TRANSITION_DURATIONS[transitionType] ?? 500;
      this.timeline = setSegmentTransition(this.timeline, `${sceneId}_shot_${shot.shotNumber}`, {
        type: transitionType,
        durationMs,
      });
    }
  }

  private expandSceneBreakdownGraph(parsed: ParsedSceneBreakdown): { graphSatisfied: boolean; expandedShotIds: string[] } {
    const sceneId = parsed.sceneId;
    const shotItems = parsed.shotItems;

    let shotPromptNode = this.executor.getNode(`shot_image_prompt:${sceneId}`);
    let motionDirectiveNode = this.executor.getNode(`shot_motion_directive:${sceneId}`);

    if (!shotPromptNode) {
      const typeLevelPrompt = this.executor.getNode('shot_image_prompt');
      if (typeLevelPrompt && typeLevelPrompt.isCollection) {
        this.log(`  Creating per-scene node shot_image_prompt:${sceneId} from type-level collection`);
        this.executor.expandCollection('shot_image_prompt', [{ itemId: sceneId, name: `Scene ${sceneId.replace('scene_', '')}` }]);
        shotPromptNode = this.executor.getNode(`shot_image_prompt:${sceneId}`);
      }
    }
    if (!motionDirectiveNode) {
      const typeLevelMotion = this.executor.getNode('shot_motion_directive');
      if (typeLevelMotion && typeLevelMotion.isCollection) {
        this.log(`  Creating per-scene node shot_motion_directive:${sceneId} from type-level collection`);
        this.executor.expandCollection('shot_motion_directive', [{ itemId: sceneId, name: `Scene ${sceneId.replace('scene_', '')}` }]);
        motionDirectiveNode = this.executor.getNode(`shot_motion_directive:${sceneId}`);
      }
    }

    if (shotPromptNode) {
      this.executor.expandCollection(`shot_image_prompt:${sceneId}`, shotItems);
    }
    if (motionDirectiveNode) {
      this.executor.expandCollection(`shot_motion_directive:${sceneId}`, shotItems);
    }

    let prevShotPromptId: string | null = null;
    for (const shot of shotItems) {
      const promptId = `shot_image_prompt:${shot.itemId}`;
      const promptNode = this.executor.getNode(promptId);
      if (promptNode && prevShotPromptId && !promptNode.dependencies.includes(prevShotPromptId)) {
        promptNode.dependencies.push(prevShotPromptId);
        const prevNode = this.executor.getNode(prevShotPromptId);
        if (prevNode && !prevNode.dependents.includes(promptId)) {
          prevNode.dependents.push(promptId);
        }
      }
      if (promptNode) prevShotPromptId = promptId;
    }

    const allCharImages = this.executor.getAllNodes()
      .filter(n => n.typeId === 'character_image' && n.itemId)
      .map(n => n.id);
    const allSettingImages = this.executor.getAllNodes()
      .filter(n => n.typeId === 'setting_image' && n.itemId)
      .map(n => n.id);

    let prevShotImageId: string | null = null;
    let prevShotVideoId: string | null = null;
    for (const shot of shotItems) {
      const shotPromptId = `shot_image_prompt:${shot.itemId}`;
      const motionId = `shot_motion_directive:${shot.itemId}`;
      const shotImageId = `shot_image:${shot.itemId}`;
      const shotVideoId = `shot_video:${shot.itemId}`;

      // Pattern B: emit BOTH shot_image (first_frame only) and
      // shot_image_last_frame (depends on shot_image). See
      // addShotImageNodes.ts for the rationale.
      addShotImageNodes({
        executor: this.executor,
        shot,
        allCharImageIds: allCharImages,
        allSettingImageIds: allSettingImages,
        prevShotImageId,
      });
      // Wire shot_video's dependency from the new last_frame node so
      // video gen waits for the actual last frame, not just the first.
      const lastFrameForVideo = `shot_image_last_frame:${shot.itemId}`;
      const lastFrameNode = this.executor.getNode(lastFrameForVideo);
      if (lastFrameNode && !lastFrameNode.dependents.includes(shotVideoId)) {
        lastFrameNode.dependents.push(shotVideoId);
      }

      if (!this.executor.getNode(shotVideoId)) {
        // Pattern B: shot_video waits on the last-frame node (which
        // transitively waits on first-frame). Passing
        // shotImageLastFrameId as the canonical "image dep" keeps the
        // sanitizeShotVideoDeps stripping logic correct — bare
        // `shot_image:` deps from legacy projects will be filtered out.
        const shotVideoDeps = canonicalShotVideoDeps({
          shotImageId: `shot_image_last_frame:${shot.itemId}`,
          motionId,
          prevShotVideoId,
          useV2V: this.config.project.useV2V === true,
        });
        this.executor.addNode({
          id: shotVideoId,
          typeId: 'shot_video',
          itemId: shot.itemId,
          status: 'pending',
          displayName: `Shot Videos: ${shot.name}`,
          isExpensive: true,
          isCollection: false,
          dependencies: shotVideoDeps,
          dependents: [],
        });
        for (const depId of shotVideoDeps) {
          const depNode = this.executor.getNode(depId);
          if (depNode && !depNode.dependents.includes(shotVideoId)) {
            depNode.dependents.push(shotVideoId);
          }
        }
      } else {
        // Defensive sanitize: the underlying expansion code occasionally
        // leaves shot_video with corrupted deps — most commonly ALL of
        // a scene's per-item motion directives instead of just this
        // shot's, AND the shot_image dep missing entirely. The selective
        // indexOf-replace approach used to live here but couldn't FIX
        // the corruption (only handled bare typeId refs). We rebuild
        // deps from the canonical triple and strip stray per-item refs
        // for shot_image / shot_motion_directive that don't match this
        // shot. Other deps are preserved.
        // See todos/shot-video-dep-expansion-bug.md for the deeper bug.
        const existing = this.executor.getNode(shotVideoId)!;
        const before = existing.dependencies.slice();
        existing.dependencies = sanitizeShotVideoDeps({
          existingDeps: before,
          // Pattern B: shot_video's image dep is the last-frame node.
          shotImageId: `shot_image_last_frame:${shot.itemId}`,
          motionId,
          prevShotVideoId,
          useV2V: this.config.project.useV2V === true,
        });
        // Wire reverse edges on any newly-added canonical deps.
        for (const depId of existing.dependencies) {
          const depNode = this.executor.getNode(depId);
          if (depNode && !depNode.dependents.includes(shotVideoId)) {
            depNode.dependents.push(shotVideoId);
          }
        }
        // Drop reverse edges that the sanitize just removed. Without
        // this, the previous-shot's `dependents` still lists this
        // shot_video — and DependencyGraphExecutor.invalidateNode walks
        // dependents during cascade. Stripping the dep alone is half
        // the fix.
        const after = new Set(existing.dependencies);
        for (const depId of before) {
          if (after.has(depId)) continue;
          const depNode = this.executor.getNode(depId);
          if (!depNode) continue;
          depNode.dependents = depNode.dependents.filter((d) => d !== shotVideoId);
        }
        if (JSON.stringify(before) !== JSON.stringify(existing.dependencies)) {
          this.log(`  Sanitized ${shotVideoId} deps: [${before.join(',')}] → [${existing.dependencies.join(',')}]`);
        }
      }

      const finalNode = this.executor.getNode('final_video');
      if (finalNode && !finalNode.dependencies.includes(shotVideoId)) {
        finalNode.dependencies.push(shotVideoId);
      }

      prevShotImageId = shotImageId;
      prevShotVideoId = shotVideoId;
    }

    // Reap orphan scene-level `shot_image_last_frame:scene_N` placeholder.
    //
    // Background: somewhere upstream (likely during the first
    // per-stage default-graph build, BEFORE scene_video_prompt
    // parsing knows the shot list), a SCENE-level
    // `shot_image_last_frame:${sceneId}` node gets created with
    // dependents pointing at the (then collection-level) shot_video.
    // After per-shot expansion runs and creates the canonical
    // `shot_image_last_frame:${sceneId}_shot_N` nodes, the scene-
    // level node is now stale: it references `shot_image:${sceneId}`
    // (which no longer exists — the collection placeholder got
    // replaced by per-shot children), and at execution time
    // `executeShotImageLastFrame` fails with
    // "shot_image:${sceneId} not found upstream", which then
    // cascades to block every shot_video.
    //
    // The cleanup: when the per-shot LF nodes exist, delete the
    // orphan scene-level one and migrate any of its dependents to
    // the per-shot LF nodes (they probably already have per-shot
    // refs as well — we just drop the scene-level dep).
    const scenePerShotLF = `shot_image_last_frame:${sceneId}`;
    const orphan = this.executor.getNode(scenePerShotLF);
    if (orphan && shotItems.length > 0) {
      const anyPerShotLFExists = shotItems.some((shot) =>
        Boolean(this.executor.getNode(`shot_image_last_frame:${shot.itemId}`)),
      );
      if (anyPerShotLFExists) {
        for (const depId of orphan.dependents ?? []) {
          const dependent = this.executor.getNode(depId);
          if (!dependent) continue;
          dependent.dependencies = dependent.dependencies.filter(
            (d) => d !== scenePerShotLF,
          );
        }
        for (const depId of orphan.dependencies ?? []) {
          const upstream = this.executor.getNode(depId);
          if (!upstream) continue;
          upstream.dependents = (upstream.dependents ?? []).filter(
            (d) => d !== scenePerShotLF,
          );
        }
        this.executor.removeNode?.(scenePerShotLF) ??
          this.removeNodeFallback(scenePerShotLF);
        this.log(
          `  [graph hygiene] Reaped orphan scene-level node ${scenePerShotLF} (per-shot LFs exist; dependents migrated)`,
        );
      }
    }

    const graphSatisfied = shotItems.every(shot =>
      ['shot_image_prompt', 'shot_motion_directive', 'shot_image', 'shot_video']
        .filter(typeId => this.executor.getNode(typeId) || this.executor.getNode(`${typeId}:${sceneId}`) || this.config.template.artifactTypes[typeId])
        .every(typeId => Boolean(this.executor.getNode(`${typeId}:${shot.itemId}`)))
    );

    return {
      graphSatisfied,
      expandedShotIds: shotItems.map(shot => shot.itemId),
    };
  }

  /**
   * Fallback removeNode when DependencyGraphExecutor doesn't expose
   * one directly — reaches into the internal nodes Map. Keeps the
   * orphan-cleanup code working regardless of executor version.
   */
  private removeNodeFallback(nodeId: string): void {
    const nodes = (this.executor as unknown as { nodes?: Map<string, ExecutionNode> }).nodes;
    if (nodes && nodes.has(nodeId)) {
      nodes.delete(nodeId);
    }
  }

  private materializeSceneBreakdown(
    sceneId: string,
    options?: {
      sceneVideoPromptNode?: ExecutionNode;
      sceneVideoPromptOutputPath?: string;
      content?: string;
      repair?: boolean;
      emitNotifications?: boolean;
    }
  ): SceneMaterializationResult {
    const parsed = this.parseSceneBreakdown(sceneId, options);
    if (!('shots' in parsed)) {
      return {
        sceneId,
        shotCount: 0,
        shotItems: [],
        expectedTimelineSegmentIds: [],
        actualTimelineSegmentIds: this.getSceneTimelineSegmentIds(sceneId),
        graphSatisfied: false,
        timelineSatisfied: false,
        success: false,
        failureReason: parsed.failureReason,
        outputPath: parsed.outputPath,
      };
    }

    const attemptMaterialization = (attemptOptions?: { reloadTimeline?: boolean; reinitializeTimeline?: boolean }): SceneMaterializationResult => {
      if (attemptOptions?.reloadTimeline) {
        this.timeline = loadTimeline(this.config.projectDir);
      }

      const hasMaterializedScene = this.timelineHasMaterializedScene(sceneId);
      if (attemptOptions?.reinitializeTimeline || (!this.timeline && !hasMaterializedScene)) {
        this.initializeTimelineFromScenes();
      } else {
        this.ensureTimelineInitialized();
      }

      const { graphSatisfied } = this.expandSceneBreakdownGraph(parsed);

      if (!this.timeline) {
        return {
          sceneId,
          shotCount: parsed.shots.length,
          shotItems: parsed.shotItems,
          expectedTimelineSegmentIds: parsed.expectedTimelineSegmentIds,
          actualTimelineSegmentIds: [],
          graphSatisfied,
          timelineSatisfied: false,
          success: false,
          failureReason: 'timeline_unavailable',
          outputPath: parsed.outputPath,
        };
      }

      try {
        const upserted = upsertSceneShots(this.timeline, sceneId, parsed.shotDescriptors);
        this.timeline = upserted.timeline;
        this.applySceneShotTransitions(sceneId, options?.sceneVideoPromptNode, parsed.outputPath);
        saveTimeline(this.config.projectDir, this.timeline);
        this.emitTimelineUpdate();
      } catch (error) {
        return {
          sceneId,
          shotCount: parsed.shots.length,
          shotItems: parsed.shotItems,
          expectedTimelineSegmentIds: parsed.expectedTimelineSegmentIds,
          actualTimelineSegmentIds: this.getSceneTimelineSegmentIds(sceneId),
          graphSatisfied,
          timelineSatisfied: false,
          success: false,
          failureReason: `timeline_update_error:${String(error)}`,
          outputPath: parsed.outputPath,
        };
      }

      const actualTimelineSegmentIds = this.getSceneTimelineSegmentIds(sceneId);
      // Post-condition: timeline shot segments for this scene must be the
      // EXACT set the new plan expects — not a superset. The original
      // check only required every expected ID to be present, which let
      // orphan segments from a prior larger plan survive (the 2026-05-19
      // bug: Stage A re-planned 8 → 4, timeline kept all 8, final video
      // stitched the orphans). Asserting exact-set match catches any
      // future drift at the source instead of in the final assembly.
      const expectedSet = new Set(parsed.expectedTimelineSegmentIds);
      const orphanSegmentIds = actualTimelineSegmentIds.filter(id => !expectedSet.has(id));
      const missingSegmentIds = parsed.expectedTimelineSegmentIds.filter(
        id => !actualTimelineSegmentIds.includes(id),
      );
      const timelineSatisfied =
        missingSegmentIds.length === 0
        && orphanSegmentIds.length === 0
        && !actualTimelineSegmentIds.includes(sceneId);
      return {
        sceneId,
        shotCount: parsed.shots.length,
        shotItems: parsed.shotItems,
        expectedTimelineSegmentIds: parsed.expectedTimelineSegmentIds,
        actualTimelineSegmentIds,
        graphSatisfied,
        timelineSatisfied,
        success: graphSatisfied && timelineSatisfied,
        failureReason: graphSatisfied
          ? (timelineSatisfied
              ? undefined
              : `timeline_postcondition_failed:missing=${missingSegmentIds.join(',') || '-'} orphans=${orphanSegmentIds.join(',') || '-'}`)
          : 'graph_postcondition_failed',
        outputPath: parsed.outputPath,
      };
    };

    let result = attemptMaterialization();
    if (!result.success && options?.repair !== false) {
      this.log(
        `Scene materialization failed for ${sceneId} (attempt 1): ` +
        `reason=${result.failureReason ?? 'unknown'} expected=[${result.expectedTimelineSegmentIds.join(', ')}] ` +
        `actual=[${result.actualTimelineSegmentIds.join(', ')}]`
      );
      result = attemptMaterialization({
        reloadTimeline: true,
        reinitializeTimeline: !this.timelineCoversCurrentScenes() || !this.timelineHasMaterializedScene(sceneId),
      });
    }

    if (options?.emitNotifications && result.shotItems.length > 0) {
      this.emit({
        type: 'notification',
        level: result.success ? 'info' : 'error',
        message: result.success
          ? `Expanded shots for ${sceneId}: ${result.shotItems.map(i => i.name).join(', ')}`
          : `Scene materialization failed for ${sceneId}: ${result.failureReason ?? 'unknown'}`,
      });
    }

    return result;
  }

  private ensureSceneShotSegments(
    sceneId: string,
    sceneVideoPromptNode?: ExecutionNode,
    options?: { reloadTimeline?: boolean; reinitializeTimeline?: boolean; sceneVideoPromptOutputPath?: string }
  ): {
    sceneId: string;
    extractedShotCount: number;
    expectedSegmentIds: string[];
    actualSegmentIds: string[];
    rewriteAttempted: boolean;
    success: boolean;
    failureReason?: string;
  } {
    const result = this.materializeSceneBreakdown(sceneId, {
      sceneVideoPromptNode,
      sceneVideoPromptOutputPath: options?.sceneVideoPromptOutputPath,
      repair: false,
    });
    return {
      sceneId,
      extractedShotCount: result.shotCount,
      expectedSegmentIds: result.expectedTimelineSegmentIds,
      actualSegmentIds: result.actualTimelineSegmentIds,
      rewriteAttempted: result.shotCount > 0,
      success: result.timelineSatisfied,
      failureReason: result.failureReason,
    };
  }

  private ensureSceneShotSegmentsStrict(
    sceneId: string,
    sceneVideoPromptNode?: ExecutionNode,
    sceneVideoPromptOutputPath?: string
  ): void {
    const result = this.materializeSceneBreakdown(sceneId, {
      sceneVideoPromptNode,
      sceneVideoPromptOutputPath,
      emitNotifications: false,
    });
    if (result.success) {
      this.log(`Timeline sync OK for ${sceneId}: expected=${result.expectedTimelineSegmentIds.join(', ')} actual=${result.actualTimelineSegmentIds.join(', ')}`);
      return;
    }

    const message =
      `Timeline sync failed for ${sceneId}: ` +
      `reason=${result.failureReason ?? 'unknown'} ` +
      `expected=[${result.expectedTimelineSegmentIds.join(', ')}] actual=[${result.actualTimelineSegmentIds.join(', ')}]`;
    this.log(message);
    this.emit({
      type: 'notification',
      level: 'error',
      message,
    });
    throw new Error(message);
  }

  /**
   * Prune per-shot graph children whose shotNumber is no longer in the
   * scene's `scene_shot_plan` output. Returns `true` if any node was
   * removed so the caller can re-run dependent passes.
   *
   * Pure decision logic (which shots are stale) lives in
   * `reconcileShotPlan.ts`; this method does the file read and graph
   * mutation. The set of per-shot types we remove is the full chain
   * (`shot_breakdown` through `shot_video`) — leaving a downstream
   * orphan would tie the assembler in knots, the same way the bug
   * this fixes did.
   *
   * Plans that GROW (new shotNumbers that aren't in the graph yet)
   * are detected too, but only logged for now — the executor's
   * existing "spawn missing per-shot chain" path requires the parent
   * collection node, which doesn't exist after the first expansion.
   * Emit a notification so the user can redo from "Scene breakdowns"
   * (one step deeper) to force a fresh expansion if needed.
   */
  private reconcilePerShotChildrenForScene(
    planNode: ExecutionNode,
    sceneId: string,
  ): boolean {
    if (!planNode.outputPath) return false;
    let planJson: unknown;
    try {
      const fullPath = join(this.config.projectDir, planNode.outputPath);
      let content = readFileSync(fullPath, 'utf-8').trim();
      if (content.startsWith('```')) {
        content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      planJson = JSON.parse(content);
    } catch {
      // Plan unreadable / malformed — leave the graph alone. The
      // normal expand path will report the error when it tries.
      return false;
    }
    const planShotNums = planShotNumbersFromJson(planJson);
    if (planShotNums.size === 0) return false;

    const childPrefix = `${sceneId}_shot_`;
    const graphShotNums = new Set<number>();
    for (const candidate of this.executor.getAllNodes()) {
      if (candidate.typeId !== 'shot_breakdown') continue;
      if (!candidate.itemId?.startsWith(childPrefix)) continue;
      const m = candidate.itemId.match(/_shot_(\d+)$/);
      if (!m || !m[1]) continue;
      graphShotNums.add(parseInt(m[1], 10));
    }
    if (graphShotNums.size === 0) {
      // No per-shot children yet; the regular expansion path will
      // create them. Nothing to reconcile.
      return false;
    }

    const diff = diffShotPlanAgainstGraph(planShotNums, graphShotNums);
    if (diff.stale.length === 0 && diff.missing.length === 0) {
      return false;
    }

    let mutated = false;
    for (const shotNum of diff.stale) {
      const removedIds: string[] = [];
      for (const nodeId of perShotNodeIds(sceneId, shotNum)) {
        if (this.executor.removeNode(nodeId)) removedIds.push(nodeId);
      }
      if (removedIds.length > 0) {
        mutated = true;
        this.log(
          `  Pruned ${removedIds.length} stale per-shot node(s) for ${sceneId} shot ${shotNum} (not in updated plan): ${removedIds.join(', ')}`,
        );
        this.emit({
          type: 'notification',
          level: 'info',
          message: `Pruned shot ${shotNum} of ${sceneId} — the updated plan no longer includes it.`,
        });
      }
    }

    if (diff.missing.length > 0) {
      // Plan grew — the new plan introduces shotNumbers that have no
      // per-shot graph chain yet. Spawn each missing shot's full chain
      // (shot_breakdown, motion, image_prompt, image, last_frame,
      // video) and wire it into the scene's existing parents. Then
      // reset scene_video_prompt:scene_N to pending so the assembler
      // re-runs once the new shot_breakdown nodes complete.
      const planShotPlan = (planJson as { shotPlan?: Array<{ shotNumber?: number; oneLineSummary?: string }> }).shotPlan ?? [];
      let spawnedAny = false;
      for (const shotNum of diff.missing) {
        const entry = planShotPlan.find((p) => p?.shotNumber === shotNum);
        const summary = typeof entry?.oneLineSummary === 'string'
          ? entry.oneLineSummary.substring(0, 60)
          : `shot ${shotNum}`;
        const added = this.spawnMissingPerShotChain(sceneId, shotNum, summary);
        if (added.length > 0) {
          spawnedAny = true;
          mutated = true;
          this.log(
            `  Spawned per-shot chain for ${sceneId} shot ${shotNum}: ${added.join(', ')}`,
          );
          this.emit({
            type: 'notification',
            level: 'info',
            message: `Spawned shot ${shotNum} of ${sceneId} — the updated plan added it.`,
          });
        }
      }
      // The assembler likely failed because of the missing shots
      // (status='failed' after exhausting retries). Reset it back to
      // pending so the executor schedules a fresh assembly once the
      // new shot_breakdown deps complete. Mirror the same flip on
      // scene_shot_plan's downstream cascade so anything else that
      // looked at the failed state can recover too.
      if (spawnedAny) {
        const svp = this.executor.getNode(`scene_video_prompt:${sceneId}`);
        if (svp && (svp.status === 'failed' || svp.status === 'skipped')) {
          svp.status = 'pending';
          this.log(`  Reset ${svp.id} from ${svp.status} to pending so the assembler retries with new shot deps`);
        }
      }
    }

    return mutated;
  }

  /**
   * Build the full per-shot graph chain for ONE shot (six nodes:
   * shot_breakdown, shot_motion_directive, shot_image_prompt,
   * shot_image, shot_image_last_frame, shot_video). Wires deps both
   * directions. Skips any node that already exists (idempotent).
   *
   * Used by `reconcilePerShotChildrenForScene` when the updated plan
   * introduces a shotNumber that has no graph chain yet — after the
   * first per-scene expansion, the parent collection nodes are gone
   * and there's no longer a single seam where the executor would
   * spawn them. This is that seam.
   *
   * Mirrors the inline chain-creation in `expandPendingCollections`
   * (~line 4209), reusing the same `addShotImageNodes` helper for the
   * image-pair so anchor logic stays in one place.
   *
   * Returns the ids of the nodes actually added (in spawn order).
   */
  private spawnMissingPerShotChain(
    sceneId: string,
    shotNumber: number,
    shotName: string,
  ): string[] {
    const itemId = `${sceneId}_shot_${shotNumber}`;
    const added: string[] = [];

    const wireUpstream = (childId: string, parentIds: string[]) => {
      for (const parentId of parentIds) {
        const parent = this.executor.getNode(parentId);
        if (parent && !parent.dependents.includes(childId)) {
          parent.dependents.push(childId);
        }
      }
    };

    // 1. shot_breakdown (Stage B LLM call) — deps from template.
    const shotBreakdownId = `shot_breakdown:${itemId}`;
    if (!this.executor.getNode(shotBreakdownId)) {
      const deps = [`scene_shot_plan:${sceneId}`, 'world_style'];
      this.executor.addNode({
        id: shotBreakdownId,
        typeId: 'shot_breakdown',
        itemId,
        status: 'pending',
        displayName: `Shot Breakdown: ${shotName}`,
        isExpensive: false,
        isCollection: false,
        dependencies: deps,
        dependents: [],
      });
      wireUpstream(shotBreakdownId, deps);
      added.push(shotBreakdownId);
    }

    // 2. shot_motion_directive — depends on shot_breakdown.
    const motionId = `shot_motion_directive:${itemId}`;
    if (!this.executor.getNode(motionId)) {
      const deps = [shotBreakdownId];
      this.executor.addNode({
        id: motionId,
        typeId: 'shot_motion_directive',
        itemId,
        status: 'pending',
        displayName: `Shot Motion: ${shotName}`,
        isExpensive: false,
        isCollection: false,
        dependencies: deps,
        dependents: [],
      });
      wireUpstream(motionId, deps);
      added.push(motionId);
    }

    // 3. shot_image_prompt — depends on scene_video_prompt + world_style
    //    only. Reference images (character_image, setting_image) are
    //    resolved by refId at ComfyUI generation time, NOT at prompt
    //    generation time — see narrative.ts shotImagePromptArtifact
    //    deps for the canonical wiring. Including character/setting
    //    image deps here was wrong and produced a serial-mode deadlock:
    //    shot_image_prompt is `content`, character/setting images are
    //    `visual_ref` (media), so the executor's "content first, then
    //    media" gate refuses to start the media until content drains —
    //    but content was waiting on media → no-progress.
    const shotImagePromptId = `shot_image_prompt:${itemId}`;
    if (!this.executor.getNode(shotImagePromptId)) {
      const deps = [
        `scene_video_prompt:${sceneId}`,
        'world_style',
      ];
      this.executor.addNode({
        id: shotImagePromptId,
        typeId: 'shot_image_prompt',
        itemId,
        status: 'pending',
        displayName: `Shot Composition: ${shotName}`,
        isExpensive: false,
        isCollection: false,
        dependencies: deps,
        dependents: [],
      });
      wireUpstream(shotImagePromptId, deps);
      added.push(shotImagePromptId);
    }

    // 4 + 5. shot_image + shot_image_last_frame via the shared helper
    //   (handles firstFrameAnchor → prior-frame dep). We don't know
    //   the anchor yet (assembler stamps it later), so pass null —
    //   the helper falls back to chaining on the previous shot's
    //   first frame when present.
    const shotImageId = `shot_image:${itemId}`;
    if (!this.executor.getNode(shotImageId)) {
      const allCharImageIds = this.executor.getAllNodes()
        .filter((n) => n.typeId === 'character_image' && n.itemId)
        .map((n) => n.id);
      const allSettingImageIds = this.executor.getAllNodes()
        .filter((n) => n.typeId === 'setting_image' && n.itemId)
        .map((n) => n.id);
      let prevShotImageId: string | null = null;
      for (let prev = shotNumber - 1; prev >= 1; prev -= 1) {
        const candidate = `shot_image:${sceneId}_shot_${prev}`;
        if (this.executor.getNode(candidate)) {
          prevShotImageId = candidate;
          break;
        }
      }
      addShotImageNodes({
        executor: this.executor,
        shot: { itemId, name: shotName },
        allCharImageIds,
        allSettingImageIds,
        prevShotImageId,
        firstFrameAnchor: null,
        sceneId,
      });
      added.push(shotImageId, `shot_image_last_frame:${itemId}`);
    }

    // 6. shot_video — depends on shot_image_last_frame + motion.
    //    Skip the V2V prev-shot edge: it's only added on initial
    //    expansion when useV2V is on; reconstructing it here without
    //    re-running the whole scene's chain risks cascade-invalidating
    //    sibling shots. The user can re-run the scene to pick up
    //    full V2V chaining if they want it.
    const shotVideoId = `shot_video:${itemId}`;
    if (!this.executor.getNode(shotVideoId)) {
      const deps = [`shot_image_last_frame:${itemId}`, motionId];
      this.executor.addNode({
        id: shotVideoId,
        typeId: 'shot_video',
        itemId,
        status: 'pending',
        displayName: `Shot Videos: ${shotName}`,
        isExpensive: true,
        isCollection: false,
        dependencies: deps,
        dependents: [],
      });
      wireUpstream(shotVideoId, deps);
      added.push(shotVideoId);
    }

    // Wire the new shot_breakdown into scene_video_prompt's deps so
    // the assembler waits on it. (scene_video_prompt is a single
    // per-scene node — it aggregates ALL shot_breakdowns for the
    // scene.) Skip if already wired.
    const svp = this.executor.getNode(`scene_video_prompt:${sceneId}`);
    if (svp && !svp.dependencies.includes(shotBreakdownId)) {
      svp.dependencies.push(shotBreakdownId);
      const sb = this.executor.getNode(shotBreakdownId);
      if (sb && !sb.dependents.includes(svp.id)) sb.dependents.push(svp.id);
    }

    return added;
  }

  private reconcileCompletedSceneTimelineSegments(): void {
    const completedScenePrompts = this.executor.getAllNodes()
      .filter(n => n.typeId === 'scene_video_prompt' && n.itemId && n.status === 'completed');

    for (const node of completedScenePrompts) {
      try {
        const result = this.materializeSceneBreakdown(node.itemId!, {
          sceneVideoPromptNode: node,
          emitNotifications: false,
        });
        if (!result.success && result.shotCount > 0) {
          this.log(`Timeline reconcile failed for ${node.itemId}: expected=[${result.expectedTimelineSegmentIds.join(', ')}] actual=[${result.actualTimelineSegmentIds.join(', ')}] reason=${result.failureReason ?? 'unknown'}`);
          throw new Error(`Scene reconciliation failed for ${node.itemId}: ${result.failureReason ?? 'unknown'}`);
        }
      } catch (error) {
        this.log(`Timeline reconcile failed for ${node.itemId}: ${String(error)}`);
        throw error;
      }
    }
  }

  private updateTimelineForShotVideo(node: ExecutionNode, outputPath: string): void {
    if (!this.timeline || !node.itemId) return;

    const segmentId = node.itemId; // e.g., "scene_1_shot_2"
    let segment = this.timeline.segments.find(s => s.id === segmentId);
    if (!segment) {
      const sceneIdMatch = segmentId.match(/^(scene_\d+)_shot_\d+$/);
      if (sceneIdMatch?.[1]) {
        this.log(`Timeline: missing ${segmentId}, attempting repair from ${sceneIdMatch[1]}`);
        this.ensureSceneShotSegmentsStrict(sceneIdMatch[1]);
        segment = this.timeline?.segments.find(s => s.id === segmentId);
      }
    }
    if (!segment) {
      this.log(`Timeline: no segment found for ${segmentId}`);
      return;
    }

    const layer: TimelineLayerEntry = {
      type: 'visual',
      filePath: outputPath,
      label: node.displayName,
      source: 'generated',
    };

    this.timeline = updateSegmentLayers(this.timeline, segmentId, [layer], 'filled');
    saveTimeline(this.config.projectDir, this.timeline);
    this.emitTimelineUpdate();
    this.log(`Timeline: updated segment ${segmentId} → filled`);
  }

  private updateTimelineForShotImage(node: ExecutionNode, outputPath: string): void {
    if (!this.timeline || !node.itemId) return;

    const segmentId = node.itemId; // e.g., "scene_1_shot_2"
    let segment = this.timeline.segments.find(s => s.id === segmentId);
    if (!segment) {
      const sceneIdMatch = segmentId.match(/^(scene_\d+)_shot_\d+$/);
      if (sceneIdMatch?.[1]) {
        this.log(`Timeline: missing ${segmentId}, attempting repair from ${sceneIdMatch[1]}`);
        this.ensureSceneShotSegmentsStrict(sceneIdMatch[1]);
        segment = this.timeline?.segments.find(s => s.id === segmentId);
      }
    }
    if (!segment) {
      this.log(`Timeline: no segment found for ${segmentId}`);
      return;
    }

    const existingVisualLayer = segment.layers.find(
      layer => layer.type === 'visual' || layer.type === 'narration_video'
    );
    const existingFilePath = existingVisualLayer?.filePath?.toLowerCase() ?? '';
    if (/\.(mp4|mov|webm|m4v|avi|mkv)$/.test(existingFilePath)) {
      this.log(`Timeline: preserving existing video for ${segmentId} during shot image update`);
      return;
    }

    const layer: TimelineLayerEntry = {
      type: 'visual',
      filePath: outputPath,
      label: node.displayName,
      source: 'generated',
    };

    this.timeline = updateSegmentLayers(this.timeline, segmentId, [layer], 'planned');
    saveTimeline(this.config.projectDir, this.timeline);
    this.emitTimelineUpdate();
    this.log(`Timeline: updated segment ${segmentId} → planned preview`);
  }

  /**
   * Run the dependency graph execution loop.
   *
   * This is the main entry point, matching GenericAgent.run() signature.
   * The `task` parameter is used for initial goal understanding only;
   * actual execution is driven by the graph.
   */
  async run(_task: string, _userResponse?: string): Promise<GenericAgentResult> {
    // Handle /reset command: run the in-process reset, reload state, then
    // continue execution. Was previously a subprocess shell-out to
    // `npx tsx scripts/reset-project.ts`, which only works in dev. Now
    // calls `resetProjectStage` directly so the path is identical in
    // packaged builds.
    const resetMatch = _task.match(/^\/reset\s+(\S+)\s+(\S+)/);
    if (resetMatch) {
      const [, projectName, stage] = resetMatch;
      this.log(`Handling /reset: project=${projectName}, stage=${stage}`);
      try {
        const { resetProjectStage } = await import('../../server/runners/resetProjectStage.js');
        const projectRoot = dirname(this.config.projectDir); // parent of .dhee dir
        const logLines: string[] = [];
        const result = resetProjectStage({
          basePath: projectRoot,
          projectName: projectName!,
          stage: stage!,
          onLog: (line) => logLines.push(line),
        });
        const output =
          `Reset ${result.resetCount} type-level + ${result.removedCount} per-item + ${result.schemaCleared} schema slot(s)\n` +
          logLines.join('\n');
        this.log(`Reset output:\n${output}`);

        // Reload project.json and executor state
        const projectPath = join(this.config.projectDir, 'project.json');
        if (existsSync(projectPath)) {
          const project = JSON.parse(readFileSync(projectPath, 'utf-8'));
          this.config.project = project;
          if (project.executorState) {
            this.executor = DependencyGraphExecutor.fromState(project.executorState, this.config.template);
            // Re-wire the persistence callback on the freshly rebuilt
            // executor — `fromState` returns a new instance.
            this.executor.setOnMutation(() => this.persistState());
          }
        }
        // Reload timeline
        this.timeline = loadTimeline(this.config.projectDir);

        this.emit({
          type: 'notification',
          level: 'info',
          message: `Reset to stage "${stage}" complete. Resuming execution...`,
        });
        // Fall through to normal execution with the reset state
      } catch (error) {
        this.log(`Reset failed: ${String(error)}`);
        this.emit({
          type: 'notification',
          level: 'error',
          message: `Reset failed: ${String(error)}`,
        });
        return { status: 'error', output: `Reset failed: ${String(error)}`, todos: [] };
      }
    }

    if (this.running) {
      this.log(`CONCURRENT RUN BLOCKED — run() called while already running`);
      this.log(`  Caller stack: ${new Error().stack?.split('\n').slice(1, 4).join(' <- ')}`);
      return { status: 'completed', output: 'Already running', todos: [] };
    }

    // Acquire project-level lock to prevent concurrent executor instances
    if (!this.acquireProjectLock()) {
      this.log(`CONCURRENT INSTANCE BLOCKED — another executor is running on this project`);
      return { status: 'completed', output: 'Another executor is already running on this project', todos: [] };
    }

    this.running = true;
    this.stopped = false;
    // Fresh AbortController per run — discard any aborted signal from
    // a prior cancelled run so LLM calls in this run aren't aborted
    // before they start.
    this.runAbortController = new AbortController();

    // Bug 16 / Bug 17: auto-recover from prior abort-induced failures.
    // A user Stop click or a desktop process restart leaves nodes in
    // `status='failed'` with abort-flavored errors. On the next run,
    // those should resume cleanly rather than requiring manual
    // invalidation. Real (non-abort) failures are left alone.
    const recovered = this.executor.resetAbortedNodes();
    if (recovered.length > 0) {
      this.log(`Auto-recovered ${recovered.length} abort-failed nodes: ${recovered.join(', ')}`);
    }

    // Load existing timeline from disk (survives session resume / server restart)
    if (!this.timeline) {
      this.timeline = loadTimeline(this.config.projectDir);
      if (this.timeline) {
        this.emitTimelineUpdate();
      }
    }
    this.ensureTimelineInitialized();
    this.reconcileCompletedSceneTimelineSegments();

    const agentName = this.config.name ?? 'dhee-executor';

    this.log('=== Execution started ===');
    this.log(`Nodes: ${this.executor.getAllNodes().map(n => n.id).join(', ')}`);

    try {
      this.emit({ type: 'agent_status', status: 'thinking', agentName });

      // Validate completed nodes — reset any whose output files are missing
      // (happens when a reset deletes files but doesn't cascade to all nodes)
      for (const node of this.executor.getAllNodes()) {
        if (node.status === 'completed' && node.outputPath) {
          const fullPath = join(this.config.projectDir, node.outputPath);
          if (!existsSync(fullPath)) {
            this.log(`  Output file missing for completed node ${node.id}: ${node.outputPath} — resetting to pending`);
            node.status = 'pending';
            node.outputPath = undefined;
            node.completedAt = undefined;
          }
        }
      }

      // Fix stale type-level dependencies on per-item nodes.
      // expandCollection can create per-item nodes that inherit parent's deps
      // (type-level shot_motion_directive instead of per-item shot_motion_directive:scene_1_shot_N).
      let totalRewired = 0;
      for (const node of this.executor.getAllNodes()) {
        if (!node.itemId) continue;
        const fixedDeps: string[] = [];
        let rewired = false;
        for (const depId of node.dependencies) {
          // If dep has no colon (type-level) and a per-item version exists, rewire
          if (!depId.includes(':') && node.itemId) {
            const perItemId = `${depId}:${node.itemId}`;
            if (this.executor.getNode(perItemId)) {
              fixedDeps.push(perItemId);
              totalRewired++;
              rewired = true;
              continue;
            }
          }
          fixedDeps.push(depId);
        }
        if (rewired) node.dependencies = fixedDeps;
      }
      if (totalRewired > 0) {
        this.log(`  Rewired ${totalRewired} stale type-level deps → per-item`);
        this.persistState();
      }

      // Handle input type — if user provided a full story, skip plot and story stages
      // and use the original input directly as the story artifact.
      //
      // IMPORTANT: the file copy and graph-marking are decoupled. The
      // BackwardPlanner sometimes subtracts `story` from the graph when the
      // legacy `files` registry says it's already satisfied — but if the
      // canonical `chapters/chapter_1/plans/story.md` doesn't actually exist,
      // downstream Strategy C (LLM scene extraction) will fail and the
      // pipeline deadlocks. So we always ensure the canonical story file
      // exists when inputType === 'story', regardless of graph state.
      if (this.config.project.inputType === 'story') {
        const inputFile = join(this.config.projectDir, 'original_input.md');
        const storyDir = join(this.config.projectDir, 'chapters', 'chapter_1', 'plans');
        const canonicalStoryPath = join(storyDir, 'story.md');
        const canonicalRelPath = 'chapters/chapter_1/plans/story.md';

        if (existsSync(inputFile) && !existsSync(canonicalStoryPath)) {
          if (!existsSync(storyDir)) mkdirSync(storyDir, { recursive: true });
          const { copyFileSync } = await import('fs');
          copyFileSync(inputFile, canonicalStoryPath);
          this.log(`  Input type 'story': copied original input → ${canonicalRelPath}`);
        }

        const inputConfig = this.config.template.inputTypes?.find(
          (t: { id: string }) => t.id === 'story',
        );
        const skips = (inputConfig as any)?.skipsArtifacts ?? [];
        for (const skipTypeId of skips) {
          const node = this.executor.getNode(skipTypeId);
          if (node && node.status === 'pending') {
            if (skipTypeId === 'story') {
              this.executor.markCompleted(node.id, canonicalRelPath);
              this.log(`  Input type 'story': marked story node completed → ${canonicalRelPath}`);
            } else {
              // Skip plot — mark as completed with a placeholder
              this.executor.markCompleted(node.id, 'skipped-input-is-story');
              this.log(`  Input type 'story': skipping ${skipTypeId}`);
            }
          }
        }
        this.persistState();
      }

      // Expand any collection nodes whose dependencies are already completed
      await this.expandPendingCollections();
      this.reconcileCompletedSceneTimelineSegments();

      this.emitTodoUpdate();

      // Reset stop reason at the start of this run(). Long-lived agent — if
      // the previous run() stopped at a stage, we don't want that leaking.
      this.stopReason = null;

      // Idempotent stage-gate check: if the user asked for /run-to <stage>
      // and the graph is already past that stage, nothing to do. Fire the
      // same paused-at-stage notification + set stopped=true BEFORE any
      // LLM/media calls are made.
      if (this.shouldStopForStageGate()) {
        this.log(`Stage gate '${this.config.stopAtStage}' already satisfied — nothing to run`);
        this.emit({
          type: 'notification',
          level: 'info',
          message: `Already at stage '${this.config.stopAtStage}'.`,
        });
        this.stopReason = 'paused_at_stage';
        this.stopped = true;
      }

      // Main execution loop
      let selfRepairCount = 0;
      const MAX_SELF_REPAIRS = 3;

      // Deadlock detection for serial mode: when content is pending elsewhere
      // in the graph but only media nodes are ready, the loop suppresses the
      // ready batch and goes around again. If nothing else advances (e.g. a
      // failed scene_video_prompt blocking just one shot's downstream chain),
      // we'd spin forever — historically this has eaten gigabytes of disk in
      // log output and starved the HTTP server. We bail out after N
      // consecutive ticks where no progress was made AND no media is in
      // flight to wait on.
      let serialModeIdleTicks = 0;
      const MAX_SERIAL_IDLE = 25;

      while (!this.executor.isComplete() && !this.stopped) {
        // Out-of-process cancel: pnpm stop <project> drops a sentinel
        // file in the project dir. Consume it here on every tick so
        // the pi agent (or any external caller) can kill an in-flight
        // run cleanly via filesystem instead of IPC.
        if (consumeStopFile(this.config.projectDir)) {
          this.log('stop signal received via .executor.stop file — cancelling');
          this.stop();
          break;
        }
        // Expand any type-level collections before checking for ready nodes
        await this.expandPendingCollections();
        this.ensureTimelineInitialized();
        this.reconcileCompletedSceneTimelineSegments();

        // Permanent-failure short-circuit: if a node is `failed` AND its
        // dependents are still `pending` (or `in_progress`), the run has
        // no path to completion. Without this check we'd keep working on
        // unrelated branches until eventually the serial-mode deadlock
        // detector fires ~6s later with a useless "Pipeline deadlocked"
        // message. Surface the actual failure(s) immediately instead.
        // This runs every loop tick (cheap) before we even compute ready
        // nodes — by the time we'd ask for ready work, we already know
        // the run is dead.
        const blockers = findBlockingFailures(this.executor.getAllNodes());
        if (blockers.length > 0 && !this.redoOnlyNodes) {
          this.log(
            `STOPPING: ${blockers.length} permanently-failed node(s) blocking downstream content: ${blockers.map(n => n.id).join(', ')}`,
          );
          this.emit({
            type: 'notification',
            level: 'error',
            message: buildFailedNodesNotification(blockers, MAX_SELF_REPAIRS),
          });
          this.stopReason = 'failed';
          break;
        }

        let readyNodes = this.executor.getNextReady();

        // Isolated-redo mode: a redoNode() call set a whitelist of nodes.
        // We execute ONLY those nodes (and exit when they're all done), so
        // other pending work in the graph is NOT auto-resumed. This preserves
        // the "paused pipeline" semantic — redo one thing, don't restart all.
        if (this.redoOnlyNodes) {
          const whitelist = this.redoOnlyNodes;
          const allWhitelistDone = [...whitelist].every(id => {
            const n = this.executor.getNode(id);
            return !n || n.status === 'completed' || n.status === 'failed' || n.status === 'skipped';
          });
          if (allWhitelistDone) {
            this.log(`Isolated redo complete — stopping (whitelist: ${[...whitelist].join(', ')})`);
            this.redoOnlyNodes = null;
            break;
          }
          readyNodes = readyNodes.filter(n => whitelist.has(n.id));
        }

        if (readyNodes.length === 0) {
          // In parallel mode, if we have pending media, await them and retry
          if (this.pendingMedia.size > 0) {
            this.log(`Awaiting ${this.pendingMedia.size} pending media generation(s)...`);
            await Promise.all(this.pendingMedia.values());
            this.pendingMedia.clear();
            continue;  // Re-check for ready nodes
          }

          // In isolated-redo mode, skip self-repair of unrelated nodes — we
          // only care about the whitelisted nodes. If none are ready, the
          // next iteration's whitelist-done check will break the loop.
          if (this.redoOnlyNodes) {
            this.log(`Isolated redo — no whitelisted nodes ready, exiting loop`);
            this.redoOnlyNodes = null;
            break;
          }

          // Check if we're stuck because of failed nodes blocking downstream
          const failedNodes = this.executor.getAllNodes().filter(n => n.status === 'failed');
          const pendingNodes = this.executor.getAllNodes().filter(n => n.status === 'pending');

          if (failedNodes.length > 0 && pendingNodes.length > 0) {
            // There are failed nodes blocking progress — retry them
            if (selfRepairCount >= MAX_SELF_REPAIRS) {
              // Max retries reached — notify user and stop. Flag as failure
              // (not paused_at_stage) so UI can show error banner, not
              // "paused, continue when ready".
              this.log(`STUCK: ${failedNodes.length} failed node(s) after ${MAX_SELF_REPAIRS} retry attempts. Stopping.`);
              this.emit({
                type: 'notification',
                level: 'error',
                message: buildFailedNodesNotification(failedNodes, MAX_SELF_REPAIRS),
              });
              this.stopReason = 'failed';
              break;
            }

            selfRepairCount++;
            const retryDelay = selfRepairCount * 10000; // 10s, 20s, 30s backoff
            this.log(`Retrying ${failedNodes.length} failed node(s) (attempt ${selfRepairCount}/${MAX_SELF_REPAIRS}, waiting ${retryDelay / 1000}s)...`);
            this.emit({
              type: 'notification',
              level: 'info',
              message: `Retrying ${failedNodes.length} failed node(s) in ${retryDelay / 1000}s (attempt ${selfRepairCount}/${MAX_SELF_REPAIRS})...`,
            });

            await new Promise(resolve => setTimeout(resolve, retryDelay));

            for (const fn of failedNodes) {
              this.executor.invalidateNode(fn.id);
              this.retriedNodes.delete(fn.id); // allow transient retry again
            }
            this.persistState();
            this.emitTodoUpdate();
            continue;
          }

          // No failed nodes — try structural self-repair
          if (selfRepairCount >= MAX_SELF_REPAIRS) {
            this.log(`STUCK: Max self-repair attempts (${MAX_SELF_REPAIRS}) reached. Stopping.`);
            break;
          }

          selfRepairCount++;
          this.log(`No ready nodes — attempting self-repair (${selfRepairCount}/${MAX_SELF_REPAIRS})...`);
          this.repairMissingNodes();
          await this.expandPendingCollections();

          const newReady = this.executor.getNextReady();

          if (newReady.length > 0) {
            this.log(`Self-repair unblocked ${newReady.length} node(s)`);
            this.emit({
              type: 'notification',
              level: 'info',
              message: `Self-repair unblocked ${newReady.length} node(s) — continuing`,
            });
            this.persistState();
            this.emitTodoUpdate();
            continue;
          }

          this.log(`STUCK: Self-repair attempt ${selfRepairCount} could not unblock any nodes.`);
          break;
        }

        // In serial mode: ALL content finishes before ANY media starts.
        // Within content, compositions finish before motion directives.
        if (!this.config.parallelMediaGeneration) {
          const isMediaNode = (n: ExecutionNode) => {
            // Pattern B: shot_image_last_frame is a media node (it
            // produces a frame image), but it isn't registered in
            // template.artifactTypes — without this explicit case it
            // would be miscategorized as content and trigger the
            // serial-mode deadlock detector.
            if (n.typeId === 'shot_image_last_frame') return true;
            const typeDef = this.config.template.artifactTypes[n.typeId];
            const cat = typeDef?.category;
            return cat === 'visual_ref' || cat === 'clip' || cat === 'final';
          };
          const contentNodes = readyNodes.filter(n => !isMediaNode(n));
          const mediaNodes = readyNodes.filter(n => isMediaNode(n));

          // Check if ANY content node is still pending/in-progress in the entire graph
          // (not just the ready batch). If so, don't start media yet.
          const allNodes = this.executor.getAllNodes();
          const pendingContentExists = allNodes.some(n =>
            !isMediaNode(n) && (n.status === 'pending' || n.status === 'in_progress'),
          );

          if (pendingContentExists && mediaNodes.length > 0 && contentNodes.length === 0) {
            // Media nodes are ready but content is still pending elsewhere — skip this round.
            // Track consecutive idle ticks: if we keep arriving here without
            // any in-flight media to wait on, the pending content is
            // permanently blocked (typically because its dep failed or its
            // type-level collection never expanded) and we'd spin forever.
            const pendingContent = allNodes.filter(n => !isMediaNode(n) && n.status === 'pending').length;
            this.log(`  Serial mode: waiting for all content to finish before media (${pendingContent} content pending)`);
            readyNodes.length = 0;

            const inflightMedia = this.pendingMedia.size;
            if (inflightMedia > 0) {
              // We have media still working — that's legitimate progress
              // potential, so don't count this tick as idle.
              serialModeIdleTicks = 0;
            } else {
              serialModeIdleTicks += 1;
              if (serialModeIdleTicks >= MAX_SERIAL_IDLE) {
                const stuckIds = allNodes
                  .filter(n => !isMediaNode(n) && (n.status === 'pending' || n.status === 'in_progress'))
                  .map(n => n.id);
                this.log(`STUCK: serial-mode deadlock — ${pendingContent} content node(s) pending with no in-flight media after ${MAX_SERIAL_IDLE} ticks. Stuck nodes: ${stuckIds.slice(0, 8).join(', ')}${stuckIds.length > 8 ? '...' : ''}`);
                this.emit({
                  type: 'notification',
                  level: 'error',
                  message: `Pipeline deadlocked: ${pendingContent} content node(s) blocked. Likely a failed dependency upstream — check logs and retry.`,
                });
                this.stopReason = 'failed';
                break;
              }
              // Brief sleep so we don't spin the CPU and flood the log.
              // 250ms × MAX_SERIAL_IDLE = ~6s grace before bailing.
              await new Promise(resolve => setTimeout(resolve, 250));
            }
          } else {
            // Within content nodes, prioritize compositions over motion directives
            const compositionNodes = contentNodes.filter(n => n.typeId !== 'shot_motion_directive');
            const motionNodes = contentNodes.filter(n => n.typeId === 'shot_motion_directive');
            const prioritizedContent = compositionNodes.length > 0 ? compositionNodes : motionNodes;

            // Only process media nodes if no content nodes remain anywhere
            readyNodes.length = 0;
            readyNodes.push(...(prioritizedContent.length > 0 ? prioritizedContent : mediaNodes));

            // Real progress — reset the deadlock counter.
            serialModeIdleTicks = 0;
          }
        }

        this.log(`Ready nodes: ${readyNodes.map(n => n.id).join(', ')}`);

        /**
         * Process one ready node. Encapsulated as a local async fn so
         * the outer loop can choose to await serially OR fan out a
         * bounded number of LLM-eligible nodes concurrently. Every
         * `continue` in here that used to advance the outer for-loop
         * has been converted to `return` — behavior identical in
         * serial mode; enables parallelism when dispatched concurrently.
         *
         * Media (ComfyUI / FFmpeg) work still flows through the existing
         * `parallelMediaGeneration` / `pendingMedia` machinery — this
         * split is only about LLM calls.
         */
        const runOneNode = async (node: ExecutionNode): Promise<void> => {
          // In parallel mode: await any pending media this node depends on
          if (this.config.parallelMediaGeneration) {
            for (const depId of node.dependencies) {
              const pending = this.pendingMedia.get(depId);
              if (pending) {
                this.log(`  Waiting for pending media: ${depId}`);
                await pending;
                this.pendingMedia.delete(depId);
              }
            }
          }

          // Self-healing: validate dependency output files exist before executing
          const missingDeps = this.validateDependencyOutputs(node);
          if (missingDeps.length > 0) {
            // Track regeneration attempts to prevent infinite loops
            for (const depId of missingDeps) {
              const key = `${node.id}→${depId}`;
              const count = (this.depRegenCounts.get(key) ?? 0) + 1;
              this.depRegenCounts.set(key, count);

              if (count > 2) {
                this.log(`  LOOP PROTECTION: ${depId} regenerated ${count} times for ${node.id} — marking failed`);
                this.executor.markFailed(node.id, `Dependency ${depId} output keeps disappearing after ${count} regeneration attempts`);
                break;
              }

              this.log(`  Dependency output missing: ${depId} — resetting to pending for regeneration (attempt ${count}/2)`);
              // Reset ONLY this dependency node — don't cascade to its dependents
              // The downstream nodes just need this dep to be re-completed
              const depNode = this.executor.getNode(depId);
              if (depNode) {
                depNode.status = 'pending';
                depNode.outputPath = undefined;
                depNode.completedAt = undefined;
                depNode.error = undefined;
              }
              this.emit({
                type: 'notification',
                level: 'warning',
                message: `Auto-regenerating: ${depId} (output file missing)`,
              });
            }
            this.persistState();
            this.emitTodoUpdate();
            return; // Skip this node — deps need to regenerate first
          }

          this.executor.markStarted(node.id);
          this.emitPhaseIfChanged(node);
          this.emitTodoUpdate();
          this.emit({ type: 'agent_status', status: 'thinking', agentName });

          const progress = this.executor.getProgress();
          this.log(`[${progress.completed}/${progress.total}] Starting: ${node.id} (${node.displayName})`);
          this.emit({
            type: 'notification',
            level: 'info',
            message: `[${progress.completed}/${progress.total}] Working on: ${node.displayName}`,
          });

          try {
            // Check for deterministic nodes FIRST — these skip LLM entirely
            const nodeTypeDef = this.config.template.artifactTypes[node.typeId];
            const nodeCategory = nodeTypeDef?.category;
            let finalOutputPath = '';
            const toolCallId = `exec_${node.id}_${Date.now()}`;

            if (nodeCategory === 'final' && !this.config.skipMediaGeneration) {
              // Final assembly — skip LLM, go straight to deterministic assembly
              const assemblyResult = await this.executeFinalAssembly(node, toolCallId);
              if (!assemblyResult) {
                this.executor.markFailed(node.id, this.consumeLastNodeError('Final assembly failed'));
                return;
              }
              finalOutputPath = assemblyResult;
            } else if (nodeCategory === 'final' && this.config.skipMediaGeneration) {
              // Test mode: skip final assembly — mark completed so pipeline finishes
              this.log(`  Skipping final assembly (skipMediaGeneration=true)`);
              this.executor.markCompleted(node.id, 'skipped-test-mode');
              this.persistState();
              this.emitTodoUpdate();
              return;
            } else if (node.typeId === 'shot_video' && !this.config.skipMediaGeneration) {
              // Shot video — purely deterministic: take shot image + motion → video provider
              const videoResult = await this.executeShotVideo(node, toolCallId);
              if (!videoResult) {
                this.executor.markFailed(node.id, this.consumeLastNodeError('Shot video generation failed'));
                return;
              }
              finalOutputPath = videoResult;
              // Update timeline segment with the generated video
              this.updateTimelineForShotVideo(node, finalOutputPath);
            } else if (node.typeId === 'shot_video' && this.config.skipMediaGeneration) {
              // Test mode: skip shot video — mark completed so downstream nodes aren't blocked
              this.log(`  Skipping shot_video (skipMediaGeneration=true)`);
              this.executor.markCompleted(node.id, 'skipped-test-mode');
              this.persistState();
              this.emitTodoUpdate();
              return;
            } else if (node.typeId === 'shot_image' && !this.config.skipMediaGeneration) {
              // Shot image — deterministic: read prompt JSON, resolve refs, call ComfyUI
              const shotImageResult = await this.executeShotImage(node, toolCallId);
              if (!shotImageResult) {
                this.executor.markFailed(node.id, this.consumeLastNodeError('Shot image generation failed'));
                return;
              }
              finalOutputPath = shotImageResult;
              // Update timeline segment with the generated first-frame preview
              this.updateTimelineForShotImage(node, finalOutputPath);
            } else if (node.typeId === 'shot_image' && this.config.skipMediaGeneration) {
              // Test mode: skip shot image generation
              this.log(`  Skipping shot_image (skipMediaGeneration=true)`);
              this.executor.markCompleted(node.id, 'skipped-test-mode');
              this.persistState();
              this.emitTodoUpdate();
              return;
            } else if (node.typeId === 'shot_image_last_frame' && !this.config.skipMediaGeneration) {
              // Phase 2 (Pattern B): the bridge node owns its own
              // artifact. It runs edit_first_frame against the
              // upstream shot_image:X's first_frame and writes the
              // result to its own outputPath. Replaces the Phase 1
              // mirror that could go stale when the upstream was
              // invalidated without cascading. See
              // executeShotImageLastFrame.ts.
              const lfCallId = `frame_${node.itemId}_last_frame_${Date.now()}`;
              const lfToolName = 'generate_frame_image';
              this.emit({
                type: 'tool_call',
                toolCallId: lfCallId,
                toolName: lfToolName,
                arguments: {
                  item: `${node.displayName} — last frame`,
                  mode: 'edit_first_frame',
                },
                agentName,
              });
              this.emit({
                type: 'tool_streaming',
                toolCallId: lfCallId,
                chunk: `Generating last_frame (edit_first_frame)...`,
                done: false,
                agentName,
                toolName: lfToolName,
              });

              const lfResult = await executeShotImageLastFrame(node, {
                executor: { getNode: (id) => this.executor.getNode(id) },
                projectDir: this.config.projectDir,
                fs: { existsSync, readFileSync, mkdirSync },
                editImageLayered: ({ prompt, sourceImagePath, refPaths, outputDir, filenamePrefix }) =>
                  this.editImageLayered(prompt, sourceImagePath, refPaths, outputDir, filenamePrefix),
                resolveRefIds: (refs) => this.resolveRefIds(refs),
                isPromptRelayMode: () => isPromptRelayMode(),
                log: (m) => this.log(`  ${m}`),
              });

              if (lfResult.action === 'fail') {
                this.emit({
                  type: 'tool_result',
                  toolCallId: lfCallId,
                  toolName: lfToolName,
                  result: { status: 'failed', frame: 'last_frame', error: lfResult.error },
                  agentName,
                });
                this.executor.markFailed(node.id, lfResult.error);
                this.persistState();
                this.emitTodoUpdate();
                return;
              }

              const newPath = lfResult.outputPath;
              if (newPath) {
                this.emit({
                  type: 'tool_streaming',
                  toolCallId: lfCallId,
                  chunk: `last_frame saved: ${newPath}`,
                  done: true,
                  agentName,
                  toolName: lfToolName,
                });
                this.emit({
                  type: 'tool_result',
                  toolCallId: lfCallId,
                  toolName: lfToolName,
                  result: { status: 'completed', file_path: newPath, frame: 'last_frame' },
                  agentName,
                });
                // Asset registry: nodeId is the bridge node now (Phase 2),
                // and `frame: 'last_frame'` keeps the scenes-tree mirror
                // populating via applyAssetToProjectSchema. See
                // tests/unit/addAssetDualWrite.test.ts.
                try {
                  addAsset({
                    id: `frame_${node.itemId}_last_frame_${Date.now()}`,
                    type: 'scene_image',
                    path: newPath,
                    createdAt: Date.now(),
                    nodeId: node.id,
                    frame: 'last_frame',
                  });
                } catch { /* non-fatal */ }
              } else {
                // No-op complete (prompt_relay or single-frame shot).
                this.emit({
                  type: 'tool_result',
                  toolCallId: lfCallId,
                  toolName: lfToolName,
                  result: { status: 'completed', frame: 'last_frame', skipped: true },
                  agentName,
                });
              }

              this.executor.markCompleted(node.id, newPath ?? '');
              this.persistState();
              this.emitTodoUpdate();
              return;
            } else if (node.typeId === 'shot_image_last_frame' && this.config.skipMediaGeneration) {
              this.log(`  Skipping shot_image_last_frame (skipMediaGeneration=true)`);
              this.executor.markCompleted(node.id, 'skipped-test-mode');
              this.persistState();
              this.emitTodoUpdate();
              return;
            } else if (node.typeId === 'story_essence') {
              const essenceResult = await this.executeStoryEssenceNode(node, toolCallId, agentName);
              if (!essenceResult) {
                this.executor.markFailed(node.id, this.consumeLastNodeError('Story essence extraction failed'));
                this.persistState();
                this.emitTodoUpdate();
                return;
              }
              finalOutputPath = essenceResult;
            } else if (node.typeId === 'scene_video_prompt') {
              // Stage C of the hierarchical breakdown — deterministic
              // assembly of scene_shot_plan + N shot_breakdown outputs into
              // the existing sceneVideoPromptSchema shape. No LLM call.
              const assemblyResult = await this.executeSceneVideoPromptAssembly(node, toolCallId, agentName);
              if (!assemblyResult) {
                // markFailed already called inside the helper.
                return;
              }
              finalOutputPath = assemblyResult;
            } else {
              // Non-deterministic node — needs LLM (or skip-if-exists)
              // 1. Resolve inputs
              const inputs = resolveInputs(node, this.executor, this.config.projectDir);
              this.log(`  Inputs resolved: ${inputs.filesRead.length} files read: ${inputs.filesRead.join(', ') || '(none)'}`);
              this.log(`  Reference images: ${inputs.referenceImages.length}`);
              this.log(`  Context block length: ${inputs.contextBlock.length} chars`);

              // 2. Build prompt
              const { system, user, loadedSkills } = await this.buildPromptForNode(node, inputs);
              this.log(`  Prompt built: system=${system.length} chars, user=${user.length} chars`);

              // 3. Emit tool_call
              const toolName = this.getToolDisplayName(node);
              const toolArgs = this.getToolDisplayArgs(node, inputs);
              if (loadedSkills.length > 0) {
                toolArgs['skills'] = loadedSkills.join(', ');
              }
              // Attach the LLM model that will handle this call (for UI display).
              toolArgs['model'] = this.modelFor(this.purposeForNode(node));
              this.emit({
                type: 'tool_call',
                toolCallId,
                toolName,
                arguments: toolArgs,
                agentName,
              });

              // 4. For expensive ops, ask user approval
              if (node.isExpensive) {
                this.log(`  Expensive op — requesting approval`);
                const approved = await this.askApproval(node, inputs);
                if (!approved) {
                  this.log(`  Skipped by user`);
                  this.executor.markFailed(node.id, 'Skipped by user');
                  return;
                }
              }

              // Check if prompt/output file already exists on disk (from a previous run)
              // BUT: if any dependency was re-completed more recently than the prompt file,
              // the prompt is stale and must be regenerated (e.g., after a reset)
              const isMediaNode = nodeCategory === 'visual_ref' || nodeCategory === 'clip';
              if (isMediaNode) {
                const existingPromptPath = this.findExistingPromptFile(node);
                // forceUseExistingPrompt — set by applyInvalidation when the
                // user invalidates with `keepPrompt: true` after hand-editing
                // the prompt JSON. Overrides the staleness check so the LLM
                // doesn't re-run and overwrite the edits. Cleared on success
                // below so subsequent natural invalidations behave normally.
                const forceKeepPrompt = !!(node.metadata as Record<string, unknown> | undefined)?.['forceUseExistingPrompt'];
                const promptIsStale = existingPromptPath && !forceKeepPrompt
                  ? this.isPromptStale(node, existingPromptPath)
                  : false;
                if (existingPromptPath && (forceKeepPrompt || !promptIsStale)) {
                  if (forceKeepPrompt) {
                    this.log(`  Prompt file exists and forceUseExistingPrompt is set — skipping LLM (user-edited prompt)`);
                  } else {
                    this.log(`  Prompt file already exists: ${existingPromptPath} — skipping LLM`);
                  }

                  if (isMediaNode) {
                    // Media node: skip LLM, go straight to image/video generation
                    this.emit({
                      type: 'notification',
                      level: 'info',
                      message: forceKeepPrompt
                        ? `Skipping LLM for ${node.displayName} — using hand-edited prompt`
                        : `Skipping LLM for ${node.displayName} — prompt exists, going to image gen`,
                    });
                    const mediaPath = await this.executeMediaGenerationWithRetry(node, existingPromptPath, toolCallId);
                    if (mediaPath) {
                      finalOutputPath = mediaPath;
                      // Clear the sentinel on success so a future natural
                      // invalidate of this node re-runs the LLM as usual.
                      // We leave it alone on failure so the user can retry
                      // (e.g. Comfy queue blip) without losing their edit.
                      const meta = node.metadata as Record<string, unknown> | undefined;
                      if (meta && 'forceUseExistingPrompt' in meta) {
                        delete meta['forceUseExistingPrompt'];
                      }
                    } else {
                      this.executor.markFailed(node.id, this.consumeLastNodeError('Media generation failed (prompt saved, will retry)'));
                      this.emitTodoUpdate();
                      return;
                    }
                  }

                  this.emit({
                    type: 'tool_result',
                    toolCallId,
                    toolName,
                    result: { status: 'skipped', file: finalOutputPath, reason: 'already exists' },
                    agentName,
                  });
                  this.emit({
                    type: 'agent_text',
                    text: `**${node.displayName}** → \`${finalOutputPath}\` (exists, skipped)`,
                    isFinal: false,
                  });
                  this.executor.markCompleted(node.id, finalOutputPath);
                  this.persistState();
                  this.emitTodoUpdate();
                  this.log(`  COMPLETED (skipped): ${node.id} → ${finalOutputPath}`);
                  if (this.config.stopAfterNodeType && node.typeId === this.config.stopAfterNodeType) {
                    this.log(`  stopAfterNodeType matched: ${node.typeId} — stopping`);
                    this.stopReason = 'paused_at_stage';
                    this.stopped = true;
                  }
                  if (this.shouldStopForStageGate()) {
                    this.log(`  stage gate '${this.config.stopAtStage}' satisfied — stopping`);
                    this.emit({
                      type: 'notification',
                      level: 'info',
                      message: `Paused at stage '${this.config.stopAtStage}'.`,
                    });
                    this.stopReason = 'paused_at_stage';
                    this.stopped = true;
                  }
                  return;
                }
              }

              // Generate content via LLM (pure completion, no tools).
              // Bug 13: one-shot retry for empty LLM responses. Transient
              // model-API hiccups (rate limit recovery, brief content-policy
              // false positive, network blip mid-stream) commonly return
              // 0 chars. Before the empty-content guard hard-fails the
              // node and forces the user to manually invalidate, give the
              // LLM exactly one more chance — same prompt, fresh call.
              // If the retry also returns empty, fail-fast as before.
              this.log(`  Calling LLM...`);
              let content = await retryOnEmptyLLMResponse(
                () => this.generateForNode(node, system, user, toolCallId, toolName),
                {
                  log: (m) => this.log(`  ${m}`),
                  onRetry: () => {
                    this.emit({
                      type: 'notification',
                      level: 'info',
                      message: `LLM returned empty response for ${node.displayName} — retrying once.`,
                    });
                  },
                },
              );
              this.log(`  LLM returned ${content.length} chars`);

              // Motion-directive soft-warn: scan for ambiguous speaker
              // tags ("The woman says", "He says") when 2+ characters
              // are in the shot. The video model lip-syncs to whichever
              // character is most visually prominent when the tag is
              // generic, so dialogue ends up on the wrong mouth. Pure
              // warning — we don't block or retry (that would risk
              // oscillation with the guide's own phrasing rules).
              if (node.typeId === 'shot_motion_directive') {
                this.scanMotionDirectiveForAmbiguousSpeaker(node, content);
              }

              // Validate JSON output for nodes that require it
              const jsonValidatedTypes = ['scene_shot_plan', 'shot_breakdown', 'scene_video_prompt', 'shot_image_prompt', 'character_image', 'setting_image'];
              if (jsonValidatedTypes.includes(node.typeId)) {
                const validation = this.validateJsonOutput(content, node);
                if (validation.valid && validation.normalizedContent) {
                  content = validation.normalizedContent;
                }
                if (!validation.valid) {
                  // Classify before routing. Structural errors (bad JSON
                  // syntax, missing fields, type mismatches) get the
                  // legacy json_repair → retry path — json_repair can
                  // plausibly fix syntax-level issues. Semantic errors
                  // (the JSON parses fine but violates a project rule —
                  // hallucinated character refs, OTS-with-single-char,
                  // shotNumber mismatch) skip json_repair entirely
                  // because it can't help: the syntax was already valid.
                  // Instead they go directly to a targeted retry with
                  // the actual validation message injected into the
                  // system prompt as corrective guidance.
                  const errorClass = classifyValidationError(validation.error ?? '');
                  let currentError = validation.error ?? '';
                  let recovered = false;
                  this.log(`  JSON validation failed (${errorClass}): ${currentError}`);
                  // Persist the first broken attempt to the .failed sidecar
                  // immediately, so it's visible in the project tree while
                  // the repair / retry path runs. If repair or retry
                  // succeeds we delete it (the file lifecycle mirrors the
                  // node's actual state); if both fail, we re-write it
                  // with the FINAL broken content below.
                  writeFailedAttempt(
                    node,
                    content,
                    validation.error ?? 'unknown validation error',
                    this.config.projectDir,
                    this.config.template,
                  );
                  this.emit({
                    type: 'notification',
                    level: 'warning',
                    message: errorClass === 'structural'
                      ? `Invalid JSON from LLM for ${node.displayName} — attempting repair`
                      : `Output rejected for ${node.displayName} — retrying with targeted guidance`,
                  });

                  // Close the original tool card as error.
                  this.emit({
                    type: 'tool_result',
                    toolCallId,
                    toolName,
                    result: { status: 'error', error: `Invalid JSON: ${currentError}` },
                    agentName,
                    isError: true,
                  });

                  // Step 1 (structural only): try json_repair. Skipped
                  // for semantic AND truncated failures — repair can't
                  // fix either: semantic JSON is already valid syntax,
                  // and truncated input has missing content that
                  // repair would AUTHOR as filler (we hit this exact
                  // bug on Stage A when "Unexpected end of JSON" was
                  // classified as structural and repair produced a
                  // stub plan with "Default scene"/"Default shot.").
                  // Both classes fall through to the full retry which
                  // has the original scene-script + available_refs +
                  // output_contract context, so it can author content
                  // — not just patch syntax.
                  if (errorClass === 'structural') {
                    const repairCallId = `repair_${node.id}_${Date.now()}`;
                    this.emit({
                      type: 'tool_call',
                      toolCallId: repairCallId,
                      toolName: 'json_repair',
                      arguments: {
                        item: node.displayName,
                        error: currentError,
                        model: this.modelFor('utility.json_repair'),
                      },
                      agentName,
                    });
                    const fixPrompt = `The following JSON output has an error. Fix it and return ONLY the corrected valid JSON — no explanation, no markdown fences, no extra text.\n\nError: ${currentError}\n\nBroken JSON:\n${content.substring(0, 8000)}`;
                    const fixedContent = await this.generateForNode(
                      node,
                      'You are a JSON repair tool. Return ONLY valid JSON. No markdown, no explanation.',
                      fixPrompt,
                      repairCallId,
                      'json_repair',
                      'utility.json_repair',
                    );
                    const fixValidation = this.validateJsonOutput(fixedContent, node);
                    if (fixValidation.valid) {
                      content = fixValidation.normalizedContent ?? fixedContent;
                      recovered = true;
                      this.log(`  LLM JSON repair succeeded`);
                      this.emit({
                        type: 'tool_result',
                        toolCallId: repairCallId,
                        toolName: 'json_repair',
                        result: { status: 'completed' },
                        agentName,
                      });
                    } else {
                      this.log(`  LLM repair failed: ${fixValidation.error} — full retry...`);
                      this.emit({
                        type: 'tool_result',
                        toolCallId: repairCallId,
                        toolName: 'json_repair',
                        result: { status: 'error', error: fixValidation.error },
                        agentName,
                        isError: true,
                      });
                      // Use the most recent error as the retry's
                      // corrective guidance — it reflects the current
                      // state of the content after one repair attempt.
                      currentError = fixValidation.error ?? currentError;
                    }
                  }

                  // Step 2: full retry. Fires when:
                  //   - semantic error (skipped step 1), or
                  //   - structural error AND step 1's repair also failed.
                  if (!recovered) {
                    const retryCallId = `retry_${node.id}_${Date.now()}`;
                    this.emit({
                      type: 'tool_call',
                      toolCallId: retryCallId,
                      toolName,
                      arguments: {
                        item: node.displayName,
                        retry: true,
                        errorClass,
                        model: this.modelFor(this.purposeForNode(node)),
                      },
                      agentName,
                    });
                    // Class-aware retry guidance: structural retries get
                    // the generic "must be valid JSON" reminder; semantic
                    // retries get the actual validation message injected
                    // so the LLM has a specific thing to correct.
                    const retrySystem = system + buildRetrySystemSuffix(
                      errorClass,
                      currentError,
                    );
                    const retryContent = await this.generateForNode(
                      node,
                      retrySystem,
                      user,
                      retryCallId,
                      toolName,
                    );
                    const retryValidation = this.validateJsonOutput(retryContent, node);
                    if (retryValidation.valid) {
                      content = retryValidation.normalizedContent ?? retryContent;
                      this.log(`  Full retry succeeded — valid JSON`);
                      // Retry worked — drop the .failed sidecar we wrote
                      // on first failure (same rationale as the repair
                      // success branch above).
                      clearFailedAttempt(node, this.config.projectDir, this.config.template);
                    } else {
                      this.log(`  Full retry also failed: ${retryValidation.error}`);
                      // Persist the broken content so the user can inspect /
                      // hand-edit / rename to recover, instead of fishing
                      // through llm-calls.log. Path mirrors the artifact's
                      // resolved output path with a `.failed` suffix; a
                      // companion `.failed.error` carries the validator
                      // message so they don't have to re-read the chat.
                      const sidecar = writeFailedAttempt(
                        node,
                        retryContent,
                        retryValidation.error ?? 'unknown validation error',
                        this.config.projectDir,
                        this.config.template,
                      );
                      const recoveryHint = sidecar.contentPath
                        ? `\nBroken content saved to: ${sidecar.contentPath} — edit and rename to remove the .failed suffix to recover, or send any message to retry.`
                        : '';
                      this.executor.markFailed(
                        node.id,
                        `Invalid JSON output after retry: ${retryValidation.error}${recoveryHint}`,
                      );
                      this.emitTodoUpdate();
                      return;
                    }
                  }
                }
              }

              // Empty-content guard. The JSON validator above only
              // fires for nodes in `jsonValidatedTypes`; plain-text
              // nodes (shot_motion_directive, world_style, story,
              // etc.) had no post-LLM guard at all. Pre-fix, an empty
              // LLM response sailed straight through `writeOutput`,
              // wrote 0 bytes, and got marked `completed` — the
              // 2026-05-19 Soft Seinen scene_2_shot_2 incident, where
              // the motion-directive LLM returned nothing, the file
              // was 0 bytes, the downstream `shot_video` reader's
              // JSON.parse silently fell back to empty string, and
              // LTX-V produced a 5-second video with no motion
              // directive. Fail fast so the next dispatch (or a
              // Redo-from-menu cycle) cleanly regenerates instead of
              // shipping a broken shot.
              const empty = checkEmptyContent(content);
              if (empty.isEmpty) {
                const reason = buildEmptyContentFailureReason(node.id, empty);
                this.log(`  [empty-content-guard] ${reason}`);
                this.emit({
                  type: 'notification',
                  level: 'error',
                  message: `Empty LLM output for ${node.displayName} — node marked failed (not writing 0-byte file).`,
                });
                this.emit({
                  type: 'tool_result',
                  toolCallId,
                  toolName,
                  result: { status: 'failed', error: reason },
                  agentName,
                });
                this.executor.markFailed(node.id, reason);
                this.emitTodoUpdate();
                return;
              }

              // shot_motion_directive uses the LTX-V official prompt-
              // enhancer style guide, which yields plain text starting
              // with "Style: realistic - …". The on-disk contract is a
              // JSON object `{ "motionDirective": "<text>" }` — the
              // PromptsView panel parses motion files as JSON and the
              // downstream readers at ExecutorAgent.ts:5901/7594/7956
              // expect `motionDirective` as a string field. Wrap once
              // here so the writer-side contract is deterministic
              // regardless of what the LLM produced. If the LLM already
              // emitted valid JSON with a motionDirective field, we
              // re-canonicalize the indentation but otherwise pass it
              // through.
              if (node.typeId === 'shot_motion_directive') {
                const trimmed = content.trim();
                let directive = trimmed;
                if (trimmed.startsWith('{')) {
                  try {
                    const parsed = JSON.parse(trimmed) as { motionDirective?: unknown };
                    if (typeof parsed?.motionDirective === 'string') {
                      directive = parsed.motionDirective;
                    }
                  } catch {
                    // LLM returned text starting with '{' but not valid
                    // JSON — treat as raw text and let the wrap fix it.
                  }
                }
                content = JSON.stringify({ motionDirective: directive }, null, 2);
              }

              // shot_image_prompt — turn 2 ref-extraction refinement.
              //
              // Turn 1 (the generateForNode call above) produces the JSON
              // including an LLM-emitted `references[]` array. That array
              // is unreliable: the LLM commits to refs before it has
              // authored the prose, so OTS / dialogue shots end up with
              // wrong Side A/B assignments and identical backgrounds.
              //
              // Turn 2 takes the prose the LLM just wrote, hands it the
              // current existing-refs menu, and asks for a structured
              // refined `references[]`. This is a SECOND USER TURN on
              // the SAME conversation — turn 1's response stays in the
              // messages array as `assistant` so the LLM has its own
              // prose in context when extracting refs.
              //
              // Side A/B falls out naturally: the LLM sees its own
              // framing language ("from over Ruby's shoulder…") and
              // assigns Ruby='B', Angel='A' for that shot. The reverse
              // shot's prose gets the mirrored assignment.
              //
              // Failure mode: any error in turn 2 falls back to keeping
              // turn 1's refs as-is. The pipeline never blocks on the
              // refinement.
              if (node.typeId === 'shot_image_prompt') {
                try {
                  const refined = await this.refineShotImageRefs(
                    node, system, user, content, toolCallId, toolName,
                  );
                  if (refined) {
                    content = refined;
                    // Re-run the deterministic post-pass on the refined
                    // content. validateJsonOutput's manifest-rebuild step
                    // (lines ~5852-5858) reads each frame's `references`
                    // and prepends a fresh `<Label> from image N.` line,
                    // stripping any stale inline tokens. Without this,
                    // the manifest baked in by turn-1 — built from turn-1's
                    // possibly incomplete refs — survives and the setting
                    // (slot 1) gets silently dropped from Klein's
                    // conditioning even though `references[]` lists it.
                    // See 2026-05-20 Ruby V3 s1s1 ("Ruby from image 1."
                    // with no setting line) for the symptom.
                    const postValidation = this.validateJsonOutput(content, node);
                    if (postValidation.valid && postValidation.normalizedContent) {
                      content = postValidation.normalizedContent;
                    }
                  }
                } catch (err) {
                  this.log(
                    `  [shot_image_prompt turn-2] refinement skipped: ${(err as Error).message}`,
                  );
                }

                // Phase 2 boundary-planner orchestration. Runs lazily —
                // the first shot_image_prompt of each scene triggers the
                // per-scene planner LLM call; subsequent shots in the
                // same scene hit the cached plan in project.scenes. The
                // planner writes `incomingTransition` + `needsLfAnchor`
                // onto each shot, which `applyHoldingBeatSkip` (below)
                // and `applyTransitionPlanToShotImagePrompt` (further
                // below) both read. No-op when the
                // `transitionBoundaryPlanner` flag is OFF.
                try {
                  const sceneIdMatch = node.itemId?.match(/^(scene_(\d+))_shot_(\d+)$/);
                  if (sceneIdMatch?.[1] && sceneIdMatch[2]) {
                    await this.ensureBoundaryPlanForScene(
                      sceneIdMatch[1],
                      parseInt(sceneIdMatch[2], 10),
                    );
                  }
                } catch (err) {
                  this.log(
                    `  [boundary-planner] orchestration failed (non-fatal): ${(err as Error).message}`,
                  );
                }

                // Skip-LF for holding beats: load this shot's purpose +
                // cameraWork from scene_video_prompt, run isHoldingBeat,
                // and if it fires, strip frames.last_frame from the JSON
                // and flip generationStrategy to 'i2v'. The downstream
                // executor reads strategy=i2v and routes shot_video to
                // ltx23_i2v_* workflows; executeShotImageLastFrame
                // already no-ops on missing frames.last_frame.imagePrompt.
                // Combined with the boundary planner (above): an LF with
                // a downstream consumer or `needsLfAnchor: true` is kept
                // even on holding beats — see `shouldSkipLastFrame`.
                try {
                  const filtered = this.applyHoldingBeatSkip(content, node);
                  if (filtered) content = filtered;
                } catch (err) {
                  this.log(
                    `  [shot_image_prompt holding-beat] skip check failed: ${(err as Error).message}`,
                  );
                }

                // Phase 2 Stage 3 — mutate the shot_image_prompt JSON
                // based on this shot's `incomingTransition` (set by the
                // boundary planner above): shared_frame / reuse_intent
                // → force edit_previous_shot mode with a strong "match
                // prior LF" preamble; reframe → "blocking diverges"
                // preamble; cut → no-op.
                try {
                  const sceneIdMatch = node.itemId?.match(/^scene_(\d+)_shot_(\d+)$/);
                  if (sceneIdMatch?.[1] && sceneIdMatch[2]) {
                    const sceneNumber = parseInt(sceneIdMatch[1], 10);
                    const shotNumber = parseInt(sceneIdMatch[2], 10);
                    const mutated = applyTransitionPlanToShotImagePrompt(
                      content,
                      this.config.project as Parameters<typeof applyTransitionPlanToShotImagePrompt>[1],
                      sceneNumber,
                      shotNumber,
                    );
                    if (mutated) {
                      content = mutated;
                      this.log(
                        `  [boundary-planner] applied transition mutation to ${node.itemId}`,
                      );
                    }
                  }
                } catch (err) {
                  this.log(
                    `  [boundary-planner] transition mutation failed (non-fatal): ${(err as Error).message}`,
                  );
                }
              }

              // Write prompt/content to disk
              let outputPath = writeOutput(
                node, content, this.config.projectDir, this.config.template,
              );
              this.log(`  Written to: ${outputPath}`);
              // Clean up any stale .failed sidecar from a prior failed
              // run of this same node. Idempotent — no-op when none exists.
              clearFailedAttempt(node, this.config.projectDir, this.config.template);

              // Record the prompt path in project.json for media nodes so a
              // later run can legitimately skip LLM regeneration (crash
              // recovery). Without this explicit record, orphan prompt JSONs
              // on disk would silently override the pending status — see
              // `findExistingPromptFile` for the full contract.
              if (nodeCategory === 'visual_ref' || nodeCategory === 'clip') {
                node.promptPath = outputPath;
              }

              // State is now computed BEFORE prompt generation in buildPromptForNode().
              // No post-generation state extraction needed.

              // Emit tool_result for the prompt generation
              this.emit({
                type: 'tool_result',
                toolCallId,
                toolName,
                result: { status: 'completed', file: outputPath },
                agentName,
              });

              // For media nodes: execute actual generation after prompt is written
              if ((nodeCategory === 'visual_ref' || nodeCategory === 'clip') && !this.config.skipMediaGeneration) {
                if (this.config.parallelMediaGeneration) {
                  // Parallel mode: fire-and-forget, collect result later
                  // The node stays as 'in_progress' until media completes
                  const capturedOutputPath = outputPath;
                  const mediaPromise = this.executeMediaGeneration(node, capturedOutputPath, toolCallId)
                    .then(mediaPath => {
                      if (mediaPath) {
                        this.executor.markCompleted(node.id, mediaPath);
                        this.persistState();
                        this.emitTodoUpdate();
                        this.log(`  [parallel] Media ready: ${node.id} → ${mediaPath}`);
                      } else {
                        // Media failed — mark as failed so it doesn't pollute downstream
                        this.executor.markFailed(node.id, this.consumeLastNodeError('Media generation failed (prompt saved)'));
                        this.persistState();
                        this.emitTodoUpdate();
                        this.log(`  [parallel] Media failed: ${node.id} — prompt at ${capturedOutputPath}`);
                      }
                      return mediaPath;
                    })
                    .catch(err => {
                      this.executor.markFailed(node.id, String(err));
                      this.persistState();
                      this.log(`  [parallel] Media error: ${node.id} — ${String(err)}`);
                      return null;
                    });
                  this.pendingMedia.set(node.id, mediaPromise);
                  // Don't mark completed here — the parallel handler will do it
                  // Skip the markCompleted below by returning
                  this.log(`  [parallel] Media generation queued for ${node.id}`);
                  return; // Skip markCompleted — parallel handler owns the node status
                } else {
                  // Serial mode: block until media is generated (with retry)
                  const mediaPath = await this.executeMediaGenerationWithRetry(node, outputPath, toolCallId);
                  if (mediaPath) {
                    outputPath = mediaPath;  // Update to actual media file path
                  } else {
                    // Media generation failed — node should NOT be marked completed
                    // The prompt file is preserved so retry will skip LLM and go straight to image gen
                    this.executor.markFailed(node.id, this.consumeLastNodeError('Media generation failed (prompt saved, will retry)'));
                    this.emitTodoUpdate();
                    this.log(`  Media gen failed for ${node.id} — marked failed, prompt preserved at ${outputPath}`);
                    return;
                  }
                }
              }

              finalOutputPath = outputPath;
            }

            // 5. Log completion (visible in executor log, NOT in chat UI)
            this.log(`  ✓ ${node.displayName} → ${finalOutputPath}`);

            // 6. Extract collection items if this node produces them
            // (only for LLM-generated content nodes, not final assembly)
            if (nodeCategory !== 'final') {
              // Only story (extracts chars/settings/scenes) and scene_video_prompt (extracts shots) produce collection items
              const needsExpansion = node.typeId === 'story' || node.typeId === 'scene_video_prompt';
              if (needsExpansion) {
                // Read content back from the prompt file for extraction
                const writtenFile = join(this.config.projectDir, finalOutputPath);
                if (existsSync(writtenFile)) {
                  const writtenContent = readFileSync(writtenFile, 'utf-8');
                  this.log(`  Extracting collection items...`);
                  await this.handleCollectionExpansion(node, writtenContent, finalOutputPath);
                }
              }
            }

            // 7. Mark completed and persist state
            this.executor.markCompleted(node.id, finalOutputPath);
            this.persistState();
            this.emitTodoUpdate();
            this.log(`  COMPLETED: ${node.id}`);

            // Reset self-repair counter and dep regen tracking on successful completion
            selfRepairCount = 0;
            // Clear regen counts for this node's deps (they succeeded)
            for (const key of this.depRegenCounts.keys()) {
              if (key.startsWith(`${node.id}→`)) this.depRegenCounts.delete(key);
            }

            // Check if we should stop after this node type (test mode)
            if (this.config.stopAfterNodeType && node.typeId === this.config.stopAfterNodeType) {
              this.log(`  stopAfterNodeType matched: ${node.typeId} — stopping`);
              this.stopReason = 'paused_at_stage';
              this.stopped = true;
            }
            // `/run-to <stage>` gate: fire only once every node of the gated
            // typeIds (all aliased siblings + every per-item child) is terminal.
            if (this.shouldStopForStageGate()) {
              this.log(`  stage gate '${this.config.stopAtStage}' satisfied — stopping`);
              this.emit({
                type: 'notification',
                level: 'info',
                message: `Paused at stage '${this.config.stopAtStage}'.`,
              });
              this.stopReason = 'paused_at_stage';
              this.stopped = true;
            }

          } catch (error) {
            const errMsg = String(error);
            const isTransient = /premature close|timed? ?out|ECONNRESET|ECONNREFUSED|socket hang up|network|connection error|502|503|429/i.test(errMsg);

            if (isTransient && !this.retriedNodes.has(node.id)) {
              // Retry once for transient errors
              this.retriedNodes.add(node.id);
              this.log(`  TRANSIENT ERROR: ${node.id} — ${errMsg} — will retry`);
              this.executor.markFailed(node.id, errMsg);
              // Reset to pending so it gets picked up again
              this.executor.invalidateNode(node.id);
              this.emit({
                type: 'notification',
                level: 'warning',
                message: `Retrying: ${node.displayName} (${errMsg})`,
              });
              this.emitTodoUpdate();
            } else {
              this.log(`  FAILED: ${node.id} — ${errMsg}`);
              this.executor.markFailed(node.id, errMsg);
              this.emitTodoUpdate();
              this.emit({
                type: 'notification',
                level: 'error',
                message: `Failed: ${node.displayName} — ${errMsg}`,
              });
            }
          }
        };
        // end runOneNode

        // Bounded-concurrency dispatch. LLM-eligible nodes run up to
        // `llmConcurrency` at a time; media/deterministic nodes stay
        // serial because their resource isn't bottlenecked at the LLM
        // provider (ComfyUI / FFmpeg concurrency is managed elsewhere).
        //
        // `llmConcurrency = 1` → fully serial behavior — bit-identical
        // to the previous loop. `> 1` is only enabled when LLM_MODE=cloud
        // (see `getLLMConcurrency`).
        const llmConcurrency = this.getLLMConcurrency();
        const pendingLLM = new Set<Promise<void>>();
        for (const node of readyNodes) {
          if (this.stopped) break;

          if (llmConcurrency > 1 && this.isLLMEligibleNode(node)) {
            // Block when we'd exceed the cap — Promise.race drains
            // whichever task finishes first before we add another.
            while (pendingLLM.size >= llmConcurrency) {
              await Promise.race(pendingLLM);
            }
            let p: Promise<void>;
            const tracked = () => runOneNode(node).finally(() => pendingLLM.delete(p));
            p = tracked();
            pendingLLM.add(p);
          } else {
            await runOneNode(node);
          }
        }
        // Drain any LLM tasks still in flight before the next round of
        // ready-node discovery — dependents may be gated on outputs
        // from nodes we just fanned out.
        if (pendingLLM.size > 0) {
          await Promise.all(pendingLLM);
        }
      }

      // Await any remaining pending media before finalizing — but only
      // when the run is exiting cleanly. On a `failed` or `cancelled`
      // exit, awaiting risks hanging forever on a stuck media gen
      // (ComfyUI request that never returns) which keeps the chat UI
      // pinned to "running" indefinitely. Drop the references; whatever
      // is in flight will resolve into the void or be aborted by the
      // controller signal upstream.
      if (this.pendingMedia.size > 0) {
        if (shouldAwaitPendingMediaOnExit(this.stopReason)) {
          this.log(`Awaiting ${this.pendingMedia.size} final pending media generation(s)...`);
          await Promise.all(this.pendingMedia.values());
        } else {
          this.log(`Skipping ${this.pendingMedia.size} pending media await (stopReason=${this.stopReason}) to avoid hanging finalize`);
        }
        this.pendingMedia.clear();
      }

      // Done
      const finalProgress = this.executor.getProgress();
      const summary = this.executor.getSummary();
      this.log(`=== Execution finished ===`);
      this.log(`Progress: ${JSON.stringify(finalProgress)}`);
      this.log(`Summary: ${summary}`);

      // Settle the stop reason if the loop exited naturally without any of
      // the earlier paths (stage gate, cancel, failed) setting it.
      if (this.stopReason === null) {
        this.stopReason = this.executor.isComplete() ? 'complete'
          : finalProgress.failed > 0 ? 'failed'
          : 'complete'; // no pending, no failures — treat as complete
      }

      this.emit({
        type: 'notification',
        level: finalProgress.failed > 0 ? 'warning' : 'info',
        message: summary,
      });
      this.emit({ type: 'agent_status', status: 'completed', agentName });

      return {
        status: this.executor.isComplete() ? 'completed' : 'error',
        output: summary,
        todos: [],
        error: finalProgress.failed > 0
          ? `${finalProgress.failed} node(s) failed`
          : undefined,
      };

    } catch (error) {
      this.emit({ type: 'agent_status', status: 'completed', agentName });
      return {
        status: 'error',
        output: '',
        todos: [],
        error: String(error),
      };
    } finally {
      this.running = false;
      this.releaseProjectLock();
    }
  }

  /**
   * Get the executor instance (for external inspection/testing).
   */
  getExecutor(): DependencyGraphExecutor {
    return this.executor;
  }

  // ===========================================================================
  // Private: Prompt building
  // ===========================================================================

  /**
   * Build system + user prompts for a given node based on its artifact category.
   * Uses simple, tool-free prompts — all context is pre-loaded in inputs.
   */
  private async buildPromptForNode(
    node: ExecutionNode,
    inputs: ResolvedInputs,
  ): Promise<{ system: string; user: string; loadedSkills: string[] }> {
    const typeDef = this.config.template.artifactTypes[node.typeId];
    const category = typeDef?.category ?? 'concept';

    // Special handling for specific node types that need different prompts than their category
    // - shot_image_prompt: uses visual_ref treatment (FLUX Klein edit prompt)
    // - scene_video_prompt: uses structured JSON output for deterministic parsing
    const effectiveCategory = node.typeId === 'shot_image_prompt' ? 'visual_ref' : category;

    let systemPrompt: string;
    if (node.typeId === 'scene_shot_plan') {
      // Stage A — lightweight shot plan. All rules in scene_breakdown_plan_guide.md.
      systemPrompt = `You are a cinematic shot planner. Plan the SHOT LIST for this scene — number of shots, ordering, purpose, duration, and a one-line summary per shot. Output ONLY valid JSON.`;
    } else if (node.typeId === 'shot_breakdown') {
      // Stage B — single-shot expansion. All rules in scene_breakdown_shot_guide.md.
      systemPrompt = `You are a cinematographer expanding a single shot from a pre-approved scene plan. Output ONLY valid JSON for ONE shot object.`;
    } else if (node.typeId === 'shot_image_prompt') {
      // Minimal system prompt — all rules and JSON structure are in the guide
      // (shot_composition_guide.md) which autoresearch optimizes end-to-end
      systemPrompt = `You are an expert image prompt engineer. Output ONLY valid JSON.`;
    } else {
      systemPrompt = CATEGORY_PROMPTS[effectiveCategory] ?? CATEGORY_PROMPTS.concept;
    }

    // Inject guides/skills for relevant categories
    const loadedSkills: string[] = [];
    const needsSkills = effectiveCategory === 'visual_ref' || effectiveCategory === 'clip' || effectiveCategory === 'segment' || node.typeId === 'plot' || node.typeId === 'story' || node.typeId === 'scene_shot_plan' || node.typeId === 'shot_breakdown' || node.typeId === 'world_style' || node.typeId === 'shot_motion_directive';
    if (needsSkills) {
      const skills = this.loadSkillsForNode(node);
      if (skills.content) {
        systemPrompt += `\n\n<model_skills>\n${skills.content}\n</model_skills>`;
        loadedSkills.push(...skills.files);
      }
    }

    // Inject duration/project constraints with per-scene and per-shot specifics
    const duration = this.config.goal.preferences.duration;
    const style = this.config.goal.preferences.style;
    const allNodes = this.executor.getAllNodes();
    const sceneCount = allNodes.filter(n => n.typeId === 'scene').length;
    // Prefer the duration-first extractor's per-scene estimate over the
    // legacy `target/sceneCount` even-split. Falls back to even-split
    // when no estimate is recorded (e.g. legacy projects).
    const perSceneDurationFromBeats = node.itemId
      ? this.sceneEstimatedDurations.get(node.itemId) ?? 0
      : 0;
    const perSceneDuration = perSceneDurationFromBeats > 0
      ? perSceneDurationFromBeats
      : (duration && sceneCount > 0 ? Math.round(duration / sceneCount) : 0);

    let projectContext = '';
    const parts: string[] = [];

    if (style) {
      parts.push(`**Visual style:** ${style}`);
    }
    if (duration) {
      parts.push(`**Target video duration:** ${duration} seconds (${Math.floor(duration / 60)}m ${duration % 60}s)`);
    }

    // Scene-level: inject this scene's duration allocation. The plan stage
    // (scene_shot_plan) needs the same shot-count cap that the legacy
    // single-call scene_video_prompt got — it's the stage that decides
    // shot count, so the cap MUST land here. shot_breakdown gets it too
    // for context (e.g. so a shot can self-check its duration).
    if (node.typeId === 'scene' || node.typeId === 'scene_shot_plan' || node.typeId === 'shot_breakdown') {
      if (perSceneDuration > 0) {
        // HARD shot-count cap derived from the scene's duration budget. Each
        // shot is at least 3s (LTX 2.3 minimum), so the maximum shot count
        // that fits the budget is floor(budget / 3). Without this cap, the
        // scene_video_prompt LLM creates one shot per visual beat in the
        // prose — so a 12s scene with rich prose explodes to 18 shots ×
        // 3s = 54s, blowing the duration-first plan back up to >130s
        // total. This is a hard rule, not guidance.
        const maxShots = Math.max(1, Math.floor(perSceneDuration / 3));
        parts.push(`**This scene's duration budget:** ${perSceneDuration} seconds (HARD CAP)`);
        parts.push(
          `**Shot count:** AT MOST ${maxShots} shot${maxShots === 1 ? '' : 's'} ` +
          `(every shot needs ≥3s). Sum of shot durations MUST be ≤ ${perSceneDuration}s. ` +
          `If you have more beats than slots, MERGE related beats into one shot ` +
          `(merge a reaction into its adjacent dialogue; merge atmosphere into the action that follows). ` +
          `Do NOT exceed ${maxShots} shots — exceeding the shot count breaks the duration plan and the runtime ends up 2-4× the target.`
        );
        parts.push(
          `**Shot durations:** 3s minimum, 15s maximum. Dialogue shots MUST fit ` +
          `the full spoken line (~2.5 words/sec + 1s buffer) — shorter clips get cut off mid-sentence.`
        );
      }
      if (sceneCount > 0) {
        // Figure out which scene number this is
        const sceneNum = node.itemId?.match(/(\d+)/)?.[1] ?? '?';
        parts.push(`**Scene ${sceneNum} of ${sceneCount}**`);
      }
    }

    // scene_shot_plan / shot_breakdown: inject the canonical refId list so
    // the LLM uses exact strings for mainSubject/secondarySubject/focus refs.
    // Without this, the LLM invents IDs from prose in the scene script (e.g.
    // "Johnathan O'Hare" → `johnathan` or `johnathan_o_hare` when the
    // canonical refId is `johnathan_o'hare`). Both stages need it: Stage A
    // sets mainSubject/secondarySubject; Stage B sets perspectiveOf/focus.*.
    let availableRefsBlock = '';
    if (node.typeId === 'scene_shot_plan' || node.typeId === 'shot_breakdown') {
      const refLines: string[] = [];
      for (const n of allNodes) {
        if (!n.itemId) continue;
        if (n.typeId === 'character') refLines.push(`- character:    ${n.itemId}`);
        else if (n.typeId === 'setting') refLines.push(`- setting:     ${n.itemId}`);
        else if (n.typeId === 'object') refLines.push(`- object:      ${n.itemId}`);
      }
      if (refLines.length > 0) {
        availableRefsBlock = `\n\n<available_refs>
This is a canonical-spelling dictionary for the ENTIRE PROJECT. It is
NOT a shopping list — do NOT reference every entity here.

${refLines.join('\n')}

How to use this list:

1. **Read the scene script FIRST to determine who/what is in THIS scene.**
   Only the entities named or clearly implied by the scene's prose belong
   in this scene's JSON. A character being "available" in the project
   does not mean they appear in this scene.

2. **When an entity IS in the scene, use the EXACT refId string above**
   for mainSubject, secondarySubject, perspectiveOf, focus.primary,
   focus.background[], focus.lurking — copy verbatim, including
   apostrophes and underscores. Do not paraphrase, normalize, or "fix"
   spellings.

3. **Omit refs that aren't in the scene.**
   - \`secondarySubject\` is OPTIONAL. Only set it when the scene
     script gives a second character a pivotal dialogue/confrontation
     role. If there's no pivotal second character in THIS scene, omit
     the field entirely.
   - \`focus.primary\` names the razor-sharp subject of the shot —
     it must be something the script says is actually in that shot,
     not a random pick from the list.
   - \`focus.background[]\` and \`focus.lurking\` — same rule. Only
     include entities actually in the shot composition.

4. **If the scene needs an entity that isn't on this list** (e.g. the
   guards in a dock confrontation), describe them as PROSE in
   \`description\`/\`audio\`. Don't invent a new refId.

Examples of common failure modes to avoid:
- Inserting a refId as secondarySubject just because it's listed
  here, even though the scene script doesn't bring that character
  into the action of THIS scene.
- Setting \`focus.primary\` to a prop or object refId when the shot's
  description is about something else entirely — focus must name
  what the shot is actually about, not a random pick from this list.
</available_refs>`;
      }
    }

    // Shot-level: inject this shot's duration based on scene allocation and shot count
    if (node.typeId === 'shot_image_prompt' || node.typeId === 'shot_motion_directive' || node.typeId === 'scene_video' || node.typeId === 'scene_image') {
      // Extract scene ID from itemId (e.g., "scene_1_shot_2" → "scene_1")
      const sceneMatch = node.itemId?.match(/(scene_\d+)/);
      const sceneId = sceneMatch?.[1];

      if (sceneId && perSceneDuration > 0) {
        // Count how many shots this scene has
        const shotsInScene = allNodes.filter(n =>
          n.typeId === 'shot_image_prompt' && n.itemId?.startsWith(sceneId),
        ).length;
        const perShotDuration = shotsInScene > 0
          ? Math.round(perSceneDuration / shotsInScene)
          : perSceneDuration;

        parts.push(`**Scene:** ${sceneId} (~${perSceneDuration}s total)`);
        if (shotsInScene > 0) {
          parts.push(`**Shots in this scene:** ${shotsInScene}`);
          parts.push(`**This shot's duration:** ~${perShotDuration} seconds`);
        }
      }

      // Extract shot number for display
      const shotMatch = node.itemId?.match(/shot_(\d+)/);
      if (shotMatch) {
        parts.push(`**Shot number:** ${shotMatch[1]}`);
      }
    }

    // General pacing for other nodes
    if (parts.length === 0 && (duration || style)) {
      if (duration && sceneCount > 0) {
        parts.push(`**Scenes:** ${sceneCount} scenes, ~${perSceneDuration}s per scene`);
      }
    }

    if (parts.length > 0) {
      projectContext = `\n\n<project_constraints>\n${parts.join('\n')}\n</project_constraints>`;
    }

    const task = node.itemId
      ? `Create ${typeDef?.displayName ?? node.typeId} for "${node.itemId}"`
      : `Create ${typeDef?.displayName ?? node.typeId}`;

    // For shot_image_prompt: gather refs, filter by purpose, compute state, build hints
    let referenceImageContext = '';
    let shotContextHint = '';
    let sceneStateContext = '';
    let perspectiveContext = '';
    let focusContext = '';
    if (node.typeId === 'shot_image_prompt' && node.itemId) {
      const { buildAvailableReferences, formatReferencesForPrompt, buildShotAwareReferences, buildShotContextHint } = await import('./shotReferenceMapping.js');
      const sceneId = node.itemId.match(/(scene_\d+)/)?.[1];
      const shotNum = parseInt(node.itemId.match(/shot_(\d+)/)?.[1] ?? '0', 10);

      // Read shot from scene breakdown (for purpose filtering + state computation)
      let shotPurpose = '';
      let shotDescription = '';
      let sceneMainSubject = ''; // hoisted so the later position-continuity check can read it
      let sceneSecondarySubject = '';
      let shotContinuityRole = 'none';
      let shotPerspective = '';
      let prevShotPerspective = '';
      let shotFocusPrimary = '';
      let shotFocusBackground: string[] = [];
      let shotFocusLurking: string | null = null;
      if (sceneId) {
        const svpNode = this.executor.getNode(`scene_video_prompt:${sceneId}`);
        if (svpNode?.outputPath) {
          try {
            const svpPath = join(this.config.projectDir, svpNode.outputPath);
            let svpContent = readFileSync(svpPath, 'utf-8').trim();
            if (svpContent.startsWith('```')) {
              svpContent = svpContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
            }
            const svpJson = JSON.parse(svpContent);
            const shots = svpJson.shots ?? svpJson;
            const shot = (Array.isArray(shots) ? shots : []).find((s: any) => s.shotNumber === shotNum);
            if (shot) {
              shotPurpose = shot.purpose || '';
              shotDescription = `Shot ${shotNum}: ${shot.description || ''}. Camera: ${shot.cameraWork || ''}. Purpose: ${shotPurpose || 'unknown'}.`;
              shotContinuityRole = shot.continuityRole || 'none';
              shotPerspective = shot.perspective || '';
            }
            // Look up previous shot's perspective too (for mode hint)
            const prevShot = (Array.isArray(shots) ? shots : []).find((s: any) => s.shotNumber === shotNum - 1);
            if (prevShot) {
              prevShotPerspective = prevShot.perspective || '';
            }

            // Perspective block — whose POV is this shot from
            const mainSubject: string = svpJson.mainSubject || '';
            sceneMainSubject = mainSubject;
            const secondarySubject: string = svpJson.secondarySubject || '';
            sceneSecondarySubject = secondarySubject;
            const perspective: string = shot?.perspective || '';
            const perspectiveOf: string = shot?.perspectiveOf || (perspective === 'main_subject' ? mainSubject : perspective === 'secondary_subject' ? secondarySubject : '');
            if (perspective) {
              const parts = [`perspective: ${perspective}`];
              if (perspectiveOf) parts.push(`perspectiveOf: ${perspectiveOf}`);
              if (mainSubject) parts.push(`scene_mainSubject: ${mainSubject}`);
              if (secondarySubject) parts.push(`scene_secondarySubject: ${secondarySubject}`);
              perspectiveContext = `\n\n<shot_perspective>\n${parts.join('\n')}\n\nYour prose MUST reflect this viewpoint (see Perspective → Framing Bias in your guide).\n</shot_perspective>`;
            }

            // Focus block — what's sharp vs blurred
            const focus = shot?.focus;
            if (focus?.primary) {
              shotFocusPrimary = focus.primary;
              shotFocusBackground = Array.isArray(focus.background) ? focus.background : [];
              shotFocusLurking = focus.lurking ?? null;
              const parts = [`primary (sharp): ${focus.primary}`];
              if (shotFocusBackground.length > 0) {
                parts.push(`background (blurred): ${shotFocusBackground.join(', ')}`);
              }
              if (focus.lurking) {
                parts.push(`lurking (defocused, planted for later): ${focus.lurking}`);
              }
              focusContext = `\n\n<shot_focus>\n${parts.join('\n')}\n\nYour prose MUST name what is sharp AND what is blurred (see Focus Rules in your guide).\n</shot_focus>`;
            }
          } catch { /* scene breakdown not readable */ }
        }
      }

      // Gather all refs, then narrow to THIS shot's references using
      // mainSubject + focus from the scene_video_prompt JSON. This pins the
      // Flux 4-slot contract: at most 4 refs, slot 1 = setting, no global
      // imageNumbers leaking in (which used to produce "from image 8" prose).
      const { refs: allRefs } = buildAvailableReferences(this.executor);

      // Compute scene-canonical setting (most common setting across all
      // shots in this scene). Used as a fallback when this shot's own
      // focus doesn't name a setting — see ShotContext.canonicalSceneSetting.
      let canonicalSceneSetting: string | null = null;
      if (sceneId) {
        const svpNode2 = this.executor.getNode(`scene_video_prompt:${sceneId}`);
        if (svpNode2?.outputPath) {
          try {
            const svpPath2 = join(this.config.projectDir, svpNode2.outputPath);
            if (existsSync(svpPath2)) {
              let raw2 = readFileSync(svpPath2, 'utf-8').trim();
              if (raw2.startsWith('```')) raw2 = raw2.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
              const svp2 = JSON.parse(raw2);
              const counts = new Map<string, number>();
              for (const sh of svp2.shots ?? []) {
                if (typeof sh?.setting === 'string' && sh.setting) counts.set(sh.setting, (counts.get(sh.setting) ?? 0) + 1);
                const bg2 = Array.isArray(sh?.focus?.background) ? sh.focus.background : [];
                for (const b of bg2) if (typeof b === 'string') counts.set(b, (counts.get(b) ?? 0) + 1);
              }
              const settingLabels = new Set(allRefs.filter(r => r.type === 'setting').map(r => r.label));
              let bestN = 0;
              for (const [refId, n] of counts.entries()) {
                if (settingLabels.has(refId) && n > bestN) { canonicalSceneSetting = refId; bestN = n; }
              }
            }
          } catch { /* keep null */ }
        }
      }

      const shotRefs = buildShotAwareReferences(allRefs, {
        mainSubject: sceneMainSubject,
        secondarySubject: sceneSecondarySubject,
        focusPrimary: shotFocusPrimary,
        focusBackground: shotFocusBackground,
        focusLurking: shotFocusLurking,
        purpose: shotPurpose,
        canonicalSceneSetting,
      });
      referenceImageContext = formatReferencesForPrompt(shotRefs);
      this.log(`  Refs (shot-aware) for ${node.itemId}: ${allRefs.length} global → ${shotRefs.length} in-shot (purpose=${shotPurpose || 'unknown'})`);

      // Inject canonical character physical descriptions into the
      // shot_image_prompt LLM context. Without this, the LLM only sees
      // refIds like `character_image:malachor` and invents physical
      // attributes that contradict the character ref (boundary-test on
      // 2026-05-23 rendered Malachor as a Black man when his ref doc
      // says white with a scar — Klein followed the prose, breaking
      // character continuity across the scene). The block lists the
      // canonical Physical Description paragraph from each character's
      // profile so the LLM can't drift on race / hair / clothing /
      // distinguishing features.
      try {
        const { buildCharacterDescriptionsForImagePrompt } = await import('./characterVisualTags.js');
        const charsForBlock: Array<{ refId: string; mdPath: string }> = [];
        for (const ref of shotRefs) {
          if (ref.type !== 'character') continue;
          const itemId = ref.refId.replace(/^character_image:/, '');
          const charNode = this.executor.getNode(`character:${itemId}`);
          const outPath = charNode?.outputPath;
          if (outPath) {
            charsForBlock.push({ refId: ref.refId, mdPath: join(this.config.projectDir, outPath) });
          }
        }
        const descBlock = buildCharacterDescriptionsForImagePrompt(charsForBlock);
        if (descBlock) {
          // Append to referenceImageContext so it travels with the refs
          // — no schema change needed downstream.
          referenceImageContext += descBlock;
          this.log(`  Injected character_descriptions for ${charsForBlock.length} char(s) into ${node.itemId}`);
        }
      } catch (err) {
        this.log(`  Failed to inject character descriptions: ${(err as Error).message}`);
      }

      // Shot context hint. Layer C2: cross-scene chain — when this is shot 1
      // of scene N>1, look at scene N-1's last completed shot so the LLM
      // knows it has a base to chain on.
      const { getPreviousShotIdAcrossScenes } = await import('./crossShotChaining.js');
      const priorShotItemId = node.itemId
        ? getPreviousShotIdAcrossScenes(node.itemId, this.executor)
        : null;
      const prevNode = priorShotItemId
        ? this.executor.getNode(`shot_image:${priorShotItemId}`)
        : null;
      const previousAvailable = prevNode?.status === 'completed';
      shotContextHint = buildShotContextHint(node.itemId, previousAvailable, {
        currentPerspective: shotPerspective,
        previousPerspective: prevShotPerspective,
        continuityRole: shotContinuityRole,
        purpose: shotPurpose,
      });

      // Layer B2: feed the prior shot's last_frame TEXT into the LLM
      // context. The editor already sees the prior last_frame *image*; the
      // text anchor stops the writer from drifting into a fresh
      // composition that contradicts the base. Mirrors the per-shot
      // edit_previous_shot directive — the writer should produce a delta,
      // not a new scene.
      if (sceneId && shotNum > 1) {
        const { readPriorLastFrameText } = await import('./shotReferenceMapping.js');
        const priorLF = readPriorLastFrameText(this.config.projectDir, sceneId, shotNum);
        if (priorLF) {
          shotContextHint += `\n\n<prior_last_frame>\nThe previous shot's last frame is the base canvas for THIS shot's first frame. Its prose was:\n\n"${priorLF}"\n\nWrite this shot's first_frame as a DELTA from that exact composition — same setting, same character positions unless explicitly changing — only the camera angle/framing or character motion you describe in the shot description should differ. Do NOT re-describe the setting from scratch.\n</prior_last_frame>`;
        }
      }

      // Compute target state BEFORE generating image prompt
      if (sceneId) {
        try {
          const { loadSceneState, initializeSceneState, saveSceneState, formatStateForPrompt, buildStateContext } = await import('./sceneState.js');

          let previousState = loadSceneState(this.config.projectDir, sceneId);
          if (!previousState) {
            // Scope the initial character list to characters actually referenced
            // in THIS scene — previously we seeded every character in the graph,
            // which caused Glitch (apartment cat) to leak into the bar scene
            // and get rendered as a humanoid. Source of truth: the
            // scene_video_prompt JSON's mainSubject/secondarySubject and every
            // focus.* ref across all shots.
            const sceneCharRefIds = this.extractSceneCharacterRefs(sceneId);
            const allCharacters = this.executor.getAllNodes()
              .filter((n: any) => n.typeId === 'character' && n.itemId);
            const sceneCharacters = sceneCharRefIds.length > 0
              ? allCharacters.filter((n: any) => sceneCharRefIds.includes(n.itemId))
              : allCharacters; // Fallback: if parse failed, use everyone (legacy behavior)
            const charInits = sceneCharacters.map((n: any) => ({
              refId: n.itemId!,
              kind: this.inferCharacterKind(n.itemId),
            }));
            const settingNode = this.executor.getAllNodes()
              .find((n: any) => n.typeId === 'setting_image' && n.itemId);
            const setting = settingNode?.itemId ?? '';
            previousState = initializeSceneState(sceneId, charInits, setting);
            this.log(`  Scene state init (${sceneId}): ${charInits.length} character(s): ${charInits.map(c => `${c.refId}[${c.kind}]`).join(', ')}`);
          }

          if (shotDescription) {
            this.log(`  Computing target state for ${node.itemId}...`);
            const stateCtx = await buildStateContext(this.llmFor('structured.scene_state'), previousState, shotDescription);
            sceneStateContext = stateCtx.promptContext;

            if (stateCtx.targetState) {
              stateCtx.targetState.sceneId = sceneId;
              stateCtx.targetState.shotNumber = shotNum;

              // Option 2 continuity check — LLM judges whether the main subject teleported.
              // Runs after state extraction, before save, so the warning is associated with the fresh pair.
              try {
                const warning = await checkPositionContinuity(
                  previousState,
                  stateCtx.targetState,
                  sceneMainSubject,
                  shotContinuityRole,
                  shotNum,
                  this.llmFor('utility.continuity_check'),
                );
                if (warning) {
                  this.log(`  [Continuity position] ${warning.message}${warning.suggestion ? ` — ${warning.suggestion}` : ''}`);
                  // Auto-reroll: inject a bridging hint into THIS generation's
                  // context so the LLM produces a non-teleporting composition.
                  // Tracked per-node to avoid stacking hints on re-runs.
                  const decision = shouldRerollShot(warning);
                  if (decision.reroll && !this.retriedContinuity.has(node.id)) {
                    this.retriedContinuity.add(node.id);
                    sceneStateContext += decision.hint;
                    this.log(`  [Continuity auto-reroll] Injected bridging hint for ${node.id}`);
                    this.emit({
                      type: 'notification',
                      level: 'warning',
                      message: `Continuity: bridging hint added for ${node.id} (shot ${shotNum})`,
                    });
                  }
                }
              } catch (err) {
                this.log(`  [Continuity position] skipped: ${(err as Error).message}`);
              }

              saveSceneState(this.config.projectDir, sceneId, stateCtx.targetState);
              // Save per-shot diff so motion directive can read it
              const { saveShotStateDiff, buildLastFrameChanges } = await import('./sceneState.js');
              saveShotStateDiff(this.config.projectDir, sceneId, shotNum, previousState, stateCtx.targetState);
              // Inject last_frame_changes so the LLM knows what must differ in the last frame
              sceneStateContext += buildLastFrameChanges(previousState, stateCtx.targetState);
              this.log(`  Target state saved for ${sceneId} shot ${shotNum}`);

              // Show BEFORE + TARGET state cards in UI
              const agentName = this.config.name ?? 'dhee-executor';
              const beforeCallId = `state_before_${node.itemId}_${Date.now()}`;
              this.emit({ type: 'tool_call', toolCallId: beforeCallId, toolName: 'scene_state', arguments: { shot: node.itemId, phase: 'BEFORE' }, agentName });
              this.emit({ type: 'tool_streaming', toolCallId: beforeCallId, chunk: formatStateForPrompt(previousState), done: true, agentName, toolName: 'scene_state' });
              this.emit({ type: 'tool_result', toolCallId: beforeCallId, toolName: 'scene_state', result: { phase: 'before', state: previousState }, agentName });

              const targetCallId = `state_target_${node.itemId}_${Date.now()}`;
              this.emit({
                type: 'tool_call',
                toolCallId: targetCallId,
                toolName: 'scene_state',
                arguments: {
                  shot: node.itemId,
                  phase: 'TARGET',
                  model: this.modelFor('structured.scene_state'),
                },
                agentName,
              });
              const targetText = stateCtx.diff
                ? `CHANGES:\n${stateCtx.diff}\n\n---\nTARGET STATE:\n${formatStateForPrompt(stateCtx.targetState)}`
                : `No changes\n\n${formatStateForPrompt(stateCtx.targetState)}`;
              this.emit({ type: 'tool_streaming', toolCallId: targetCallId, chunk: targetText, done: true, agentName, toolName: 'scene_state' });
              this.emit({ type: 'tool_result', toolCallId: targetCallId, toolName: 'scene_state', result: { phase: 'target', diff: stateCtx.diff, state: stateCtx.targetState }, agentName });
            }
          } else if (previousState.shotNumber > 0) {
            // No shot description — inject previous state only
            sceneStateContext = `\n\n<scene_state>\n${formatStateForPrompt(previousState)}\n\nYour shot MUST be consistent with this state.\n</scene_state>`;
          }
        } catch { /* state not available yet */ }
      }
    }

    // For shot_motion_directive: inject state delta (what needs to MOVE)
    // The shot_image_prompt step saved a state diff file we can read
    let characterTagsBlock = '';
    if (node.typeId === 'shot_motion_directive' && node.itemId) {
      try {
        const { loadShotStateDiff, buildMotionStateContext } = await import('./sceneState.js');
        const sceneId = node.itemId.match(/(scene_\d+)/)?.[1];
        const shotNum = parseInt(node.itemId.match(/shot_(\d+)/)?.[1] ?? '0', 10);
        if (sceneId) {
          const shotDiff = loadShotStateDiff(this.config.projectDir, sceneId, shotNum);
          if (shotDiff) {
            sceneStateContext = buildMotionStateContext(shotDiff.previous, shotDiff.target);
            this.log(`  Motion directive: injected state delta for shot ${shotNum}`);
          }
        }

        // Inject short visual tags for every character visible in this
        // shot when there are 2+ of them. Video models have no idea who
        // "Parvati" or "Isha" are — naming them bare produces an
        // unresolved token and the model invents someone new. Tags like
        // "the older woman in faded blue salwar" disambiguate across
        // characters while still being compact.
        const shotImagePromptNode = this.executor.getNode(`shot_image_prompt:${node.itemId}`);
        if (shotImagePromptNode?.outputPath) {
          const promptPath = join(this.config.projectDir, shotImagePromptNode.outputPath);
          if (existsSync(promptPath)) {
            try {
              let raw = readFileSync(promptPath, 'utf-8').trim();
              if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
              const shotJson = JSON.parse(raw);
              // Pull the union of character refs across all frames —
              // last_frame sometimes lists chars that left the frame
              // mid-shot, which still need tagging if first_frame has them.
              const frames = shotJson.frames ?? {};
              const charRefIds = new Set<string>();
              for (const f of Object.values(frames) as Array<{ references?: Array<{ type?: string; refId?: string }> }>) {
                for (const r of f?.references ?? []) {
                  if (r?.type === 'character' && typeof r.refId === 'string') {
                    const itemId = r.refId.replace(/^character_image:/, '');
                    if (itemId) charRefIds.add(itemId);
                  }
                }
              }

              if (charRefIds.size >= 2) {
                const { buildCharacterTagsBlock } = await import('./characterVisualTags.js');
                const chars: Array<{ refId: string; mdPath: string }> = [];
                for (const refId of charRefIds) {
                  const charNode = this.executor.getNode(`character:${refId}`);
                  const outPath = charNode?.outputPath;
                  if (outPath) {
                    chars.push({ refId, mdPath: join(this.config.projectDir, outPath) });
                  }
                }
                characterTagsBlock = buildCharacterTagsBlock(chars);
                if (characterTagsBlock) {
                  this.log(`  Motion directive: injected character tags for ${chars.length} char(s)`);
                }
              }
            } catch { /* shot image prompt unreadable — skip tags */ }
          }
        }
      } catch { /* state not available */ }
    }

    // For shot_motion_directive: surface this shot's dialogue/ambient
    // (from scene_video_prompt's per-shot `audio` field) directly into
    // the user message so the LLM doesn't have to dig it out — earlier
    // probes proved soft "if there's dialogue" guide-text was being
    // ignored. Also inject the narration directive (from StoryEssence)
    // so the LLM optionally adds narrator lines per the project's
    // narration mode/voice.
    let shotAudioBlock = '';
    let shotNarrationBlock = '';
    if (node.typeId === 'shot_motion_directive' && node.itemId) {
      try {
        const sceneId = node.itemId.match(/(scene_\d+)/)?.[1];
        const shotNum = parseInt(node.itemId.match(/shot_(\d+)/)?.[1] ?? '0', 10);
        if (sceneId && shotNum > 0) {
          const svpPath = join(this.config.projectDir, `prompts/videos/scenes/${sceneId}.json`);
          if (existsSync(svpPath)) {
            try {
              const svp = JSON.parse(readFileSync(svpPath, 'utf-8'));
              const shot = (svp.shots ?? []).find((s: { shotNumber?: number }) => s.shotNumber === shotNum);
              if (shot && typeof shot.audio === 'string') {
                shotAudioBlock = buildShotAudioBlock(shot.audio);
                if (shotAudioBlock) {
                  this.log(`  Motion directive: injected <shot_audio> block for shot ${shotNum}`);
                }
              }
            } catch { /* svp unreadable — skip */ }
          }
        }
      } catch { /* defensive */ }
      if (this.storyEssence?.narration) {
        shotNarrationBlock = buildShotNarrationDirective(this.storyEssence.narration);
        if (shotNarrationBlock) {
          this.log(`  Motion directive: injected <narration> directive (mode=${this.storyEssence.narration.mode})`);
        }
      }
    }
    const motionAudioContext = (shotAudioBlock || shotNarrationBlock)
      ? `\n\n${[shotAudioBlock, shotNarrationBlock].filter(Boolean).join('\n\n')}`
      : '';

    // Bharata cues block. For shot_image_prompt + shot_motion_directive nodes,
    // read scene.rasa from the scene_video_prompt JSON and per-shot
    // sattvika/drishti/vyabhichariBhava tags, compose the deterministic
    // palette/lighting/cue strings via rasaModifiers, and inject as a
    // <bharata_cues> block in the user message. The image/motion guides
    // instruct the LLM to surface these tokens in their output.
    let bharataCuesBlock = '';
    if (
      (node.typeId === 'shot_image_prompt' || node.typeId === 'shot_motion_directive') &&
      node.itemId
    ) {
      const sceneId = node.itemId.match(/(scene_\d+)/)?.[1];
      const shotNum = parseInt(node.itemId.match(/shot_(\d+)/)?.[1] ?? '0', 10);
      if (sceneId && shotNum > 0) {
        const svpNode = this.executor.getNode(`scene_video_prompt:${sceneId}`);
        if (svpNode?.outputPath) {
          try {
            const svpPath = join(this.config.projectDir, svpNode.outputPath);
            if (existsSync(svpPath)) {
              let raw = readFileSync(svpPath, 'utf-8').trim();
              if (raw.startsWith('```')) {
                raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
              }
              const svp = JSON.parse(raw);
              const shot = (Array.isArray(svp.shots) ? svp.shots : [])
                .find((s: { shotNumber?: number }) => s.shotNumber === shotNum);
              const rasa = svp.rasa ?? null;
              const sattvika = shot?.sattvika ?? null;
              const drishti = shot?.drishti ?? null;
              const vyabhichari = shot?.vyabhichariBhava ?? null;
              if (rasa || sattvika || drishti || vyabhichari) {
                const { RASA_MODIFIERS, composeBharataCues } = await import('./rasaModifiers.js');
                const lines: string[] = [];
                if (rasa && rasa in RASA_MODIFIERS) {
                  const m = RASA_MODIFIERS[rasa as keyof typeof RASA_MODIFIERS];
                  lines.push(`scene rasa: ${rasa}`);
                  lines.push(`palette: ${m.paletteTokens}`);
                  lines.push(`lighting: ${m.lightingKey}`);
                  if (node.typeId === 'shot_motion_directive') {
                    lines.push(`camera bias: ${m.cameraBias}`);
                    lines.push(`lens preference: ${m.lensPreference}`);
                  }
                  if (m.negativePrompt) lines.push(`negative-prompt fragment: ${m.negativePrompt}`);
                }
                const cues = composeBharataCues({ sattvika, drishti, vyabhichariBhava: vyabhichari });
                if (cues) lines.push(`per-shot physical cues: ${cues}`);
                if (lines.length > 0) {
                  bharataCuesBlock = `\n\n<bharata_cues>\n${lines.join('\n')}\n</bharata_cues>\n\nSurface these palette/lighting tokens AND physical cues in your output. The cues are explicit directives, not optional flavor — a tag without prose presence is silently lost.`;
                  this.log(`  Injected bharata_cues for ${node.itemId}: rasa=${rasa} sattvika=${sattvika} drishti=${drishti} vyabhichari=${vyabhichari}`);
                }
              }
            }
          } catch (err) {
            this.log(`  bharata_cues: failed to read SVP for ${node.itemId}: ${(err as Error).message}`);
          }
        }
      }
    }

    // Render-style anchor for shot_image_prompt nodes. Closes the
    // 2026-05-19 Soft Seinen gap where project.style='anime' didn't
    // reach the shot prompt's leading clause — character_image_guide
    // had its own anchor, but shot_composition_guide didn't, so Flux
    // Klein produced photorealistic shots opening on style-neutral
    // clauses ("A wide overhead shot of Tokyo's night skyline…"). The
    // helper produces an EXACT anchor string the LLM is told to paste
    // verbatim at the start of every positive prompt, plus the
    // anti-modality negative tokens. See renderStyleAnchor.ts.
    let renderStyleAnchorBlock = '';
    if (node.typeId === 'shot_image_prompt') {
      const { buildRenderStyleAnchorBlock } = await import('../prompts/renderStyleAnchor.js');
      renderStyleAnchorBlock = buildRenderStyleAnchorBlock(style ?? null);
    }

    // For scene nodes: inject scene_assignment with summaries and boundaries
    let sceneAssignment = '';
    if (node.typeId === 'scene' && node.itemId && this.sceneSummaries.size > 0) {
      const mySceneId = node.itemId;
      const mySummary = this.sceneSummaries.get(mySceneId) || '';
      const myTitle = node.displayName.replace(/^Scenes:\s*/, '');

      const allSummaries = [...this.sceneSummaries.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, summary]) => {
          const num = id.replace('scene_', '');
          const title = this.executor.getNode(`scene:${id}`)?.displayName?.replace(/^Scenes:\s*/, '') || id;
          return `Scene ${num}: "${title}" — ${summary}`;
        })
        .join('\n');

      sceneAssignment = `\n\n<scene_assignment>\nYOUR SCENE: ${mySceneId} — "${myTitle}"\nSUMMARY: ${mySummary}\n\nYou must ONLY write content for the beats described in YOUR SUMMARY above.\nDo NOT include events, dialogue, or climactic moments from other scenes.\n\nALL SCENES IN THIS VIDEO (for context only — write ONLY yours):\n${allSummaries}\n</scene_assignment>`;
      this.log(`  Injected scene_assignment for ${mySceneId} (${mySummary.substring(0, 50)}...)`);
    }

    // Inject the editorial-intent block for scene-prose generation so
    // the LLM tunes voice / pacing / register to match the kind of
    // story being told. Empty string when essence isn't loaded —
    // additive only, never breaks existing prose generation.
    let storyEssenceBlock = '';
    if (node.typeId === 'scene' && this.storyEssence) {
      storyEssenceBlock = buildStoryEssenceBlock(this.storyEssence);
      if (storyEssenceBlock) {
        this.log(`  Injected story-essence block (genre=${this.storyEssence.genre})`);
      }
    }

    // For shot_breakdown (Stage B of hierarchical breakdown): inject the
    // full scene plan as <scene_plan> (so the LLM has continuity context
    // for what shots come before / after) and the single plan entry for
    // THIS shot as <this_shot>. Without these blocks the per-shot LLM
    // would see only the scene script and have no idea where this shot
    // sits in the sequence.
    let shotBreakdownPlanBlock = '';
    if (node.typeId === 'shot_breakdown' && node.itemId) {
      const sceneId = node.itemId.match(/(scene_\d+)/)?.[1];
      const shotNum = parseInt(node.itemId.match(/shot_(\d+)/)?.[1] ?? '0', 10);
      if (sceneId && shotNum > 0) {
        const planNode = this.executor.getNode(`scene_shot_plan:${sceneId}`);
        if (planNode?.outputPath) {
          try {
            const planPath = join(this.config.projectDir, planNode.outputPath);
            let planContent = readFileSync(planPath, 'utf-8').trim();
            if (planContent.startsWith('```')) {
              planContent = planContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
            }
            const planJson = JSON.parse(planContent);
            const thisEntry = (planJson.shotPlan ?? []).find((p: { shotNumber?: number }) => p.shotNumber === shotNum);
            const thisEntryStr = thisEntry ? JSON.stringify(thisEntry, null, 2) : `(no plan entry found for shotNumber ${shotNum})`;
            shotBreakdownPlanBlock = `\n\n<scene_plan>\n${planContent}\n</scene_plan>\n\n<this_shot>\n${thisEntryStr}\n</this_shot>\n\nExpand THIS shot only. Copy shotNumber, purpose, and duration verbatim from <this_shot>. Use <scene_plan> for continuity context (what comes before / after).`;
            this.log(`  shot_breakdown: injected scene_plan (${(planJson.shotPlan ?? []).length} shots) + this_shot for ${node.itemId}`);
          } catch (err) {
            this.log(`  shot_breakdown: failed to read scene plan for ${node.itemId}: ${(err as Error).message}`);
          }
        }
      }
    }

    // Hard post-anchor for Stage A/B (scene_shot_plan + shot_breakdown):
    // forces the model to ground every refId in the scene script + the
    // canonical <available_refs> block — never in the demonstration
    // tokens it just saw inside the loaded skill guides. See
    // buildOutputContractBlock.ts for the rationale and full text.
    const outputContractBlock = buildOutputContractBlock(node.typeId);

    const user = inputs.contextBlock
      ? `${task}${projectContext}${availableRefsBlock}${referenceImageContext}${sceneStateContext}${characterTagsBlock}${perspectiveContext}${focusContext}${shotContextHint}${storyEssenceBlock}${sceneAssignment}${motionAudioContext}${shotBreakdownPlanBlock}${bharataCuesBlock}${renderStyleAnchorBlock}\n\n${inputs.contextBlock}${outputContractBlock}`
      : `${task}${projectContext}${availableRefsBlock}${referenceImageContext}${sceneStateContext}${characterTagsBlock}${perspectiveContext}${focusContext}${shotContextHint}${storyEssenceBlock}${sceneAssignment}${motionAudioContext}${shotBreakdownPlanBlock}${bharataCuesBlock}${renderStyleAnchorBlock}${outputContractBlock}`;

    return { system: systemPrompt, user, loadedSkills };
  }

  /**
   * Extract the list of character refIds referenced in this scene's
   * breakdown (scene_video_prompt JSON). Used to scope the initial
   * scene state to actual scene participants — Glitch (apartment cat)
   * must not be seeded into the bar scene's state. Reads `mainSubject`,
   * `secondarySubject`, `perspectiveOf`, and every `focus.*` ref across
   * all shots, then filters to refIds that exist as `character:*` nodes.
   *
   * Returns an empty array if the scene breakdown can't be read — caller
   * falls back to legacy all-characters behavior.
   */
  private extractSceneCharacterRefs(sceneId: string): string[] {
    const svpNode = this.executor.getNode(`scene_video_prompt:${sceneId}`);
    if (!svpNode?.outputPath) return [];
    try {
      const path = join(this.config.projectDir, svpNode.outputPath);
      if (!existsSync(path)) return [];
      let raw = readFileSync(path, 'utf-8').trim();
      if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      const svp = JSON.parse(raw);

      const refs = new Set<string>();
      if (typeof svp.mainSubject === 'string') refs.add(svp.mainSubject);
      if (typeof svp.secondarySubject === 'string') refs.add(svp.secondarySubject);

      const shots = Array.isArray(svp.shots) ? svp.shots : [];
      for (const shot of shots) {
        if (typeof shot.perspectiveOf === 'string') refs.add(shot.perspectiveOf);
        const focus = shot.focus ?? {};
        if (typeof focus.primary === 'string') refs.add(focus.primary);
        if (typeof focus.lurking === 'string') refs.add(focus.lurking);
        if (Array.isArray(focus.background)) {
          for (const bg of focus.background) if (typeof bg === 'string') refs.add(bg);
        }
      }

      // Filter to refIds that exist as character nodes (drops settings,
      // objects, and prose-like entries such as "rifle_sights" or
      // "whiskey_glass" that share the focus field).
      const validCharRefs = new Set(
        this.executor.getAllNodes()
          .filter(n => n.typeId === 'character' && n.itemId)
          .map(n => n.itemId!)
      );
      return [...refs].filter(r => validCharRefs.has(r));
    } catch (err) {
      this.log(`  extractSceneCharacterRefs(${sceneId}) failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Infer whether a character is human or animal by reading their
   * character.md file for animal-indicator keywords (cat, dog, feline,
   * canine, horse, etc.). Falls back to 'unknown' if the file is
   * unreadable or ambiguous.
   *
   * 'unknown' is treated like 'human' by the state tracker (preserving
   * the pre-fix schema). 'animal' unlocks the quadruped schema path —
   * no leftHand/rightHand/legs/headTilt fields.
   */
  private inferCharacterKind(refId: string): 'human' | 'animal' | 'unknown' {
    const charNode = this.executor.getNode(`character:${refId}`);
    if (!charNode?.outputPath) return 'unknown';
    try {
      const path = join(this.config.projectDir, charNode.outputPath);
      if (!existsSync(path)) return 'unknown';
      const text = readFileSync(path, 'utf-8').toLowerCase();

      // Animal indicators. Strong signal — checking for any of these near
      // the top of the profile or in the physical description is enough.
      const animalKeywords = [
        'synthetic cat', 'robotic cat', 'cybernetic cat',
        ' cat ', ' feline ', ' kitten ',
        ' dog ', ' puppy ', ' canine ',
        ' horse ', ' mare ', ' stallion ',
        'tortoiseshell', 'whisker',
      ];
      for (const kw of animalKeywords) {
        if (text.includes(kw)) return 'animal';
      }
      // Default: humanoid. Most profiles describe humans and don't need
      // an explicit "human" marker.
      return 'human';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Load skill guides and model-specific skills for a node.
   * Returns combined skill content or null if none found.
   */
  private loadSkillsForNode(node: ExecutionNode): { content: string | null; files: string[] } {
    const parts: string[] = [];
    const loadedFiles: string[] = [];

    // Map node types to guide names and content types for skill resolution.
    //
    // Hierarchical scene-breakdown flow:
    //  - scene_shot_plan (Stage A) → scene_breakdown_plan_guide
    //  - shot_breakdown  (Stage B) → scene_breakdown_shot_guide
    //  - scene_video_prompt (Stage C, deterministic) — no guide; no LLM call
    const guideMap: Record<string, string> = {
      plot: 'plot_guide',
      story: 'screenplay_guide',
      character_image: 'character_image_guide',
      setting_image: 'setting_image_guide',
      shot_image_prompt: 'shot_composition_guide',
      scene_shot_plan: 'scene_breakdown_plan_guide',
      shot_breakdown: 'scene_breakdown_shot_guide',
      shot_video: 'scene_video_guide',
      scene: 'scene_guide',
      world_style: 'world_style_guide',
      shot_motion_directive: 'motion_directive_guide',
    };

    // Content type names for skill file resolution
    const contentTypeMap: Record<string, string> = {
      character_image: 'character_image_prompt',
      setting_image: 'setting_image_prompt',
      shot_image_prompt: 'shot_image_prompt',
      scene_shot_plan: 'scene_video_prompt',
      shot_breakdown: 'scene_video_prompt',
      shot_video: 'scene_video_prompt',
    };

    // 1. Load default guide (universal rules)
    const guideName = guideMap[node.typeId];
    if (guideName) {
      try {
        const guide = resolveGuide(guideName, contentTypeMap[node.typeId] ?? node.typeId);
        if (guide.content) {
          parts.push(guide.content);
          loadedFiles.push(guide.source);
          this.log(`  Loaded guide: ${guide.source}`);
        }
      } catch {
        // Guide not found — non-fatal
      }
    }

    // 2. Load model-specific skills (layered on top of guide)
    const contentType = contentTypeMap[node.typeId];
    if (contentType) {
      // Map node types to their expected workflow for skill file resolution
      // character/setting images → zimage (text-to-image generation)
      // scene/shot images → flux2_klein_edit (image editing with references)
      // video → ltx23
      const workflowMap: Record<string, string> = {
        character_image: 'zimage',
        setting_image: 'zimage',
        shot_image_prompt: 'flux2_klein_edit',
        // scene_video_prompt does NOT need a workflow-specific skill — it plans shots, not video
        shot_video: 'ltx23',
      };

      let skillContext: SkillResolutionContext | undefined;
      const workflowName = workflowMap[node.typeId];

      // Try provider registry first, fall back to hardcoded defaults
      try {
        const config = getProviderRegistry().getConfig();
        const isVideo = node.typeId.includes('video');
        const providerId = isVideo ? config.videoGeneration : config.imageGeneration;
        if (providerId) {
          skillContext = { providerId, workflowName };
        }
      } catch {
        // Provider registry not available — use comfyui as default
        if (workflowName) {
          skillContext = { providerId: 'comfyui', workflowName };
        }
      }

      const skills = loadContentTypeSkills(contentType, skillContext);
      if (skills.content) {
        parts.push(skills.content);
        loadedFiles.push(...skills.loadedFiles);
        this.log(`  Loaded skills: ${skills.loadedFiles.join(', ')}`);
      }
    }

    // Substitute dynamic placeholders in loaded content
    let combined = parts.length > 0 ? parts.join('\n\n') : null;
    if (combined) {
      combined = this.substituteDynamicPlaceholders(combined);
    }

    return {
      content: combined,
      files: loadedFiles,
    };
  }

  /**
   * Replace {{PLACEHOLDER}} tokens in guide/skill content with dynamic values
   * from the WorkflowModeRegistry. This ensures the LLM only sees modes
   * available for the currently active provider.
   */
  private substituteDynamicPlaceholders(content: string): string {
    if (!content.includes('{{')) return content;

    try {
      const modeRegistry = getWorkflowModeRegistry();

      // Determine the active video provider
      let providerId = 'comfyui';
      try {
        const config = getProviderRegistry().getConfig();
        providerId = config.videoGeneration || 'comfyui';
      } catch { /* default to comfyui */ }

      content = content.replace('{{AVAILABLE_VIDEO_MODES}}', modeRegistry.generateVideoModesSection(providerId));
      content = content.replace('{{AVAILABLE_PROCESSING_MODES}}', modeRegistry.generateProcessingModesSection(providerId));
      content = content.replace('{{FRAME_GENERATION_GUIDE}}', modeRegistry.generateFrameGuideSection(providerId));
    } catch (err) {
      // Registry not available — leave placeholders as-is (they'll be visible but harmless)
      this.log(`  Warning: could not substitute dynamic placeholders: ${err}`);
    }

    return content;
  }

  // ===========================================================================
  // Private: Tool display helpers
  // ===========================================================================

  /**
   * Check if a prompt file already exists on disk for a media node.
   * Returns the relative path if found, null otherwise.
   */
  /**
   * Repair missing nodes in the graph. If a node references a dependency
   * that doesn't exist, recreate it from the template definition.
   * This fixes graph corruption from manual resets or incomplete expansions.
   */
  private repairMissingNodes(): void {
    const allNodes = this.executor.getAllNodes();
    let repaired = 0;

    for (const node of allNodes) {
      const newDeps = [...node.dependencies];
      let changed = false;

      for (let i = 0; i < newDeps.length; i++) {
        const depId = newDeps[i]!;
        if (this.executor.getNode(depId)) continue; // dependency exists, fine

        // Missing dependency — check if per-item nodes exist (expanded in previous session)
        const colonIdx = depId.indexOf(':');
        const typeId = colonIdx >= 0 ? depId.slice(0, colonIdx) : depId;
        const itemId: string | undefined = colonIdx >= 0 ? depId.slice(colonIdx + 1) : undefined;

        // Look for per-item nodes that match this type+item prefix
        const expandedNodes = allNodes.filter(n =>
          n.typeId === typeId && n.itemId && itemId && n.itemId.startsWith(itemId + '_'),
        );

        if (expandedNodes.length > 0) {
          // The type-level node was expanded into per-item nodes in a previous session.
          // Rewire: replace the stale dep with all per-item nodes.
          this.log(`  Rewiring ${node.id}: ${depId} → ${expandedNodes.map(n => n.id).join(', ')}`);
          newDeps.splice(i, 1, ...expandedNodes.map(n => n.id));
          i += expandedNodes.length - 1; // adjust index

          // Wire dependents on the per-item nodes
          for (const en of expandedNodes) {
            if (!en.dependents.includes(node.id)) {
              en.dependents.push(node.id);
            }
          }

          changed = true;
          repaired++;
        } else {
          // No expanded nodes found — recreate the missing node from template
          const typeDef = this.config.template.artifactTypes[typeId];
          if (typeDef) {
            const templateDeps = typeDef.dependencies
              .filter((d: { required: boolean }) => d.required)
              .map((d: { artifactTypeId: string; scope?: string }) => {
                if (d.scope === 'matching' && itemId) {
                  return `${d.artifactTypeId}:${itemId}`;
                }
                return d.artifactTypeId;
              })
              .filter((d: string) => this.executor.getNode(d));

            this.executor.addNode({
              id: depId,
              typeId,
              itemId: itemId ?? typeId,
              status: 'pending',
              displayName: `${typeDef.displayName}${itemId ? ': ' + itemId : ''}`,
              isExpensive: typeDef.isExpensive,
              isCollection: typeDef.isCollection,
              dependencies: templateDeps,
              dependents: [node.id],
            });

            for (const td of templateDeps) {
              const tdNode = this.executor.getNode(td);
              if (tdNode && !tdNode.dependents.includes(depId)) {
                tdNode.dependents.push(depId);
              }
            }

            this.log(`  Repaired missing node: ${depId} (needed by ${node.id})`);
            repaired++;
          }
        }
      }

      if (changed) {
        node.dependencies = newDeps;
      }
    }

    if (repaired > 0) {
      this.log(`Repaired ${repaired} missing/stale reference(s)`);
      this.persistState();
    }
  }

  /**
   * Expand any pending collection nodes whose dependencies are already completed.
   * This handles session resume where e.g. scene_video_prompt completed in a prior
   * run but shot_image_prompt wasn't expanded into per-shot nodes.
   */
  /**
   * Expand pending type-level collection nodes into per-item nodes.
   *
   * This handles two cases:
   * 1. Scene-level expansion: type-level `scene_video_prompt` → per-scene nodes
   *    (by finding completed per-item nodes of the matching-scope dependency type)
   * 2. Shot-level expansion: per-scene `shot_image_prompt:scene_N` → per-shot nodes
   *    (by reading the scene_video_prompt output to extract shots)
   *
   * Called at startup and during the execution loop to handle post-reset state
   * where type-level collections exist but haven't been expanded yet.
   */
  private async expandPendingCollections(): Promise<void> {
    // Graph hygiene — first thing every pass does. Self-heals orphan
    // collection parents and dangling dep refs that accumulate
    // across reset / redo / migration cycles. Steady-state no-op; only
    // emits a notification when something was actually repaired.
    const hygiene = reconcileGraphHygiene(this.executor, this.config.template);
    const summary = summariseHygieneResult(hygiene);
    if (summary) {
      this.log(`  Graph hygiene: ${summary}`);
      this.emit({
        type: 'notification',
        level: 'info',
        message: `Graph hygiene: ${summary}`,
      });
    }

    // Load saved scene summaries from disk (survive restarts)
    if (this.sceneSummaries.size === 0) {
      const summaryPath = join(this.config.projectDir, 'prompts', 'scene_summaries.json');
      if (existsSync(summaryPath)) {
        try {
          const saved = JSON.parse(readFileSync(summaryPath, 'utf-8'));
          for (const [k, v] of Object.entries(saved)) {
            this.sceneSummaries.set(k, v as string);
          }
          this.log(`  Loaded ${this.sceneSummaries.size} scene summaries from disk`);
        } catch { /* ignore */ }
      }
    }
    // Load saved per-scene estimated durations (duration-first extractor)
    if (this.sceneEstimatedDurations.size === 0) {
      const durPath = join(this.config.projectDir, 'prompts', 'scene_durations.json');
      if (existsSync(durPath)) {
        try {
          const saved = JSON.parse(readFileSync(durPath, 'utf-8'));
          for (const [k, v] of Object.entries(saved)) {
            if (typeof v === 'number' && v > 0) {
              this.sceneEstimatedDurations.set(k, v);
            }
          }
          this.log(`  Loaded ${this.sceneEstimatedDurations.size} scene durations from disk`);
        } catch { /* ignore */ }
      }
    }
    // Load saved story essence (story_essence node output) so re-runs
    // and resumed sessions pick up the editorial intent without an extra
    // LLM call. The hierarchical extractor and scene-prose context block
    // both consume this.
    if (this.storyEssence === null) {
      const essencePath = join(this.config.projectDir, 'prompts', 'story_essence.json');
      if (existsSync(essencePath)) {
        try {
          const parsed = JSON.parse(readFileSync(essencePath, 'utf-8')) as Partial<StoryEssence>;
          if (
            typeof parsed.genre === 'string' &&
            typeof parsed.throughline === 'string' &&
            typeof parsed.tonalNotes === 'string' &&
            typeof parsed.dramaticEmphasis === 'string'
          ) {
            // narration is required on the StoryEssence type but may be
            // missing on essence files written before it was added to
            // the schema. Default to mode='none' so legacy projects keep
            // working without re-running the essence stage.
            const narration = (parsed.narration && typeof parsed.narration === 'object')
              ? parsed.narration
              : { mode: 'none' as const, voice: '' };
            this.storyEssence = {
              genre: parsed.genre,
              throughline: parsed.throughline,
              tonalNotes: parsed.tonalNotes,
              dramaticEmphasis: parsed.dramaticEmphasis,
              narration: {
                mode: narration.mode ?? 'none',
                voice: narration.voice ?? '',
              },
            };
            this.log(`  Loaded story essence from disk (genre=${this.storyEssence.genre}, narration=${this.storyEssence.narration.mode})`);
          }
        } catch { /* ignore — essence is optional, hierarchical falls back to no-essence path */ }
      }
    }

    const allNodes = this.executor.getAllNodes();
    let expanded = true;

    // Keep expanding until no more expansions happen (handles cascading: scene → SVP → shot)
    while (expanded) {
      expanded = false;

      // Reconcile per-shot graph children against newly-completed
      // scene_shot_plan outputs. When the user redoes a stage upstream
      // of scene_shot_plan (e.g. "Scene scripts"), the cascade marks
      // existing shot_breakdown children pending but never removes
      // them. If the new plan has fewer shots than the previous one,
      // those leftover children re-run with a node id that no plan
      // entry matches (`shot_breakdown:scene_1_shot_8` when the new
      // plan tops out at 7) — the LLM hallucinates a shot 8 anyway,
      // and the assembler later rejects the assembled output with
      // "shot output has shotNumber 8 but the plan does not list it".
      //
      // Prune those orphans before the expand-loop runs its other
      // strategies so we avoid wasting LLM calls + assembler failures.
      // Anchored on scene_shot_plan being COMPLETED (the new plan is
      // on disk and authoritative).
      for (const planNode of this.executor.getAllNodes()) {
        if (planNode.typeId !== 'scene_shot_plan') continue;
        if (planNode.status !== 'completed' || !planNode.outputPath) continue;
        const sceneId = planNode.itemId;
        if (!sceneId) continue;
        if (this.reconcilePerShotChildrenForScene(planNode, sceneId)) {
          expanded = true; // re-run the outer while to pick up the pruned graph
        }
      }

      for (const node of this.executor.getAllNodes()) {
        // Strategy B2: Scene-level → shot-level re-expansion (runs for completed OR pending nodes with itemId)
        // Template is authoritative for isCollection — stale saved state (e.g. noir_detective_story_setup-3
        // persisted shot_motion_directive:scene_1 with isCollection=false) must not block expansion.
        if (shouldExpandSceneCollectionToShots(node, this.config.template)) {
          const sceneId = node.itemId!;
          // shot_breakdown reads from scene_shot_plan (Stage A output);
          // every other expandable shot type reads from scene_video_prompt
          // (which is now the deterministic Stage C assembled output).
          const sourceNodeId = node.typeId === 'shot_breakdown'
            ? `scene_shot_plan:${sceneId}`
            : `scene_video_prompt:${sceneId}`;
          const sourceShotsField = node.typeId === 'shot_breakdown'
            ? 'shotPlan'
            : 'shots';
          const svpNode = this.executor.getNode(sourceNodeId);
          if (svpNode?.status === 'completed' && svpNode.outputPath) {
            const hasChildren = this.executor.getAllNodes().some(
              n => n.typeId === node.typeId && n.itemId?.startsWith(`${sceneId}_shot_`),
            );
            if (!hasChildren) {
              try {
                const fullPath = join(this.config.projectDir, svpNode.outputPath);
                let content = readFileSync(fullPath, 'utf-8').trim();
                if (content.startsWith('```')) content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
                const parsed = JSON.parse(content);
                const shots = parsed[sourceShotsField] ?? (Array.isArray(parsed) ? parsed : []);
                if (shots.length > 0) {
                  const sceneLabel = sceneId.replace('scene_', 'S');
                  const shotItems = shots.map((s: any) => {
                    // Per-shot label: prefer cameraWork (post-breakdown),
                    // fall back to oneLineSummary (plan-only), then a
                    // generic label.
                    const label = (typeof s.cameraWork === 'string' && s.cameraWork.split(',')[0])
                      || (typeof s.oneLineSummary === 'string' && s.oneLineSummary.substring(0, 60))
                      || 'shot';
                    return {
                      itemId: `${sceneId}_shot_${s.shotNumber}`,
                      name: `${sceneLabel} Shot ${s.shotNumber}: ${label}`,
                      // Carry the first-frame anchor through to the
                      // graph-wiring step below so shot_image deps
                      // point at the right prior frame (or none for
                      // a fresh start).
                      firstFrameAnchor: s.firstFrameAnchor ?? null,
                    };
                  });
                  // BEFORE expanding shot_breakdown into per-shot children:
                  // lock scene_video_prompt:scene_N (the deterministic
                  // assembler) from being further expanded by
                  // expandCollection's matching-scope cascade. Without
                  // this, the cascade sees scene_video_prompt:scene_N as
                  // a per-item-with-isCollection=true (preserved from the
                  // template via the earlier cascade from scene_shot_plan),
                  // matching scope on shot_breakdown, and promotes it to
                  // per-shot — creating phantom scene_video_prompt:
                  // scene_N_shot_M nodes that have no scene_shot_plan to
                  // assemble from and deadlock the pipeline.
                  //
                  // scene_video_prompt is per-scene by construction; it
                  // doesn't need shot-level granularity. Setting
                  // isCollection=false before the cascade makes
                  // expandMatchingDependent's matching branch (which
                  // requires dependent.isCollection) skip it. The manual
                  // rewire below then wires its deps correctly.
                  if (node.typeId === 'shot_breakdown') {
                    const svpDeterministic = this.executor.getNode(`scene_video_prompt:${sceneId}`);
                    if (svpDeterministic) {
                      svpDeterministic.isCollection = false;
                    }
                  }

                  this.log(`  Re-expanding ${node.id} → ${shotItems.length} per-shot nodes (source: ${sourceNodeId})`);
                  this.executor.expandCollection(node.id, shotItems);

                  // shot_breakdown special-case: scene_video_prompt:scene_N
                  // depends on shot_breakdown (scope=matching). Because we
                  // just locked it to isCollection=false above,
                  // expandCollection's built-in dependent rewiring fell
                  // through without touching it. Wire deps manually so
                  // the assembler waits on every per-shot child instead
                  // of the now-deleted parent collection.
                  if (node.typeId === 'shot_breakdown') {
                    const svpDeterministic = this.executor.getNode(`scene_video_prompt:${sceneId}`);
                    if (svpDeterministic) {
                      const oldParentDepId = node.id;
                      svpDeterministic.dependencies = svpDeterministic.dependencies.filter(d => d !== oldParentDepId);
                      for (const child of shotItems) {
                        const childId = `shot_breakdown:${child.itemId}`;
                        if (!svpDeterministic.dependencies.includes(childId)) {
                          svpDeterministic.dependencies.push(childId);
                        }
                        const childNode = this.executor.getNode(childId);
                        if (childNode && !childNode.dependents.includes(svpDeterministic.id)) {
                          childNode.dependents.push(svpDeterministic.id);
                        }
                      }
                      this.log(`  Rewired ${svpDeterministic.id} → depends on ${shotItems.length} shot_breakdown children`);
                    }
                  }

                  // For shot_image_prompt: also create shot_image and shot_video per-shot nodes
                  if (node.typeId === 'shot_image_prompt') {
                    const allCharImages = this.executor.getAllNodes()
                      .filter(n => n.typeId === 'character_image' && n.itemId).map(n => n.id);
                    const allSettingImages = this.executor.getAllNodes()
                      .filter(n => n.typeId === 'setting_image' && n.itemId).map(n => n.id);
                    let prevShotImageId: string | null = null;
                    let prevShotVideoId2: string | null = null;
                    for (const shot of shotItems) {
                      const shotImageId = `shot_image:${shot.itemId}`;
                      const shotImageLastFrameId = `shot_image_last_frame:${shot.itemId}`;
                      const shotVideoId = `shot_video:${shot.itemId}`;
                      const motionId = `shot_motion_directive:${shot.itemId}`;
                      // Pattern B: split shot_image into first-frame +
                      // last-frame nodes so cloud failures on the
                      // last_frame edit step don't poison the
                      // already-generated first frame.
                      addShotImageNodes({
                        executor: this.executor,
                        shot,
                        allCharImageIds: allCharImages,
                        allSettingImageIds: allSettingImages,
                        prevShotImageId,
                        firstFrameAnchor: (shot as { firstFrameAnchor?: any }).firstFrameAnchor ?? null,
                        sceneId,
                      });
                      if (!this.executor.getNode(shotVideoId)) {
                        const videoDeps = [shotImageLastFrameId, motionId];
                        // Only chain prev-shot when V2V is on; otherwise the
                        // edge becomes a phantom that cascade-invalidates
                        // every following shot when the user redoes one.
                        if (prevShotVideoId2 && this.config.project.useV2V === true) {
                          videoDeps.push(prevShotVideoId2);
                        }
                        this.executor.addNode({
                          id: shotVideoId, typeId: 'shot_video', itemId: shot.itemId,
                          status: 'pending', displayName: `Shot Videos: ${shot.name}`,
                          isExpensive: true, isCollection: false, dependencies: videoDeps, dependents: [],
                        });
                        for (const depId of videoDeps) {
                          const depNode = this.executor.getNode(depId);
                          if (depNode && !depNode.dependents.includes(shotVideoId)) depNode.dependents.push(shotVideoId);
                        }
                      }
                      prevShotImageId = shotImageId;
                      prevShotVideoId2 = shotVideoId;
                    }
                  }

                  expanded = true;
                  continue;
                }
              } catch (err) {
                this.log(`  Failed to re-expand ${node.id}: ${err}`);
              }
            }
          }
        }

        if (!node.isCollection || node.status !== 'pending') continue;
        if (node.itemId) continue; // Already a per-item node — skip (only expand type-level)

        // Strategy 1: Find upstream per-item nodes to determine item set
        // Look at the template to find which dependency has 'matching' scope
        const typeDef = this.config.template.artifactTypes[node.typeId];
        if (!typeDef) {
          this.log(`  expandPendingCollections: no typeDef for ${node.typeId}`);
          continue;
        }

        let didExpand = false;
        this.log(`  expandPendingCollections: checking ${node.id} (${typeDef.dependencies.length} deps)`);

        for (const dep of typeDef.dependencies) {
          if (dep.scope !== 'matching') continue;
          this.log(`    dep ${dep.artifactTypeId} scope=matching`);

          // Strategy A: Find completed per-item nodes of this dependency type
          const upstreamItems = allNodes
            .filter(n => n.typeId === dep.artifactTypeId && n.itemId &&
              (n.status === 'completed' || n.status === 'pending'))
            .map(n => ({ itemId: n.itemId!, name: n.displayName.split(': ').pop() ?? n.itemId! }));

          if (upstreamItems.length > 0) {
            this.log(`  Expanding type-level ${node.id} → ${upstreamItems.length} items from ${dep.artifactTypeId} per-item nodes`);
            this.executor.expandCollection(node.id, upstreamItems);
            this.emit({
              type: 'notification',
              level: 'info',
              message: `Expanded ${node.displayName}: ${upstreamItems.map(i => i.name).join(', ')}`,
            });
            didExpand = true;
            expanded = true;
            break;
          }

          // Strategy B: No per-item nodes exist (post-reset collapsed state).
          // Scan the output content for item patterns (SCENE 1, SCENE 2, etc.)
          const upstreamTypeLevel = allNodes.find(
            n => n.typeId === dep.artifactTypeId && !n.itemId && n.status === 'completed' && n.outputPath
          );
          if (upstreamTypeLevel?.outputPath) {
            const fullPath = join(this.config.projectDir, upstreamTypeLevel.outputPath);
            if (existsSync(fullPath)) {
              try {
                const content = readFileSync(fullPath, 'utf-8');
                const itemList: Array<{ itemId: string; name: string }> = [];

                // Parse scene numbers from content patterns like "SCENE 1:", "## Scene 2", etc.
                if (dep.artifactTypeId === 'scene' || dep.artifactTypeId === 'story') {
                  const sceneMatches = content.matchAll(/\bSCENE\s+(\d+)[:\s—–-]+([^\n*]+)/gi);
                  const seen = new Set<number>();
                  for (const m of sceneMatches) {
                    const num = parseInt(m[1]!, 10);
                    if (!seen.has(num)) {
                      seen.add(num);
                      itemList.push({ itemId: `scene_${num}`, name: m[2]!.trim().substring(0, 60) });
                    }
                  }
                }

                // Parse character names from content
                if (dep.artifactTypeId === 'character' && itemList.length === 0) {
                  const charMatches = content.matchAll(/^##\s+(.+)/gm);
                  for (const m of charMatches) {
                    const name = m[1]!.trim();
                    if (name.length > 2 && !name.startsWith('#')) {
                      itemList.push({ itemId: name.toLowerCase().replace(/\s+/g, '_'), name });
                    }
                  }
                }

                // Parse setting names from content
                if (dep.artifactTypeId === 'setting' && itemList.length === 0) {
                  const settingMatches = content.matchAll(/^#\s+(.+)/gm);
                  for (const m of settingMatches) {
                    const name = m[1]!.trim();
                    if (name.length > 2) {
                      itemList.push({ itemId: name.toLowerCase().replace(/\s+/g, '_'), name });
                    }
                  }
                }

                // Parse object names from content
                if (dep.artifactTypeId === 'object' && itemList.length === 0) {
                  const objectMatches = content.matchAll(/^##\s+(.+)/gm);
                  for (const m of objectMatches) {
                    const name = m[1]!.trim();
                    if (name.length > 2 && !name.startsWith('#')) {
                      itemList.push({ itemId: name.toLowerCase().replace(/\s+/g, '_'), name });
                    }
                  }
                }

                if (itemList.length > 0) {
                  this.log(`  Expanding type-level ${node.id} → ${itemList.length} items from ${dep.artifactTypeId} output: ${itemList.map(i => i.itemId).join(', ')}`);
                  this.executor.expandCollection(node.id, itemList);
                  this.emit({
                    type: 'notification',
                    level: 'info',
                    message: `Expanded ${node.displayName}: ${itemList.map(i => i.name).join(', ')}`,
                  });
                  didExpand = true;
                  expanded = true;
                  break;
                } else {
                  this.log(`  Strategy B: no items found in ${dep.artifactTypeId} output (${content.length} chars)`);
                }
              } catch (err) {
                this.log(`  Failed to parse items from ${upstreamTypeLevel.outputPath}: ${err}`);
              }
            }
          } else {
            this.log(`    No type-level ${dep.artifactTypeId} node with output found`);
          }
        }

        if (didExpand) continue;

        // Strategy B2: Scene-level → shot-level expansion for shot_image_prompt, shot_motion_directive, shot_image, shot_video
        // After reset, these scene-level collection nodes may be completed/pending but have no per-shot children.
        // Re-read the scene_video_prompt output to determine shot items and expand.
        if (!didExpand && shouldExpandSceneCollectionToShots(node, this.config.template)) {
          const sceneId = node.itemId!;
          const svpNode = this.executor.getNode(`scene_video_prompt:${sceneId}`);
          if (svpNode?.status === 'completed' && svpNode.outputPath) {
            // Check if per-shot children already exist
            const hasChildren = this.executor.getAllNodes().some(
              n => n.typeId === node.typeId && n.itemId?.startsWith(`${sceneId}_shot_`),
            );
            if (!hasChildren) {
              try {
                const fullPath = join(this.config.projectDir, svpNode.outputPath);
                let content = readFileSync(fullPath, 'utf-8').trim();
                if (content.startsWith('```')) content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
                const parsed = JSON.parse(content);
                const shots = parsed.shots ?? (Array.isArray(parsed) ? parsed : []);
                if (shots.length > 0) {
                  const sceneLabel = sceneId.replace('scene_', 'S');
                  const shotItems = shots.map((s: any) => ({
                    itemId: `${sceneId}_shot_${s.shotNumber}`,
                    name: `${sceneLabel} Shot ${s.shotNumber}: ${s.cameraWork?.split(',')[0] || 'shot'}`,
                    // Carry anchor through (same as the
                    // shot_breakdown-driven expansion above).
                    firstFrameAnchor: s.firstFrameAnchor ?? null,
                  }));
                  this.log(`  Re-expanding ${node.id} → ${shotItems.length} per-shot nodes from scene_video_prompt`);
                  this.executor.expandCollection(node.id, shotItems);

                  // For shot_image_prompt: also create shot_image and shot_video per-shot nodes
                  if (node.typeId === 'shot_image_prompt') {
                    const allCharImages = this.executor.getAllNodes()
                      .filter(n => n.typeId === 'character_image' && n.itemId).map(n => n.id);
                    const allSettingImages = this.executor.getAllNodes()
                      .filter(n => n.typeId === 'setting_image' && n.itemId).map(n => n.id);
                    let prevShotImageId: string | null = null;
                    const prevShotVideoId2: string | null = null;
                    for (const shot of shotItems) {
                      const shotImageId = `shot_image:${shot.itemId}`;
                      const shotImageLastFrameId = `shot_image_last_frame:${shot.itemId}`;
                      const shotVideoId = `shot_video:${shot.itemId}`;
                      const motionId = `shot_motion_directive:${shot.itemId}`;
                      // Pattern B: split first/last frame nodes.
                      addShotImageNodes({
                        executor: this.executor,
                        shot,
                        allCharImageIds: allCharImages,
                        allSettingImageIds: allSettingImages,
                        prevShotImageId,
                        firstFrameAnchor: (shot as { firstFrameAnchor?: any }).firstFrameAnchor ?? null,
                        sceneId,
                      });
                      if (!this.executor.getNode(shotVideoId)) {
                        this.executor.addNode({
                          id: shotVideoId, typeId: 'shot_video', itemId: shot.itemId,
                          status: 'pending', displayName: `Shot Videos: ${shot.name}`,
                          isExpensive: true, isCollection: false, dependencies: [shotImageLastFrameId, motionId], dependents: [],
                        });
                        const imgNode = this.executor.getNode(shotImageLastFrameId);
                        if (imgNode && !imgNode.dependents.includes(shotVideoId)) imgNode.dependents.push(shotVideoId);
                        const motNode = this.executor.getNode(motionId);
                        if (motNode && !motNode.dependents.includes(shotVideoId)) motNode.dependents.push(shotVideoId);
                      }
                      prevShotImageId = shotImageId;
                    }
                  }

                  didExpand = true;
                  expanded = true;
                }
              } catch (err) {
                this.log(`  Failed to re-expand ${node.id}: ${err}`);
              }
            }
          }
        }

        if (didExpand) continue;

        // Strategy B3: Disk-authoritative resume. Before falling through
        // to Strategy C's LLM extraction, look for per-item content
        // files that already exist in the type's `filePattern` directory
        // and rebuild the item list from them. Critical for hard-restart
        // recovery: if the previous process was killed before flushing
        // per-item nodes to executorState, Strategy A misses; Strategy
        // B only works for flat-list parents; Strategy C re-runs the
        // LLM and produces a non-deterministic extraction that may
        // disagree with the on-disk artifacts (5 scenes one run, 3 the
        // next — leaving downstream `scene_3_shot_*` files orphaned).
        // Same files in, same items out — alignment preserved.
        if (!didExpand) {
          const onDiskItems = listCollectionItemsFromDisk(
            this.config.projectDir,
            typeDef,
          );
          if (onDiskItems.length > 0) {
            this.log(
              `  Strategy B3: resumed ${onDiskItems.length} items for ${node.id} from on-disk content files`,
            );
            this.executor.expandCollection(node.id, onDiskItems);
            this.emit({
              type: 'notification',
              level: 'info',
              message: `Resumed ${node.displayName}: ${onDiskItems.map((i) => i.name).join(', ')}`,
            });
            didExpand = true;
            expanded = true;
            continue;
          }
        }

        // Strategy C: For collections that depend on 'story' (scene, character, setting),
        // run extractCollectionItems on the story output to determine items.
        // This handles post-reset state where story is completed but per-item nodes don't exist.
        //
        // We try multiple sources for the story content (in order):
        //   1. The story node's own outputPath (normal path).
        //   2. The template's canonical story filePattern on disk
        //      (covers cases where BackwardPlanner subtracted story from the
        //      graph because the legacy `files` registry said it was
        //      satisfied — story node may be absent but the file is present).
        //   3. `original_input.md` for inputType === 'story' projects
        //      (last-resort fallback if neither of the above is found).
        if (!didExpand && typeDef.dependencies.some(d => d.artifactTypeId === 'story')) {
          let storyContent: string | null = null;
          const storyContextNode = allNodes.find(n => n.typeId === 'story' && n.status === 'completed' && n.outputPath);
          if (storyContextNode?.outputPath) {
            const p = join(this.config.projectDir, storyContextNode.outputPath);
            if (existsSync(p)) {
              try { storyContent = readFileSync(p, 'utf-8'); } catch { /* fall through */ }
            }
          }
          if (!storyContent) {
            const storyTypeDef = this.config.template.artifactTypes['story'];
            const canonical = storyTypeDef?.filePattern?.replace(/\{\{chapter\}\}/g, 'chapter_1');
            if (canonical) {
              const p = join(this.config.projectDir, canonical);
              if (existsSync(p)) {
                try { storyContent = readFileSync(p, 'utf-8'); } catch { /* fall through */ }
              }
            }
          }
          if (!storyContent && this.config.project.inputType === 'story') {
            const p = join(this.config.projectDir, 'original_input.md');
            if (existsSync(p)) {
              try { storyContent = readFileSync(p, 'utf-8'); } catch { /* fall through */ }
            }
          }

          if (storyContent) {
            // Synthesize a context node for the extractor — it only reads
            // typeId off this object to dispatch.
            const ctxNode = storyContextNode ?? ({ typeId: 'story' } as ExecutionNode);
            try {
              const extracted = await extractCollectionItems(
                ctxNode, storyContent, this.llmFor('structured.collection_extraction'),
                this.config.goal.preferences.duration,
                this.storyEssence ?? undefined,
              );
                let itemList: Array<{ itemId: string; name: string }> = [];

                if (node.typeId === 'scene' && extracted?.scenes?.length) {
                  itemList = extracted.scenes.map((s: any) => ({
                    itemId: `scene_${s.sceneNumber}`,
                    name: s.title || `Scene ${s.sceneNumber}`,
                  }));
                  // Persist scene summaries + estimated durations from this
                  // extraction. Strategy C used to skip this, so duration-first
                  // values weren't reaching downstream. Use syncSceneArtifacts
                  // so a re-run with fewer scenes drops stale keys from the
                  // prior run (otherwise scene_3/scene_4 from a 4-scene run
                  // linger when the new extraction returns 2 scenes).
                  syncSceneArtifacts(
                    extracted.scenes as Array<{
                      sceneNumber: number; summary?: string; estimatedDuration?: number;
                    }>,
                    this.sceneSummaries,
                    this.sceneEstimatedDurations,
                  );
                  if (this.sceneSummaries.size > 0) {
                    const promptsDir = join(this.config.projectDir, 'prompts');
                    if (!existsSync(promptsDir)) mkdirSync(promptsDir, { recursive: true });
                    atomicWriteFileSync(
                      join(promptsDir, 'scene_summaries.json'),
                      JSON.stringify(Object.fromEntries(this.sceneSummaries), null, 2),
                    );
                  }
                  if (this.sceneEstimatedDurations.size > 0) {
                    const promptsDir = join(this.config.projectDir, 'prompts');
                    if (!existsSync(promptsDir)) mkdirSync(promptsDir, { recursive: true });
                    atomicWriteFileSync(
                      join(promptsDir, 'scene_durations.json'),
                      JSON.stringify(Object.fromEntries(this.sceneEstimatedDurations), null, 2),
                    );
                  }
                } else if (node.typeId === 'character' && extracted?.characters?.length) {
                  itemList = extracted.characters.map((c: string) => ({
                    itemId: c.toLowerCase().replace(/\s+/g, '_'),
                    name: c,
                  }));
                } else if (node.typeId === 'setting' && extracted?.settings?.length) {
                  itemList = extracted.settings.map((s: string) => ({
                    itemId: s.toLowerCase().replace(/\s+/g, '_'),
                    name: s,
                  }));
                } else if (node.typeId === 'object' && extracted?.objects?.length) {
                  itemList = extracted.objects.map((o: string) => ({
                    itemId: o.toLowerCase().replace(/\s+/g, '_'),
                    name: o,
                  }));
                }

                if (itemList.length > 0) {
                  this.log(`  Strategy C: Expanding ${node.id} → ${itemList.length} items from story extraction`);
                  this.executor.expandCollection(node.id, itemList);
                  this.emit({
                    type: 'notification',
                    level: 'info',
                    message: `Expanded ${node.displayName}: ${itemList.map(i => i.name).join(', ')}`,
                  });
                  didExpand = true;
                  expanded = true;
                } else {
                  // Extraction succeeded but produced zero items for this
                  // collection (typical case: story has no plot-critical
                  // objects). Mark this collection AND any matching-scope
                  // dependent collections as skipped — otherwise they hang
                  // pending forever and downstream non-collection nodes
                  // wait on a dep that will never be satisfied.
                  this.log(`  Strategy C: no ${node.typeId} items found — marking collection (and matching-scope dependents) skipped`);
                  const artifactTypesIndex = Object.fromEntries(
                    Object.entries(this.config.template.artifactTypes).map(([id, def]) => [
                      id,
                      { dependencies: def.dependencies },
                    ]),
                  );
                  const skipped = skipEmptyCollectionAndDependents(
                    node,
                    (id) => this.executor.getNode(id),
                    artifactTypesIndex,
                  );
                  if (skipped.length > 0) {
                    this.log(`  Skipped (empty-collection cascade): ${skipped.join(', ')}`);
                    this.persistState();
                    this.emitTodoUpdate();
                    expanded = true;
                  }
                }
            } catch (err) {
              this.log(`  Strategy C failed: ${err}`);
            }
          }
        }

        if (didExpand) continue;

        // Strategy 2: For per-scene shot nodes, read scene_video_prompt output to extract shots
        for (const depId of node.dependencies) {
          const dep = this.executor.getNode(depId);
          if (!dep?.outputPath || dep.typeId !== 'scene_video_prompt') continue;

          const fullPath = join(this.config.projectDir, dep.outputPath);
          if (!existsSync(fullPath)) continue;

          const content = readFileSync(fullPath, 'utf-8');
          const items = await extractCollectionItems(dep, content, this.llmFor('structured.collection_extraction'), this.config.goal.preferences.duration);
          if (!items?.shots?.length) continue;

          const sceneId = dep.itemId;
          if (!sceneId) continue;

          const shotItems = items.shots.map(s => ({
            itemId: `${sceneId}_shot_${s.shotNumber}`,
            name: `Shot ${s.shotNumber}: ${s.shotType}`,
          }));

          this.log(`  Startup expansion: ${node.id} → ${shotItems.map(i => i.name).join(', ')}`);
          this.executor.expandCollection(node.id, shotItems);
          this.emit({
            type: 'notification',
            level: 'info',
            message: `Expanded ${node.displayName}: ${shotItems.map(i => i.name).join(', ')}`,
          });
          expanded = true;
          break;
        }
      }
    }

    // Post-expansion sweep: any pending collection whose matching-scope
    // upstream type has ZERO nodes in the graph is unreachable — its
    // upstream produced no items (e.g. story has no plot-critical
    // objects → `object` collection never created → `object_image`
    // collection sits forever waiting for items that won't come). Mark
    // it skipped and cascade to its matching-scope dependent collections.
    // Without this, downstream non-collection nodes (shot_image with a
    // type-level ref to object_image) hang on a dep that's permanently
    // unsatisfiable.
    {
      const allNodes = this.executor.getAllNodes();
      const typeIdsPresent = new Set<string>();
      for (const n of allNodes) typeIdsPresent.add(n.typeId);

      const artifactTypesIndex = Object.fromEntries(
        Object.entries(this.config.template.artifactTypes).map(([id, def]) => [
          id,
          { dependencies: def.dependencies },
        ]),
      );

      for (const node of allNodes) {
        if (node.status !== 'pending') continue;
        if (!node.isCollection || node.itemId) continue;
        const typeDef = this.config.template.artifactTypes[node.typeId];
        if (!typeDef) continue;
        const matchingMissing = typeDef.dependencies
          .filter(d => d.scope === 'matching')
          .some(d => !typeIdsPresent.has(d.artifactTypeId));
        if (!matchingMissing) continue;

        this.log(`  Unreachable collection ${node.id}: matching-scope dep type has no nodes — skipping`);
        const skipped = skipEmptyCollectionAndDependents(
          node,
          (id) => this.executor.getNode(id),
          artifactTypesIndex,
        );
        if (skipped.length > 0) {
          this.log(`  Skipped (unreachable cascade): ${skipped.join(', ')}`);
        }
      }
      this.persistState();
    }

    // Post-expansion: fix dangling dependencies (type-level refs to expanded nodes)
    // e.g., scene_video_prompt:scene_1 depends on 'scene' (type-level, gone after expansion)
    // → rewire to 'scene:scene_1' (per-item, matching scope)
    //
    // CRITICAL: do NOT strip deps from type-level collection nodes that are
    // still waiting to be expanded. If scene_video_prompt (type-level, no
    // itemId) has a dep on `scene` that was expanded away, we CANNOT rewire
    // here (no itemId to key off of) and we MUST NOT strip — those deps are
    // carried into the per-item nodes when this collection finally gets
    // expanded. Stripping here caused every downstream per-item node to
    // inherit a broken dep list with no parent content. (See dep-propagation
    // regression suite.)
    for (const node of this.executor.getAllNodes()) {
      const newDeps: string[] = [];
      let fixed = false;
      const isUnexpandedTypeLevel = !node.itemId && node.isCollection;
      for (const depId of node.dependencies) {
        if (this.executor.getNode(depId)) {
          newDeps.push(depId);
        } else {
          // Try to find a per-item version: depId + ':' + node.itemId's scene prefix
          // e.g., 'scene' → 'scene:scene_1' when node is 'scene_video_prompt:scene_1'
          const itemId = node.itemId;
          if (itemId) {
            const perItemId = `${depId}:${itemId}`;
            if (this.executor.getNode(perItemId)) {
              newDeps.push(perItemId);
              this.log(`  Fixed dangling dep: ${node.id} → ${depId} rewired to ${perItemId}`);
              fixed = true;
              continue;
            }
          }
          if (isUnexpandedTypeLevel) {
            // Keep the dep so it'll be rewired during expansion. Stripping
            // it would blind every per-item node this collection produces.
            newDeps.push(depId);
            continue;
          }
          // Per-item node with a genuinely unresolvable dep — drop it to
          // prevent deadlock. (Type-level collection nodes preserve deps
          // above; per-item deps failing to resolve are rarer and usually
          // indicate template/plan drift.)
          this.log(`  Removed dangling dep from ${node.id}: ${depId} (node doesn't exist)`);
          fixed = true;
        }
      }
      if (fixed) {
        node.dependencies = newDeps;
      }
    }
  }

  /**
   * Validate that LLM output is valid JSON with required fields.
   */
  /**
   * Attempt to repair common JSON issues from LLM output:
   * - Two arrays/objects concatenated (] [ or } {) → take the last one
   * - Trailing commas before ] or }
   * - Truncated JSON → close open brackets/braces
   */
  /**
   * Check if a cached prompt file is stale — i.e., any dependency node was
   * completed more recently than the prompt file was written.
   * This detects prompts from before a reset that need regeneration.
   */
  /**
   * Whether a node represents an LLM call (as opposed to ComfyUI /
   * FFmpeg / deterministic work). These are the nodes we fan out
   * concurrently when `LLM_MODE=cloud` enables parallelism.
   *
   * Rule: anything with category `visual_ref`, `clip`, or `final` is
   * NOT an LLM node — those go through ComfyUI or FFmpeg and have their
   * own concurrency controls. Everything else (content, structure,
   * concept, etc.) is an LLM node.
   *
   * Exception: a media node whose prompt has not yet been generated
   * still issues an LLM call for the prompt in the SAME pass. That
   * case is fine to parallelize — the outer `runOneNode` will write
   * the prompt, then either kick off ComfyUI (parallel media mode) or
   * block on it (serial media mode). We keep the node classification
   * stable for simplicity; if the per-node path hits the ComfyUI
   * block, it's the same as today and unaffected by LLM concurrency.
   */
  private isLLMEligibleNode(node: ExecutionNode): boolean {
    const typeDef = this.config.template.artifactTypes[node.typeId];
    const cat = typeDef?.category;
    return cat !== 'visual_ref' && cat !== 'clip' && cat !== 'final';
  }

  /**
   * Resolve the concurrency cap for LLM calls from env.
   *
   * Config:
   *   - `LLM_MODE=cloud|local` (default `local`)
   *   - `LLM_PARALLELISM_CLOUD` (default `4` when mode=cloud)
   *   - `LLM_PARALLELISM_LOCAL` (default `1` when mode=local)
   *
   * Local mode defaults to 1 because a single local model server (LM
   * Studio, llama.cpp) serializes requests anyway — the value just
   * fights the server's own queue. Cloud defaults to 4 as a
   * conservative starting point that fits inside most provider rate
   * limits; users can tune via the `LLM_PARALLELISM_CLOUD` var.
   *
   * Read lazily per-call (no caching) so `.env` edits and test
   * overrides via `process.env` take effect without a restart of the
   * orchestrator.
   */
  private getLLMConcurrency(): number {
    const mode = (process.env['LLM_MODE'] ?? 'local').toLowerCase();
    const key = mode === 'cloud' ? 'LLM_PARALLELISM_CLOUD' : 'LLM_PARALLELISM_LOCAL';
    const fallback = mode === 'cloud' ? 4 : 1;
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return parsed;
  }

  /**
   * Check if any completed dependency has a missing output file.
   * Returns the list of dependency IDs whose output files don't exist.
   */
  private validateDependencyOutputs(node: ExecutionNode): string[] {
    const missing: string[] = [];
    for (const depId of node.dependencies) {
      const dep = this.executor.getNode(depId);
      if (!dep || dep.status !== 'completed') continue;
      if (!dep.outputPath) continue;
      const fullPath = join(this.config.projectDir, dep.outputPath);
      if (!existsSync(fullPath)) {
        missing.push(depId);
      }
    }
    return missing;
  }

  private isPromptStale(node: ExecutionNode, promptPath: string): boolean {
    try {
      const { statSync } = require('fs') as typeof import('fs');
      const promptMtime = statSync(promptPath).mtimeMs;

      for (const depId of node.dependencies) {
        const depNode = this.executor.getNode(depId);
        if (depNode?.completedAt && depNode.completedAt > promptMtime) {
          this.log(`  Prompt file is stale: ${depId} completed at ${new Date(depNode.completedAt).toISOString()} > prompt mtime ${new Date(promptMtime).toISOString()}`);
          return true;
        }
      }
      return false;
    } catch {
      return false; // if we can't stat, assume not stale
    }
  }

  private repairJson(text: string): string {
    let s = text.trim();

    // Strategy 1: Extract first valid JSON object/array from the text.
    // Handles thinking preamble before JSON (common with Nemotron, local models).
    // Scans for { or [ and tries to parse from that position.
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '{' || s[i] === '[') {
        // Find the matching closing bracket by trying progressively longer substrings
        const openChar = s[i]!;
        const closeChar = openChar === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escape = false;

        for (let j = i; j < s.length; j++) {
          const ch = s[j]!;
          if (escape) { escape = false; continue; }
          if (ch === '\\' && inString) { escape = true; continue; }
          if (ch === '"' && !escape) { inString = !inString; continue; }
          if (inString) continue;
          if (ch === openChar) depth++;
          if (ch === closeChar) depth--;
          if (depth === 0) {
            const candidate = s.substring(i, j + 1);
            try {
              JSON.parse(candidate);
              if (i > 0) {
                this.log(`  JSON repair: extracted JSON from position ${i} (skipped ${i} chars of preamble)`);
              }
              return candidate;
            } catch {
              break; // This bracket pair didn't produce valid JSON, try next
            }
          }
        }
      }
    }

    // Strategy 2: Take the last complete JSON object (for concatenated outputs)
    const lastObjStart = s.lastIndexOf('{');
    if (lastObjStart > 0) {
      const candidate = s.substring(lastObjStart);
      try {
        JSON.parse(candidate);
        this.log(`  JSON repair: using last object from position ${lastObjStart}`);
        return candidate;
      } catch { /* try other repairs */ }
    }

    const lastArrayStart = s.lastIndexOf('[');
    if (lastArrayStart > 0) {
      const candidate = s.substring(lastArrayStart);
      try {
        JSON.parse(candidate);
        this.log(`  JSON repair: using last array from position ${lastArrayStart}`);
        return candidate;
      } catch { /* try other repairs */ }
    }

    // Strategy 3: Trailing commas
    s = s.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}');

    return s;
  }

  private validateJsonOutput(content: string, node: ExecutionNode): { valid: boolean; error?: string; normalizedContent?: string } {
    // Strip markdown code fences if the LLM wrapped the JSON
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    // Attempt JSON repair before parsing
    cleaned = this.repairJson(cleaned);

    try {
      const parsed = JSON.parse(cleaned);

      // Validate against Zod schema
      const result = validateWithSchema(node.typeId, parsed);
      if (!result.valid) {
        return { valid: false, error: result.error };
      }

      let mutated = false;

      // Auto-normalize scene_video_prompt fields
      if (node.typeId === 'scene_video_prompt') {
        normalizeSceneVideoPrompt(parsed);
        this.runContinuitySequenceCheck(parsed, node.id);
        this.runOneSettingPerSceneCheck(parsed, node.id);
        // Dialogue-fit pass: bump any shot whose declared `duration` is
        // shorter than the dialogue in its `audio` field. Without this
        // the video model generates the exact requested duration and
        // clips long speeches mid-sentence. Capped at 15s (LTX 2.3's
        // practical ceiling).
        if (Array.isArray(parsed?.shots)) {
          const adjustments = fitShotDurations(parsed.shots as Array<Record<string, unknown>>);
          if (adjustments.length > 0) {
            this.log(`  [dialogue-fit] ${node.id}: adjusted ${adjustments.length} shot(s): ${adjustments.map(a => `shot${a.shotNumber} ${a.from}s→${a.to}s (dialogue=${a.dialogueSeconds}s)`).join(', ')}`);
          }
          // Soft-warn: flag any shot with 2+ speakers in its audio
          // field. See scene_breakdown_plan_guide.md "Step 2a: One
          // speaker per shot" — video models mis-attribute dialogue
          // when one shot tries to carry two speakers. Warning only;
          // not a validation failure, to avoid blocking legacy projects.
          const multiSpeaker = scanMultiSpeakerShots(parsed.shots as Array<Record<string, unknown>>);
          if (multiSpeaker.length > 0) {
            this.log(`  [multi-speaker] ${node.id}: ${multiSpeaker.length} shot(s) carry 2+ speakers — video model will likely mis-attribute: ${multiSpeaker.map(w => `shot${w.shotNumber}(${w.speakers.join('+')})`).join(', ')}`);
          }
        }
        mutated = true;
      }

      // Per-frame normalization for shot_image_prompt. Order matters:
      //
      //   (1) Normalize first_frame (inject missing refs + reorder so
      //       settings sit at index 0). This establishes canonical
      //       (refId → imageNumber) numbering for the shot.
      //
      //   (2) alignFramesToFirstFrame propagates first_frame's mapping
      //       to every non-first frame — inheriting dropped refs and
      //       rewriting `from image N` tags where the LLM renumbered.
      //       Must run AFTER (1) so the canonical numbering is stable,
      //       and BEFORE (3) so the per-frame injector sees aligned
      //       numbering and doesn't duplicate "from image N" tags.
      //
      //   (3) Normalize the remaining frames (last_frame, mid_frame).
      //       Now safe to inject any missing tags / rerun reorder.
      //
      //   (4) OTS-with-single-char hard gate — reject the prompt if any
      //       frame combines OTS framing with fewer than two character
      //       refs. Forces regen against the strengthened guide.
      if (node.typeId === 'shot_image_prompt' && parsed?.frames && typeof parsed.frames === 'object') {
        const availableRefs = this.buildAvailableRefsForShot(node);
        const allInjected: Array<{ frame: string; label: string; imageNumber: number; kind: string }> = [];

        // (0) Enforce the canonical reference set from scene_video_prompt's
        // focus / perspectiveOf fields on first_frame. The LLM frequently
        // forgets to list a character it named in prose by its narrative
        // name (e.g. wrote "Kaito Nakamura sits at the news anchor desk"
        // but emitted references: []). The SVP's focus.primary /
        // perspectiveOf / focus.lurking name characters by refId — the
        // authoritative identity slug — so this pass MERGES any missing
        // canonical refs into first_frame.references. alignFramesToFirstFrame
        // then propagates them to every other frame in step (2). Pure
        // post-LLM enforcement; project-agnostic.
        const ffKey = 'first_frame';
        const ff0 = parsed.frames[ffKey];
        if (ff0 && typeof ff0 === 'object' && Array.isArray(ff0.references) && node.itemId) {
          const sceneId0 = node.itemId.match(/^(scene_\d+)/)?.[1];
          const shotNum0 = parseInt(node.itemId.match(/shot_(\d+)/)?.[1] ?? '0', 10);
          if (sceneId0 && shotNum0 > 0) {
            const ctx0 = readShotContextFromSvp(this.config.projectDir, sceneId0, shotNum0);
            if (ctx0) {
              const enforceResult = enforceShotCanonicalRefs(
                {
                  perspectiveOf: ctx0.perspectiveOf ?? null,
                  focus: {
                    primary: ctx0.focusPrimary ?? null,
                    background: ctx0.focusBackground ?? [],
                    lurking: ctx0.focusLurking ?? null,
                  },
                  canonicalSceneSetting: ctx0.canonicalSceneSetting ?? null,
                },
                ff0.references,
                availableRefs,
              );
              if (enforceResult.addedRefIds.length > 0) {
                ff0.references = enforceResult.references;
                this.log(`  [canonical-refs] ${node.id}: enforced ${enforceResult.addedRefIds.length} missing canonical ref(s) on first_frame from SVP focus/perspectiveOf: ${enforceResult.addedRefIds.join(', ')}`);
              }
            }
          }
        }

        // Gate: when turn-2 ref refinement succeeded, every frame already
        // has the canonical refs (refineShotImageRefs overwrites BOTH
        // first_frame.references and last_frame.references with the same
        // parseTurn2RefsJson output — see ExecutorAgent.refineShotImageRefs
        // line ~6502). The legacy normalizer pipeline (injectMissingShotRefs
        // + alignFramesToFirstFrame) was built for the pre-turn-2 era where
        // each frame's refs were independently LLM-emitted and mutually
        // inconsistent. Running it post-turn-2 has only one observable
        // effect: it injects `from image N` tags into prose that nothing
        // downstream needs (applyShotImageManifestPostPass builds the
        // canonical slot binding from references[] alone). The injected
        // tags then become noise in the saved JSON, contradicting the
        // skill guide that tells the LLM not to write them.
        //
        // Detection: both frames' references arrays match (canonical-equal).
        const ffRefs = parsed.frames[ffKey]?.references;
        const lfRefs = parsed.frames['last_frame']?.references;
        const canonicalKey = (rs: Reference[]): string =>
          [...rs]
            .sort((a, b) => a.imageNumber - b.imageNumber)
            .map(r => `${r.imageNumber}|${r.type}|${r.refId}`)
            .join(',');
        const turn2Succeeded =
          Array.isArray(ffRefs) && ffRefs.length > 0 &&
          Array.isArray(lfRefs) && lfRefs.length > 0 &&
          canonicalKey(ffRefs as Reference[]) === canonicalKey(lfRefs as Reference[]);

        if (!turn2Succeeded) {
          // (1) first_frame normalization.
          const ff = parsed.frames[ffKey];
          if (ff && typeof ff === 'object' && typeof ff.imagePrompt === 'string' && Array.isArray(ff.references)) {
            const result = normalizeShotImagePromptWithRefs(ff, availableRefs);
            parsed.frames[ffKey] = result.frame;
            for (const ev of result.injected) {
              allInjected.push({ frame: ffKey, ...ev });
            }
          }

          // (2) Align other frames to first_frame's canonical mapping.
          alignFramesToFirstFrame(parsed, availableRefs);

          // (3) Per-frame normalization for non-first frames.
          for (const frameKey of Object.keys(parsed.frames)) {
            if (frameKey === ffKey) continue;
            const f = parsed.frames[frameKey];
            if (f && typeof f === 'object' && typeof f.imagePrompt === 'string' && Array.isArray(f.references)) {
              const result = normalizeShotImagePromptWithRefs(f, availableRefs);
              parsed.frames[frameKey] = result.frame;
              for (const ev of result.injected) {
                allInjected.push({ frame: frameKey, ...ev });
              }
            }
          }
        }

        if (allInjected.length > 0) {
          this.log(`  [ref-inject] ${node.id}: injected ${allInjected.length} ref(s): ${allInjected.map(i => `${i.frame}/${i.label}#${i.imageNumber}(${i.kind})`).join(', ')}`);
        }

        // (3.5) Enforce first_frame.generationMode against the
        // deterministic anchor decision the assembler wrote on the
        // parent scene_video_prompt. The LLM picks generationMode
        // itself; if it picked something inconsistent with the anchor
        // (e.g. image_text_to_image when the anchor says chain on the
        // prior shot), we override here. Logged so the override is
        // visible in executor.log.
        if (node.itemId) {
          const sceneId2 = node.itemId.match(/^(scene_\d+)/)?.[1];
          const shotNum2 = parseInt(node.itemId.match(/shot_(\d+)/)?.[1] ?? '0', 10);
          if (sceneId2 && shotNum2 > 0) {
            const anchor = readShotAnchorFromSvp(this.config.projectDir, sceneId2, shotNum2);
            if (anchor) {
              const r = enforceAnchorMode(
                parsed,
                anchor as Parameters<typeof enforceAnchorMode>[1],
              );
              if (r.changed) {
                this.log(`  [anchor-mode] ${node.id}: first_frame.generationMode ${r.previousMode} → ${r.enforcedMode} (anchor: ${anchor.reason}${anchor.sourceShotNumber ? `:${anchor.sourceShotNumber}` : ''})`);
              }
            }
          }
        }

        // (4) Hard gate: OTS prose + <2 character refs ⇒ reject.
        const otsIssues = scanOTSWithSingleChar(parsed);
        if (otsIssues.length > 0) {
          const detail = otsIssues
            .map(i => `${i.frame}: ${i.reason}`)
            .join(' | ');
          return { valid: false, error: `OTS-with-single-character violation. ${detail}` };
        }

        // (5) Semantic guards: shotNumber and ref mentions. The
        // existing JSON schema can't catch a model that hallucinates
        // an entirely unrelated scene (deepseek emitted "Elena in
        // apartment" for a Parvati/mudroom shot). These checks force
        // a regen via the json_repair → full-retry flow.
        const expectedShotNum = expectedShotNumberFromItemId(node.itemId);
        const shotNumCheck = validateShotNumber(parsed as { shotNumber?: unknown }, expectedShotNum);
        if (!shotNumCheck.valid) {
          return { valid: false, error: shotNumCheck.error ?? 'shotNumber mismatch' };
        }
        const refCheck = validateRefMentions(parsed, availableRefs.map(r => r.refId));
        if (!refCheck.valid) {
          return { valid: false, error: refCheck.error ?? 'ref-mention check failed' };
        }

        // (5.5) Invariant I3 — strip setting refs from any frame whose
        // generationMode is `edit_first_frame`. Klein uses the prior
        // frame's rendered image as slot 1 in that mode; the setting
        // is already baked into the canvas. Carrying a separate
        // `setting_image:X` ref produces two slot-1 candidates and
        // undefined binding. Deterministic by mode — NOT via prose
        // tag scanning (that was the inconsistent old heuristic).
        // Must run BEFORE the manifest post-pass so the manifest line
        // reflects the stripped ref set, not the pre-strip ref set.
        stripSettingFromEditFirstFrameFrames(parsed as { frames: Record<string, { generationMode?: string; references?: Reference[] } | undefined> });

        // (6) Pin the slot manifest at the TOP of every frame's
        // imagePrompt. Slot binding is authoritative via the manifest;
        // without this the 2026-05-20 Ruby V3 s1s1 frame had "Ruby
        // from image 1" buried mid-paragraph and no manifest at the
        // top — Flux Klein had no deterministic top-of-prompt anchor
        // to bind the character slot.
        //
        // This same helper is re-invoked after the turn-2 ref-refinement
        // LLM pass — the manifest must always reflect the CURRENT
        // references array, not whatever turn-1 wrote.
        applyShotImageManifestPostPass(parsed as { frames: Record<string, { imagePrompt?: string; references?: Reference[] } | undefined> });

        mutated = true;
      }

      return {
        valid: true,
        normalizedContent: mutated ? JSON.stringify(parsed, null, 2) : undefined,
      };
    } catch (e) {
      return { valid: false, error: `JSON parse error: ${String(e)}` };
    }
  }

  /**
   * Option 1 continuity check — sync JSON walk of scene_video_prompt shot list.
   * Logs warnings; does not reject.
   */
  private runContinuitySequenceCheck(svp: unknown, nodeId: string): void {
    try {
      const warnings = validateContinuitySequence(svp as Parameters<typeof validateContinuitySequence>[0]);
      if (warnings.length > 0) {
        this.log(`  [Continuity sequence] ${warnings.length} warning(s) for ${nodeId}:\n${formatContinuityWarnings(warnings)}`);
      }
    } catch (err) {
      this.log(`  [Continuity sequence] skipped: ${(err as Error).message}`);
    }
  }

  private runOneSettingPerSceneCheck(svp: unknown, nodeId: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { validateOneSettingPerScene } = require('./continuityValidator.js') as typeof import('./continuityValidator.js');
      const settingNodes = this.executor.getAllNodes().filter((n: any) =>
        n.typeId === 'setting_image' && n.itemId,
      );
      const knownSettingRefIds = settingNodes.map((n: any) => n.itemId as string);
      const shots = (svp as any)?.shots;
      if (!Array.isArray(shots)) return;
      const warnings = validateOneSettingPerScene({ shots, knownSettingRefIds });
      if (warnings.length > 0) {
        this.log(`  [One-setting-per-scene] ${warnings.length} warning(s) for ${nodeId}:\n${formatContinuityWarnings(warnings)}`);
      }
    } catch (err) {
      this.log(`  [One-setting-per-scene] skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Execute media generation with retry. Retries up to maxRetries times
   * with a delay between attempts for transient ComfyUI failures.
   */
  private async executeMediaGenerationWithRetry(
    node: ExecutionNode,
    promptPath: string,
    toolCallId: string,
    maxRetries = 2,
  ): Promise<string | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.executeMediaGeneration(node, promptPath, toolCallId);
      if (result) return result;

      if (attempt < maxRetries) {
        const delay = (attempt + 1) * 5000; // 5s, 10s
        this.log(`  Media gen failed for ${node.id}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        this.emit({
          type: 'notification',
          level: 'warning',
          message: `Retrying ${node.displayName} in ${delay / 1000}s...`,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return null;
  }

  /**
   * Build the full project reference list for normalizer injection.
   *
   * NOTE (Option B, 2026-04-24): this used to mirror the `generateForNode`
   * path (filter by shot purpose) so the numbers we inject match what
   * the LLM saw. But the filter excludes characters from shots with
   * purposes like `show_passage` and `set_the_world` — and the LLM
   * frequently names those filtered-out characters in its prose anyway
   * ("Isha mid-stride, Parvati lingering at the gate"). Without their
   * refs the image generator hallucinates what those characters look
   * like instead of loading their consistent reference images.
   *
   * Switching to UNFILTERED refs here means: if a character is named
   * in prose, we tag it with its canonical project-wide image number
   * and add it to the refs array, regardless of the purpose filter.
   * The reorder pass then renumbers the whole frame to a contiguous
   * 1..N so the final JSON is internally consistent. This preserves
   * character consistency at image-gen time without requiring the LLM
   * to respect the filter perfectly.
   *
   * Synchronous by design — called from validateJsonOutput. Returns an
   * empty array if anything is missing; callers treat that as "nothing
   * to inject."
   */

  /**
   * Scan a freshly-generated motion directive for ambiguous speaker
   * tags (bare "She says", "The woman says", etc.) when 2+ characters
   * are in the shot. Pure soft warning — logged to help diagnose
   * dialogue-to-mouth mis-attribution but does not block the run.
   *
   * Char list comes from the matching shot_image_prompt JSON's
   * references array. If the shot_image_prompt isn't readable yet we
   * skip silently — the scanner is best-effort.
   */
  private scanMotionDirectiveForAmbiguousSpeaker(node: ExecutionNode, content: string): void {
    if (!node.itemId) return;
    let motionDirective = '';
    try {
      const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, ''));
      motionDirective = typeof parsed?.motionDirective === 'string' ? parsed.motionDirective : '';
    } catch {
      return; // LLM output wasn't parseable JSON; nothing to scan
    }
    if (!motionDirective) return;

    const shotPromptNode = this.executor.getNode(`shot_image_prompt:${node.itemId}`);
    if (!shotPromptNode?.outputPath) return;
    const promptPath = join(this.config.projectDir, shotPromptNode.outputPath);
    if (!existsSync(promptPath)) return;

    const charsInShot: string[] = [];
    try {
      let raw = readFileSync(promptPath, 'utf-8').trim();
      if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      const shotJson = JSON.parse(raw);
      const seen = new Set<string>();
      for (const f of Object.values(shotJson.frames ?? {}) as Array<{ references?: Array<{ type?: string; refId?: string }> }>) {
        for (const r of f?.references ?? []) {
          if (r?.type === 'character' && typeof r.refId === 'string') {
            const label = r.refId.replace(/^character_image:/, '');
            if (label && !seen.has(label)) {
              seen.add(label);
              charsInShot.push(label);
            }
          }
        }
      }
    } catch {
      return;
    }

    const warnings = scanAmbiguousSpeakerTag(motionDirective, charsInShot);
    if (warnings.length > 0) {
      this.log(`  [ambiguous-speaker] ${node.id}: ${warnings.length} ambiguous tag(s) with ${charsInShot.length} chars in frame (${charsInShot.join(', ')}):`);
      for (const w of warnings) {
        this.log(`    - "${w.match}" → dialogue: "${w.quotedDialogue}"`);
      }
    }
  }

  private buildAvailableRefsForShot(node: ExecutionNode): AvailableRefMinimal[] {
    if (node.typeId !== 'shot_image_prompt' || !node.itemId) return [];

    const REF_TYPE_IDS = new Set(['character_image', 'setting_image', 'object_image']);
    const typeIdToRefType = (typeId: string): 'character' | 'setting' | 'object' => {
      if (typeId === 'character_image') return 'character';
      if (typeId === 'setting_image') return 'setting';
      return 'object';
    };
    const nodes = this.executor.getAllNodes().filter((n: any) =>
      REF_TYPE_IDS.has(n.typeId) && n.itemId,
    );
    const allRefs = nodes.map((n: any, i: number) => ({
      imageNumber: i + 1,
      type: typeIdToRefType(n.typeId),
      refId: n.id,
      label: n.itemId ?? n.id.split(':')[1] ?? n.id,
    }));

    // Use the same shot-aware narrowing the prompt-build path uses, so the
    // post-LLM normalizer rewrites references against the same canonical
    // (refId → imageNumber) mapping the LLM saw. Without this, the LLM was
    // given e.g. "image 1 = forest" and the normalizer would try to "fix"
    // it back to the global numbering (forest = image 8), corrupting the
    // prompt JSON. Static import because this is a sync code path on ESM.
    const sceneId = node.itemId.match(/(scene_\d+)/)?.[1];
    const shotNum = parseInt(node.itemId.match(/shot_(\d+)/)?.[1] ?? '0', 10);
    if (sceneId && shotNum > 0) {
      const ctx = readShotContextFromSvp(this.config.projectDir, sceneId, shotNum);
      if (ctx) {
        return buildShotAwareReferences(allRefs as any, ctx) as AvailableRefMinimal[];
      }
    }
    // Fallback to capped global ordering when the scene JSON isn't available
    // — at most 4 refs, settings preferred for slot 1.
    const settings = allRefs.filter(r => r.type === 'setting').slice(0, 1);
    const others = allRefs.filter(r => r.type !== 'setting').slice(0, 4 - settings.length);
    return [...settings, ...others].map((r, i) => ({ ...r, imageNumber: i + 1 }));
  }

  /**
   * Build reference image mapping for a shot_image_prompt node.
   * Reads the scene_video_prompt JSON to find which characters/setting are in this shot,
   * then tells the LLM which image N maps to what. Actual file resolution happens at
   * image generation time, not prompt generation time.
   */
  private buildShotReferenceMapping(node: ExecutionNode): string {
    if (!node.itemId) return '';

    // Extract scene ID and shot number: "scene_1_shot_2" → sceneId="scene_1", shotNum=2
    const sceneMatch = node.itemId.match(/(scene_\d+)/);
    const shotMatch = node.itemId.match(/shot_(\d+)/);
    if (!sceneMatch) return '';

    const sceneId = sceneMatch[1];
    const shotNum = shotMatch?.[1] ? parseInt(shotMatch[1], 10) : 1;

    // Find the scene_video_prompt output and read the JSON
    const svpNode = this.executor.getNode(`scene_video_prompt:${sceneId}`);
    if (!svpNode?.outputPath) return '';

    const fullPath = join(this.config.projectDir, svpNode.outputPath);
    if (!existsSync(fullPath)) return '';

    try {
      let content = readFileSync(fullPath, 'utf-8').trim();
      if (content.startsWith('```')) {
        content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsed = JSON.parse(content);
      const shot = parsed.shots?.find((s: { shotNumber: number }) => s.shotNumber === shotNum);
      if (!shot) return '';

      // Build reference image list from the scene_video_prompt JSON.
      // The refIds are deterministic (character_image:{charId}, setting_image:{settingId}).
      // Actual .png resolution happens at ComfyUI generation time, not here.
      // This allows shot prompts to be generated before/in parallel with image generation.
      const availableRefs: Array<{ imageNumber: number; type: string; refId: string; label: string }> = [];
      let imageNum = 1;

      // Support both new (firstFrame) and legacy (top-level) formats
      const characters: string[] = shot.firstFrame?.characters ?? shot.characters ?? [];
      for (const charId of characters) {
        availableRefs.push({ imageNumber: imageNum, type: 'character', refId: `character_image:${charId}`, label: charId });
        imageNum++;
      }

      const setting = shot.firstFrame?.setting ?? shot.setting;
      if (setting) {
        availableRefs.push({ imageNumber: imageNum, type: 'setting', refId: `setting_image:${setting}`, label: setting });
        imageNum++;
      }

      if (availableRefs.length === 0) {
        return '\n\n<available_references>\nNo reference images available. Set generationMode to "text_to_image" and references to [].\n</available_references>';
      }

      const refList = availableRefs.map(r =>
        `- image ${r.imageNumber}: ${r.type} "${r.label}" (ref_id: "${r.refId}")`
      ).join('\n');

      return `\n\n<available_references>\nAvailable reference images for this shot:\n${refList}\n\nUse "from image N" in your imagePrompt. Include each used reference in the "references" array with its ref_id.\n</available_references>`;
    } catch {
      return '';
    }
  }

  /**
   * Return the prompt JSON path IF the project.json says there's a valid
   * cached prompt for this node. Project.json is the source of truth —
   * orphan files on disk (e.g. left behind by a reset) do NOT count.
   *
   * Background: the executor has an optimization for media nodes — if
   * the prompt JSON is already on disk, skip the LLM and render only.
   * Previously this used pure filesystem existence, which meant
   * `/reset <stage>` → reset node to `pending` but keep file on disk
   * caused the next run to silently reuse the stale file. The reset's
   * intent was "regenerate," but the cache defeated it.
   *
   * Now: we only carry a prompt file across runs if `node.promptPath` is
   * explicitly set in project.json. Reset clears `promptPath`, so a
   * pending node with no `promptPath` ALWAYS regenerates — matching
   * the user's expectation of what "reset" means.
   */
  private findExistingPromptFile(node: ExecutionNode): string | null {
    // Source of truth: project.json must explicitly record a prompt path
    // before we trust any on-disk file. Orphan files are ignored.
    if (!node.promptPath) return null;

    const fullPath = join(this.config.projectDir, node.promptPath);
    if (!existsSync(fullPath)) {
      // project.json points at a file that's been deleted — also ignore.
      return null;
    }
    return node.promptPath;
  }

  /**
   * Get a clean, descriptive tool name for the UI based on node type and category.
   */
  private getToolDisplayName(node: ExecutionNode): string {
    const typeDef = this.config.template.artifactTypes[node.typeId];
    const category = typeDef?.category;

    // For visual_ref nodes, we're generating prompts not actual images
    if (category === 'visual_ref') {
      const base = node.typeId.replace(/_image$/, '').replace(/_/g, '_');
      return `gen_${base}_prompt`;
    }
    if (category === 'clip') {
      return `gen_${node.typeId.replace(/_/g, '_')}_prompt`;
    }

    // For text content, use a short descriptive name
    return `generate_${node.typeId}`;
  }

  /**
   * Build clean, human-readable arguments for the tool call display.
   * No JSON keys — just a descriptive summary.
   */
  private getToolDisplayArgs(
    node: ExecutionNode,
    inputs: ResolvedInputs,
  ): Record<string, unknown> {
    const args: Record<string, unknown> = {};

    // Show the item name prominently if it's a collection item
    if (node.itemId) {
      args['item'] = node.displayName;
    }

    // Show what context was loaded, as a simple list
    if (inputs.filesRead.length > 0) {
      args['context'] = inputs.filesRead.join(', ');
    }

    // Show reference images if any
    if (inputs.referenceImages.length > 0) {
      args['references'] = inputs.referenceImages.map(r => `${r.name} (${r.type})`).join(', ');
    }

    return args;
  }

  // ===========================================================================
  // Private: LLM generation
  // ===========================================================================

  /**
   * Turn 2 of the shot_image_prompt pipeline. Continues the same
   * conversation as turn 1 (the LLM's prose-emitting call) with a
   * new user message that hands the LLM the current existing-refs
   * menu and asks for a refined `references[]` per frame.
   *
   * Returns the same JSON string the caller already has, but with
   * each frame's `references` replaced by turn-2's authoritative
   * extraction. Returns null on any error (caller falls back to
   * turn-1's refs).
   *
   * Side A/B assignments emerge naturally because the LLM sees its
   * own prose in `turn1Content` as the assistant turn — OTS framing
   * language in the prose drives the side flag.
   */
  private async refineShotImageRefs(
    node: ExecutionNode,
    system: string,
    user: string,
    turn1Content: string,
    toolCallId: string | undefined,
    toolName: string,
  ): Promise<string | null> {
    // Parse turn-1 JSON. If it's not the expected shape, bail —
    // turn-1 content stays as-is.
    let turn1Parsed: {
      frames?: {
        first_frame?: { references?: unknown; imagePrompt?: string };
        last_frame?: { references?: unknown; imagePrompt?: string };
      };
    };
    try {
      turn1Parsed = JSON.parse(turn1Content);
    } catch {
      return null;
    }
    if (!turn1Parsed?.frames?.first_frame) return null;

    // Build the existing-refs menu from the project's
    // character_image / setting_image / object_image nodes that
    // have already been generated (status === 'completed'). Lazy
    // refs that haven't been rendered yet are excluded — they'd
    // create a chicken-and-egg cycle.
    const allNodes = this.executor.getAllNodes();
    const imageNodes = allNodes
      .filter(n =>
        n.itemId !== undefined &&
        (n.typeId === 'character_image' ||
          n.typeId === 'setting_image' ||
          n.typeId === 'object_image'),
      )
      .map(n => ({
        id: n.id,
        typeId: n.typeId,
        itemId: n.itemId,
        status: n.status,
      }));
    // Read the actual content file for each upstream collection item so
    // the turn-2 LLM has real visual context — not just a humanized
    // refId. This is what lets the LLM reason about Side A vs Side B
    // framing ("what's behind the camera in this bus station?"),
    // propose appropriate reverse-angle settings (Phase D), and assign
    // character roles (foreground vs OTS silhouette) consistently with
    // the prose it just wrote in turn 1.
    //
    // Path conventions come from narrative.ts:
    //   character → characters/{{name}}.md
    //   setting   → settings/{{name}}.md
    //   object    → objects/{{name}}.md
    //
    // Content is trimmed to a per-item budget so the menu stays small —
    // a 1000-word setting doc would blow up the turn-2 prompt.
    const PER_ITEM_DESC_CHARS = 600;
    const descFor = (
      type: 'character' | 'setting' | 'object',
      itemId: string,
    ): { label: string; description: string } => {
      const label = itemId
        .split('_')
        .map(p => p.charAt(0).toUpperCase() + p.slice(1))
        .join(' ');
      const folder = type === 'character' ? 'characters' :
        type === 'setting' ? 'settings' : 'objects';
      const contentPath = join(this.config.projectDir, folder, `${itemId}.md`);
      let description = '';
      try {
        if (existsSync(contentPath)) {
          const raw = readFileSync(contentPath, 'utf-8');
          // Strip the leading "# Title" heading and collapse whitespace
          // so the LLM sees prose rather than markdown chrome.
          const stripped = raw.replace(/^#[^\n]*\n+/, '').replace(/\s+/g, ' ').trim();
          description = stripped.length > PER_ITEM_DESC_CHARS
            ? `${stripped.slice(0, PER_ITEM_DESC_CHARS)}…`
            : stripped;
        }
      } catch {
        // File unreadable — leave description empty rather than crash.
      }
      return { label, description };
    };
    const menu: ReferenceMenuItem[] = buildReferenceMenu(imageNodes, descFor);
    if (menu.length === 0) {
      // Cold start: no existing refs yet. Without a menu the LLM has
      // nothing to anchor on — let turn-1's refs stand.
      return null;
    }

    // Build turn-2 user message. Pull an OTS hint from the shot
    // brief if it has perspective='ots' or framing keywords.
    const otsHint = this.shotBriefSuggestsOts(node);
    const turn2User = buildTurn2UserMessage(menu, { otsHint });

    // Run the LLM with [system, user, assistant(turn1), user(turn2)].
    // Non-streaming generate() — output is small.
    const purpose = this.purposeForNode(node);
    const client = this.llmFor(purpose);
    const messages: Message[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: turn1Content },
      { role: 'user', content: turn2User },
    ];
    const result = await client.generate({
      messages,
      temperature: 0.2,
      maxTokens: 2000,
      responseFormat: { type: 'json_object' },
      signal: this.runAbortController.signal,
    });
    const turn2Raw = result.content ?? '';
    if (!turn2Raw.trim()) return null;

    // Surface turn-2 in the tool stream so it's visible in the chat.
    if (toolCallId) {
      this.emit({
        type: 'tool_streaming',
        toolCallId,
        chunk: `\n[ref-extraction turn 2]\n${turn2Raw}\n`,
        done: false,
        agentName: this.config.name ?? 'dhee-executor',
        toolName,
      });
    }

    const refinedRefs: Reference[] = parseTurn2RefsJson(turn2Raw);
    if (refinedRefs.length === 0) {
      this.log(`  [shot_image_prompt turn-2] no refs parsed — keeping turn-1's array`);
      return null;
    }

    // Phase B+D: walk new refs and request collection expansion so the
    // executor creates corresponding character_image / setting_image
    // nodes before this shot's downstream shot_image runs.
    //
    // Dedup contract (Phase C-lite): expandCollection on an already-
    // expanded type-level node is a no-op and existing per-item nodes
    // are NOT overwritten. Two shots proposing the same canonical refId
    // (e.g. both ask for `setting_image:bus_station_morning_reverse`)
    // resolve to the SAME per-item node — same render, no duplicate
    // Klein call. The naming convention in turn-2's user message
    // ("name things by what they ARE, not which shot introduced them")
    // is what makes this work at the LLM layer; the no-op at the
    // executor layer is the safety net.
    const imageTypeIdFor = (refType: 'character' | 'setting' | 'object'): string =>
      refType === 'character' ? 'character_image' :
      refType === 'setting' ? 'setting_image' :
      'object_image';
    for (const ref of refinedRefs) {
      if (ref.status !== 'new') continue;
      const upstreamTypeId =
        ref.type === 'character' ? 'character' :
        ref.type === 'setting' ? 'setting' :
        'object';
      const imageTypeId = imageTypeIdFor(ref.type);
      const itemId = ref.refId.includes(':') ? ref.refId.split(':')[1]! : ref.refId;
      const label = itemId
        .split('_')
        .map(p => p.charAt(0).toUpperCase() + p.slice(1))
        .join(' ');
      const itemMetadata: import('./types.js').ExecutionNodeMetadata = {
        name: label,
        ...(ref.newRefDescription ? { description: ref.newRefDescription, summary: ref.newRefDescription } : {}),
      };
      try {
        this.executor.expandCollection(upstreamTypeId, [
          { itemId, name: label, metadata: itemMetadata },
        ]);
        this.log(
          `  [shot_image_prompt turn-2] expanded ${upstreamTypeId} with new item '${itemId}'`,
        );
      } catch (err) {
        // Already exists or expansion not applicable — non-fatal.
        this.log(
          `  [shot_image_prompt turn-2] expandCollection for ${upstreamTypeId}:${itemId} skipped: ${(err as Error).message}`,
        );
      }
      // Phase D: write derivedFrom + description directly onto the
      // cascaded image-level node so the renderer can switch to
      // chained-edit generation. The cascade from upstream collection
      // expansion creates `<imageTypeId>:<itemId>` via expandMatchingDependent,
      // which doesn't propagate metadata — set it here.
      const imageNodeId = `${imageTypeId}:${itemId}`;
      const imageNode = this.executor.getNode(imageNodeId);
      if (imageNode) {
        const merged: import('./types.js').ExecutionNodeMetadata = {
          ...(imageNode.metadata ?? {}),
          ...(ref.newRefDescription ? { description: ref.newRefDescription } : {}),
          ...(ref.derivedFrom ? { derivedFrom: this.normalizeDerivedFromRefId(ref.derivedFrom, ref.type) } : {}),
        };
        if (Object.keys(merged).length > 0) {
          imageNode.metadata = merged;
          if (ref.derivedFrom) {
            this.log(
              `  [shot_image_prompt turn-2] ${imageNodeId} marked derivedFrom=${merged.derivedFrom}`,
            );
          }
        }
      }
    }

    // Stitch the refined refs into the JSON. Both frames share the
    // same refs — the existing assembler at shotImagePipeline.ts
    // already collapses last_frame.references to [] in the final
    // canonical shape; here we keep turn-1's per-frame structure but
    // overwrite first_frame.references and let last_frame.references
    // mirror it (the deterministic slot manifest uses first_frame's
    // refs for both frames).
    //
    // The caller re-runs `validateJsonOutput` after this — its
    // post-pass at line ~5852 rebuilds the manifest prefix in each
    // frame's imagePrompt from the references array. That's what
    // keeps the manifest in sync with turn-2's authoritative refs.
    // We must NOT prepend the manifest here ourselves — that would
    // double up when the post-pass runs.
    if (turn1Parsed.frames) {
      if (turn1Parsed.frames.first_frame) {
        (turn1Parsed.frames.first_frame as { references: Reference[] }).references = refinedRefs;
      }
      if (turn1Parsed.frames.last_frame) {
        (turn1Parsed.frames.last_frame as { references: Reference[] }).references = refinedRefs;
      }
    }
    return JSON.stringify(turn1Parsed, null, 2);
  }

  /**
   * Coerce the LLM's `derivedFrom` value into a canonical image-node
   * refId. The LLM may emit the bare itemId (`bus_station_morning`),
   * the image-typed refId (`setting_image:bus_station_morning`), or
   * the upstream-typed refId (`setting:bus_station_morning`). Normalize
   * to the image typeId — that's what the renderer looks up.
   */
  private normalizeDerivedFromRefId(
    raw: string,
    refType: 'character' | 'setting' | 'object',
  ): string {
    const imageTypeId =
      refType === 'character' ? 'character_image' :
      refType === 'setting' ? 'setting_image' :
      'object_image';
    if (raw.startsWith(`${imageTypeId}:`)) return raw;
    if (raw.includes(':')) {
      // Other type prefix (e.g. `setting:`) — strip and re-prefix.
      const after = raw.split(':')[1]!;
      return `${imageTypeId}:${after}`;
    }
    return `${imageTypeId}:${raw}`;
  }

  /**
   * Heuristic check: does this shot's brief look like an OTS /
   * reverse-shot framing? Used to inject a hint into the turn-2
   * ref-extraction user message so Side A/B gets assigned even
   * when the prose's framing language is subtle.
   *
   * Reads the shot brief file on disk if present. False is the
   * safe default — turn-2 still works without an OTS hint, just
   * less aggressively flagged.
   */
  private shotBriefSuggestsOts(node: ExecutionNode): boolean {
    if (!node.itemId) return false;
    const match = node.itemId.match(/^scene_(\d+)_shot_(\d+)$/);
    if (!match) return false;
    const briefPath = join(
      this.config.projectDir,
      `prompts/videos/scenes/scene_${match[1]}.shots/${match[2]}.json`,
    );
    try {
      if (!existsSync(briefPath)) return false;
      const brief = JSON.parse(readFileSync(briefPath, 'utf-8')) as {
        perspective?: string;
        cameraWork?: string;
      };
      if (brief.perspective === 'ots') return true;
      const camera = (brief.cameraWork ?? '').toLowerCase();
      return /\b(over.the.shoulder|ots|reverse shot)\b/.test(camera);
    } catch {
      return false;
    }
  }

  /**
   * Call the LLM to generate content for a node.
   * Pure completion — no tools, no agent loop.
   */
  private async generateForNode(
    node: ExecutionNode,
    system: string,
    user: string,
    toolCallId?: string,
    toolDisplayName?: string,
    purposeOverride?: LLMPurpose,
  ): Promise<string> {
    const messages: Message[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    // Use lower temperature and suppress thinking for formulaic tasks (prompts)
    const typeDef = this.config.template.artifactTypes[node.typeId];
    const isFormulaic = typeDef?.category === 'visual_ref' || typeDef?.category === 'clip'
      || node.typeId === 'shot_image_prompt';

    const options: GenerateOptions = {
      messages,
      temperature: isFormulaic ? 0.3 : 0.7,
      // Propagate `agent.stop()` into the LLM stream so user-cancel
      // aborts in-flight HTTP requests, not just the executor loop.
      signal: this.runAbortController.signal,
    };

    // Force JSON output for all structured/image prompt nodes.
    // scene_video_prompt is intentionally NOT here — it's a deterministic
    // assembler post-refactor and never reaches this LLM path.
    const jsonNodeTypes = ['scene_shot_plan', 'shot_breakdown', 'shot_image_prompt', 'character_image', 'setting_image'];
    const isJsonNode = jsonNodeTypes.includes(node.typeId) || typeDef?.outputFormat === 'json';
    if (isJsonNode) {
      options.responseFormat = { type: 'json_object' };
      options.maxTokens = maxTokensForJsonNode(node.typeId);
    }

    // Inject JSON schema into the system prompt so the LLM sees the exact expected structure.
    // Schema text is generated from the same source (schemas.ts) that validates the output.
    if (isJsonNode) {
      const schema = getPromptSchema(node.typeId);
      if (schema) {
        messages[0]!.content += `\n\nCRITICAL: Your response MUST be a single valid JSON object. No markdown fences, no backticks, no commentary before or after the JSON. Output ONLY the JSON.\n\n${schema}`;
      }
    }

    const agentName = this.config.name ?? 'dhee-executor';
    const effectiveToolName = toolDisplayName ?? `generate_${node.typeId}`;
    // Think-tag parsing path — always active.
    // Separates <think> blocks from content and emits them separately.
    // Uses incremental flush to avoid unbounded buffer growth
    const contentChunks: string[] = [];
    let buffer = '';
    let insideThink = false;

    const purpose = purposeOverride ?? this.purposeForNode(node);
    const client = this.llmFor(purpose);
    for await (const chunk of client.generateStream(options)) {
      // Handle reasoning_content from llama.cpp (separate field, not in-band)
      if (chunk.thinking && toolCallId) {
        this.emit({
          type: 'tool_streaming',
          toolCallId, chunk: `<thinking>${chunk.thinking}</thinking>`, done: false,
          agentName, toolName: effectiveToolName,
        });
        continue; // Don't process as regular content
      }

      if (!chunk.content) continue;

      buffer += chunk.content;

      // Process buffer — flush as much as possible each iteration
      while (buffer.length > 0) {
        if (insideThink) {
          const closeIdx = buffer.indexOf('</think>');
          if (closeIdx !== -1) {
            const thinkContent = buffer.slice(0, closeIdx);
            if (thinkContent && toolCallId) {
              // Send thinking content to the tool card with a marker prefix
              this.emit({
                type: 'tool_streaming',
                toolCallId, chunk: `\n<thinking>${thinkContent}</thinking>\n`, done: false,
                agentName, toolName: effectiveToolName,
              });
            }
            buffer = buffer.slice(closeIdx + '</think>'.length);
            insideThink = false;
          } else {
            // Flush all but the last 8 chars (potential partial </think>)
            if (buffer.length > 8) {
              const flushContent = buffer.slice(0, -8);
              if (toolCallId) {
                this.emit({
                  type: 'tool_streaming',
                  toolCallId, chunk: `<thinking>${flushContent}</thinking>`, done: false,
                  agentName, toolName: effectiveToolName,
                });
              }
              buffer = buffer.slice(-8);
            }
            break;
          }
        } else {
          const openIdx = buffer.indexOf('<think>');
          if (openIdx !== -1) {
            const content = buffer.slice(0, openIdx);
            if (content) {
              contentChunks.push(content);
              if (toolCallId) {
                this.emit({
                  type: 'tool_streaming',
                  toolCallId, chunk: content, done: false,
                  agentName, toolName: effectiveToolName,
                });
              }
            }
            buffer = buffer.slice(openIdx + '<think>'.length);
            insideThink = true;
          } else {
            // Flush all but the last 7 chars (potential partial <think>)
            if (buffer.length > 7) {
              const safe = buffer.slice(0, -7);
              contentChunks.push(safe);
              if (toolCallId) {
                this.emit({
                  type: 'tool_streaming',
                  toolCallId, chunk: safe, done: false,
                  agentName, toolName: effectiveToolName,
                });
              }
              buffer = buffer.slice(-7);
            }
            break;
          }
        }
      }
    }

    // Flush remaining buffer
    if (buffer.length > 0 && !insideThink) {
      contentChunks.push(buffer);
      if (toolCallId) {
        this.emit({
          type: 'tool_streaming',
          toolCallId, chunk: buffer, done: false,
          agentName, toolName: effectiveToolName,
        });
      }
    }
    if (toolCallId) {
      this.emit({
        type: 'tool_streaming',
        toolCallId, chunk: '', done: true,
        agentName, toolName: effectiveToolName,
      });
    }

    return contentChunks.join('');
  }

  // ===========================================================================
  // Private: Collection expansion
  // ===========================================================================

  /**
   * After a node completes, extract collection items and expand dependent nodes.
   */
  private async handleCollectionExpansion(
    node: ExecutionNode,
    content: string,
    outputPath?: string,
  ): Promise<void> {
    const agentName = this.config.name ?? 'dhee-executor';

    // Determine what we're extracting based on node type
    const isShotExtraction = node.typeId === 'scene_video_prompt';
    const extractingLabel = isShotExtraction ? 'shots' : 'characters, settings, scenes';

    // Show the extraction in the UI as a tool call
    const extractCallId = `extract_${node.id}_${Date.now()}`;
    this.emit({
      type: 'tool_call',
      toolCallId: extractCallId,
      toolName: 'extract_collections',
      arguments: {
        source: node.displayName,
        extracting: extractingLabel,
        model: this.modelFor('structured.collection_extraction'),
      },
      agentName,
    });
    this.emit({
      type: 'tool_streaming',
      toolCallId: extractCallId,
      chunk: `Analyzing ${node.displayName} to extract ${extractingLabel}...`,
      done: false,
      agentName,
      toolName: 'extract_collections',
    });

    const items = await extractCollectionItems(node, content, this.llmFor('structured.collection_extraction'), this.config.goal.preferences.duration);

    if (!items) {
      this.log(`  No collection items extracted from ${node.id}`);
      this.emit({
        type: 'tool_result',
        toolCallId: extractCallId,
        toolName: 'extract_collections',
        result: { status: 'no items found' },
        agentName,
      });
      return;
    }
    this.log(`  Extracted: characters=${items.characters?.length ?? 0}, settings=${items.settings?.length ?? 0}, scenes=${items.scenes?.length ?? 0}, shots=${items.shots?.length ?? 0}`);

    // Stream the results
    const parts: string[] = [];
    if (items.characters?.length) parts.push(`**Characters:** ${items.characters.join(', ')}`);
    if (items.settings?.length) parts.push(`**Settings:** ${items.settings.join(', ')}`);
    if (items.scenes?.length) parts.push(`**Scenes:** ${items.scenes.map(s => `${s.sceneNumber}. ${s.title}`).join(', ')}`);
    if (items.shots?.length) parts.push(`**Shots:** ${items.shots.map(s => `${s.shotNumber}. ${s.shotType}`).join(', ')}`);

    this.emit({
      type: 'tool_streaming',
      toolCallId: extractCallId,
      chunk: `\n\n${parts.join('\n')}`,
      done: true,
      agentName,
      toolName: 'extract_collections',
    });
    this.emit({
      type: 'tool_result',
      toolCallId: extractCallId,
      toolName: 'extract_collections',
      result: {
        characters: items.characters,
        settings: items.settings,
        scenes: items.scenes?.map(s => s.title),
        shots: items.shots?.map(s => `${s.shotNumber}: ${s.shotType}`),
      },
      agentName,
    });

    if (isShotExtraction && node.itemId) {
      const result = this.materializeSceneBreakdown(node.itemId, {
        sceneVideoPromptNode: node,
        sceneVideoPromptOutputPath: outputPath,
        content,
        emitNotifications: true,
      });
      this.emitTodoUpdate();
      if (!result.success) {
        throw new Error(
          `Scene materialization failed for ${node.itemId}: ` +
          `reason=${result.failureReason ?? 'unknown'} ` +
          `expected=[${result.expectedTimelineSegmentIds.join(', ')}] actual=[${result.actualTimelineSegmentIds.join(', ')}]`
        );
      }
      return;
    }

    // Handle story/outline-level expansion: characters, settings, scenes
    const collectionDeps = this.executor.getCollectionDependents(node);

    for (const depTypeId of collectionDeps) {
      const depTypeDef = this.config.template.artifactTypes[depTypeId];
      if (!depTypeDef) continue;

      // Determine which items apply to this dependent type
      let applicableItems: Array<{ itemId: string; name: string }> = [];

      if (depTypeId === 'character' || depTypeId.includes('character')) {
        applicableItems = (items.characters ?? []).map(name => ({
          itemId: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          name,
        }));
      } else if (depTypeId === 'setting' || depTypeId.includes('setting')) {
        applicableItems = (items.settings ?? []).map(name => ({
          itemId: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          name,
        }));
      } else if (depTypeId === 'scene' || depTypeId.includes('scene')) {
        applicableItems = (items.scenes ?? []).map(s => ({
          itemId: `scene_${s.sceneNumber}`,
          name: s.title,
        }));
        // Store scene summaries for injection into scene writer prompts.
        // Save to disk so they survive restarts. Also capture per-scene
        // estimatedDuration if the duration-first extractor populated it.
        // Use syncSceneArtifacts so re-runs with fewer scenes drop stale
        // keys (scene_3/scene_4 leftover from a prior 4-scene run).
        syncSceneArtifacts(items.scenes ?? [], this.sceneSummaries, this.sceneEstimatedDurations);
        if (this.sceneSummaries.size > 0) {
          const summaryPath = join(this.config.projectDir, 'prompts', 'scene_summaries.json');
          if (!existsSync(join(this.config.projectDir, 'prompts'))) mkdirSync(join(this.config.projectDir, 'prompts'), { recursive: true });
          atomicWriteFileSync(summaryPath, JSON.stringify(Object.fromEntries(this.sceneSummaries), null, 2));
        }
        if (this.sceneEstimatedDurations.size > 0) {
          const durPath = join(this.config.projectDir, 'prompts', 'scene_durations.json');
          if (!existsSync(join(this.config.projectDir, 'prompts'))) mkdirSync(join(this.config.projectDir, 'prompts'), { recursive: true });
          atomicWriteFileSync(durPath, JSON.stringify(Object.fromEntries(this.sceneEstimatedDurations), null, 2));
        }
      }

      if (applicableItems.length > 0) {
        this.log(`  Expanding ${depTypeId}: ${applicableItems.map(i => i.name).join(', ')}`);
        this.executor.expandCollection(depTypeId, applicableItems);
        this.emit({
          type: 'notification',
          level: 'info',
          message: `Expanded ${depTypeDef.displayName}: ${applicableItems.map(i => i.name).join(', ')}`,
        });
      }
    }
  }

  // ===========================================================================
  // Private: User approval
  // ===========================================================================

  /**
   * Ask the user for approval before an expensive operation.
   * Returns true if approved, false if skipped.
   *
   * For now, auto-approves. Full implementation will use the question event
   * and wait for user input injection.
   */
  private async askApproval(
    _node: ExecutionNode,
    _inputs: ResolvedInputs,
  ): Promise<boolean> {
    // TODO: Implement user approval flow via question event + input injection
    // For now, auto-approve all operations
    return true;
  }

  // ===========================================================================
  // Private: State persistence
  // ===========================================================================

  /**
   * Persist executor state to project.json.
   */
  // ===========================================================================
  // Private: Deterministic media generation
  // ===========================================================================

  /**
   * Execute actual media generation after the LLM has written a prompt file.
   * This is deterministic — reads the prompt file, calls the provider, saves the result.
   * Returns the actual media file path, or null if generation fails.
   */
  private async executeMediaGeneration(
    node: ExecutionNode,
    promptFilePath: string,
    toolCallId: string,
  ): Promise<string | null> {
    const agentName = this.config.name ?? 'dhee-executor';
    const projectDir = this.config.projectDir;
    const fullPromptPath = join(projectDir, promptFilePath);

    if (!existsSync(fullPromptPath)) {
      const msg = `prompt file not found: ${fullPromptPath}`;
      this.log(`  Media gen: ${msg}`);
      this.lastNodeError = `Media gen: ${msg}`;
      return null;
    }

    // Check if image generation provider is available
    try {
      const provider = getProviderRegistry().getImageGenerator();
      if (!provider) {
        const msg = 'no image generation provider configured';
        this.log(`  Media gen: ${msg}`);
        this.lastNodeError = `Media gen: ${msg}`;
        this.emit({
          type: 'notification',
          level: 'warning',
          message: `No image provider available — skipping media gen for ${node.displayName}. Prompt saved.`,
        });
        return null;
      }
    } catch (err) {
      const errStr = String(err);
      this.log(`  Media gen: provider check failed: ${errStr}`);
      this.lastNodeError = `Media gen: provider check failed (${errStr})`;
      this.emit({
        type: 'notification',
        level: 'warning',
        message: `Image provider not reachable — skipping media gen for ${node.displayName}. Prompt saved.`,
      });
      return null;
    }

    const typeDef = this.config.template.artifactTypes[node.typeId];
    const category = typeDef?.category;

    if (category === 'visual_ref') {
      return this.executeImageGeneration(node, fullPromptPath, toolCallId, agentName);
    } else if (category === 'clip') {
      return this.executeVideoGeneration(node, fullPromptPath, toolCallId, agentName);
    }

    return null;
  }

  /**
   * Read the generationStrategy for a shot node.
   * Checks shot_image_prompt first (preferred — slim scene breakdown),
   * then falls back to scene_video_prompt (legacy).
   */
  private getGenerationStrategy(node: ExecutionNode): string {
    if (!node.itemId) return 'i2v';

    // 1. Check shot_image_prompt output (preferred source in slim scene breakdown)
    const sipNode = this.executor.getNode(`shot_image_prompt:${node.itemId}`);
    if (sipNode?.outputPath) {
      const sipPath = join(this.config.projectDir, sipNode.outputPath);
      if (existsSync(sipPath)) {
        try {
          let content = readFileSync(sipPath, 'utf-8').trim();
          if (content.startsWith('```')) {
            content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          }
          const parsed = JSON.parse(content);
          if (parsed.generationStrategy) {
            return parsed.generationStrategy;
          }
        } catch { /* fall through */ }
      }
    }

    // 2. Fallback: check scene_video_prompt (legacy format with generationStrategy on shots)
    const sceneMatch = node.itemId.match(/scene_(\d+)/);
    const shotMatch = node.itemId.match(/shot_(\d+)/);
    if (!sceneMatch) return 'i2v';

    const sceneNum = parseInt(sceneMatch[1]!, 10);
    const shotNum = shotMatch?.[1] ? parseInt(shotMatch[1], 10) : 1;

    const svpNode = this.executor.getNode(`scene_video_prompt:scene_${sceneNum}`);
    if (!svpNode?.outputPath) return 'i2v';

    const fullPath = join(this.config.projectDir, svpNode.outputPath);
    if (!existsSync(fullPath)) return 'i2v';

    try {
      let content = readFileSync(fullPath, 'utf-8').trim();
      if (content.startsWith('```')) {
        content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsed = JSON.parse(content);
      const shot = parsed.shots?.find((s: { shotNumber: number }) => s.shotNumber === shotNum);
      return shot?.videoGenerationMode || shot?.generationStrategy || 'i2v';
    } catch {
      return 'i2v';
    }
  }

  /**
   * Execute a shot_image node: read the prompt JSON from the shot_image_prompt dependency,
   * resolve reference image paths, and submit to ComfyUI.
   */
  private async executeShotImage(
    node: ExecutionNode,
    toolCallId: string,
  ): Promise<string | null> {
    // Find the MATCHING shot_image_prompt dependency (same itemId) and read its JSON output
    const matchingPromptId = `shot_image_prompt:${node.itemId}`;
    let promptDep = this.executor.getNode(matchingPromptId);
    if (!promptDep || promptDep.status !== 'completed') {
      // Fallback: find any shot_image_prompt dep with matching itemId
      promptDep = node.dependencies
        .map(depId => this.executor.getNode(depId))
        .find(n => n?.typeId === 'shot_image_prompt' && n.itemId === node.itemId && n.status === 'completed') ?? undefined;
    }

    if (!promptDep?.outputPath) {
      this.log(`  No completed shot_image_prompt dependency for ${node.id}`);
      return null;
    }

    const jsonPath = join(this.config.projectDir, promptDep.outputPath);
    if (!existsSync(jsonPath)) {
      this.log(`  Shot image prompt file not found: ${jsonPath}`);
      return null;
    }

    const jsonContent = readFileSync(jsonPath, 'utf-8');

    // Validate the prompt JSON — if corrupt, invalidate the prompt node and return null
    // so the executor regenerates it on next run
    let parsedJson: any;
    try {
      let cleaned = jsonContent.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      parsedJson = JSON.parse(cleaned);
    } catch (parseErr) {
      this.log(`  Shot image prompt JSON is corrupt: ${(parseErr as Error).message}`);
      this.log(`  Invalidating corrupt prompt → will regenerate on next run`);
      this.executor.invalidateNode(promptDep.id);
      this.persistState();
      return null;
    }

    // Validate structure: must have either frames.first_frame or imagePrompt
    const hasFrames = parsedJson?.frames && typeof parsedJson.frames === 'object';
    const hasImagePrompt = typeof parsedJson?.imagePrompt === 'string';
    if (!hasFrames && !hasImagePrompt) {
      this.log(`  Shot image prompt has no frames or imagePrompt — invalidating`);
      this.executor.invalidateNode(promptDep.id);
      this.persistState();
      return null;
    }

    if (hasFrames && !parsedJson.frames['first_frame']?.imagePrompt) {
      this.log(`  Shot image prompt frames missing first_frame.imagePrompt — invalidating`);
      this.executor.invalidateNode(promptDep.id);
      this.persistState();
      return null;
    }

    if (hasFrames) {
      // New per-frame format: each frame has its own prompt and generation mode
      this.log(`  Per-frame format detected: ${Object.keys(parsedJson.frames).join(', ')}`);

      // Normalization (inject + reorder) happens upstream in
      // validateJsonOutput, so the JSON on disk is already normalized.
      // We still run a defensive reorder pass here for JSONs that
      // bypassed validation (e.g. hand-edited prompt files, legacy
      // fixtures). It's idempotent if already normalized.
      for (const frameKey of Object.keys(parsedJson.frames)) {
        const f = parsedJson.frames[frameKey];
        if (f && typeof f === 'object' && typeof f.imagePrompt === 'string' && Array.isArray(f.references)) {
          parsedJson.frames[frameKey] = normalizeShotImagePromptFrame(f);
        }
      }

      // Generate first_frame
      const firstFrameData = parsedJson.frames['first_frame'];
      if (!firstFrameData) {
        this.log(`  No first_frame in frames object`);
        return null;
      }

      let firstFramePath: string | null = null;
      let firstFrameMode = firstFrameData.generationMode || 'image_text_to_image';

      // Continuity policy override (Layer B/C2 enforcement). The LLM
      // frequently picks `image_text_to_image` even when policy says we
      // should chain on the prior shot. Trust the deterministic policy
      // instead — the user's rule is "within a scene only camera-angle
      // changes" and "scene N+1 picks up from scene N's last frame when
      // an `entry` is declared." See shouldForceEditPrevious.
      //
      // Skip the override when the anchor already picked
      // `reuse_prior_frame` — that's the strongest signal ("view
      // matches the source, no new image needed"), so we must NOT
      // demote it to edit_previous_shot.
      if (node.itemId && firstFrameMode !== 'edit_previous_shot' && firstFrameMode !== 'reuse_prior_frame') {
        const peekPrevItemId = getPreviousShotIdAcrossScenes(node.itemId, this.executor);
        const peekPrevNode = peekPrevItemId ? this.executor.getNode(`shot_image:${peekPrevItemId}`) : null;
        const previousShotAvailable = peekPrevNode?.status === 'completed';
        const sceneId = node.itemId.match(/(scene_\d+)/)?.[1];
        const shotNum = parseInt(node.itemId.match(/shot_(\d+)/)?.[1] ?? '0', 10);
        const ctx = sceneId && shotNum > 0
          ? readShotContextFromSvp(this.config.projectDir, sceneId, shotNum)
          : null;
        if (shouldForceEditPrevious({
          itemId: node.itemId,
          previousShotAvailable,
          continuityRole: ctx?.continuityRole,
          purpose: ctx?.purpose,
          sceneEntry: ctx?.sceneEntry,
        })) {
          this.log(`  Continuity policy: forcing edit_previous_shot for ${node.itemId} (LLM had picked "${firstFrameMode}")`);
          firstFrameMode = 'edit_previous_shot';
          // Mirror the override into the on-disk JSON so downstream
          // (e.g. last_frame, motion directive) sees the corrected mode.
          firstFrameData.generationMode = 'edit_previous_shot';
        }
      }

      if (firstFrameMode === 'reuse_prior_frame') {
        // View matches the source shot — its last_frame IS this shot's
        // first_frame. Copy the file verbatim instead of running the
        // image-edit pipeline. The source's scene+shot is encoded in
        // the anchor; resolve to the live `shot_image_last_frame` node
        // (or the upstream `shot_image:X.outputPaths.last_frame` for
        // legacy projects) and `copyFileSync` to this shot's first_frame
        // path. Byte-identical cut points are the goal.
        const sceneIdFromItem = node.itemId?.match(/(scene_\d+)/)?.[1];
        const sceneNumFromItem = parseInt(node.itemId?.match(/scene_(\d+)/)?.[1] ?? '0', 10);
        const shotNumFromItem = parseInt(node.itemId?.match(/shot_(\d+)/)?.[1] ?? '0', 10);
        const anchor = sceneIdFromItem && shotNumFromItem > 0
          ? readShotAnchorFromSvp(this.config.projectDir, sceneIdFromItem, shotNumFromItem)
          : null;
        // Fallback for the boundary-planner-driven reuse_prior_frame
        // path: when the SVP doesn't carry an anchor (the boundary
        // planner doesn't mutate the SVP — it writes to
        // project.scenes), look up the shot's incomingTransition and,
        // when it's `shared_frame`, use shotNumber-1 in the same scene
        // as the source. Without this fallback, mode flips to
        // reuse_prior_frame would dead-end here (sourceShotNum=0).
        let fallbackSourceShotNum: number | undefined;
        if (!anchor && sceneNumFromItem > 0 && shotNumFromItem > 1) {
          const projectAny = this.config.project as {
            scenes?: Array<{
              sceneNumber?: number;
              shots?: Array<{
                shotNumber?: number;
                incomingTransition?: { operation?: string };
              }>;
            }>;
          } | undefined;
          const sceneShots = projectAny?.scenes?.find((s) => s.sceneNumber === sceneNumFromItem)?.shots;
          const thisShot = sceneShots?.find((s) => s.shotNumber === shotNumFromItem);
          if (thisShot?.incomingTransition?.operation === 'shared_frame') {
            fallbackSourceShotNum = shotNumFromItem - 1;
            this.log(
              `  reuse_prior_frame: SVP anchor missing, falling back to boundary-planner shared_frame source: scene_${sceneNumFromItem}_shot_${fallbackSourceShotNum}`,
            );
          }
        }
        const sourceSceneId = anchor?.sourceSceneId ?? sceneIdFromItem;
        const sourceShotNum = anchor?.sourceShotNumber ?? fallbackSourceShotNum ?? 0;
        if (sourceSceneId && sourceShotNum > 0) {
          const sourceItemId = `${sourceSceneId}_shot_${sourceShotNum}`;
          const { getLastFramePath } = await import('./crossShotChaining.js');
          const sourceBridge = this.executor.getNode(`shot_image_last_frame:${sourceItemId}`);
          const sourceShotNode = this.executor.getNode(`shot_image:${sourceItemId}`);
          // Resolution order:
          //   1. Bridge node, when completed → its outputPath IS the LF.
          //   2. shot_image.outputPaths.last_frame (multi-frame mode).
          //   3. shot_image.outputPath ONLY when no bridge exists
          //      (i2v / single-frame mode where outputPath semantically IS
          //      the LF). When a bridge exists but isn't completed yet
          //      (boundary-planner race condition: shot N+1 fires
          //      immediately after shot N's FF before shot N's LF bridge
          //      runs), we must NOT fall back to shot_image.outputPath —
          //      that's the FF, copying it would silently corrupt the
          //      shared_frame guarantee. Return null and let the caller
          //      fall through (will retry via edit_previous_shot, which
          //      handles the missing-LF case more gracefully).
          let sourceLastFrame: string | null = null;
          if (sourceBridge) {
            // Bridge exists. It is the authoritative LF source. ONLY use
            // outputPath when bridge is completed.
            if (sourceBridge.status === 'completed' && sourceBridge.outputPath) {
              sourceLastFrame = sourceBridge.outputPath;
            } else {
              this.log(
                `  reuse_prior_frame: source LF bridge ${sourceBridge.id} not completed (status=${sourceBridge.status ?? 'unknown'}) — refusing to fall back to FF; failing the reuse`,
              );
              // Leave sourceLastFrame null so the outer block falls
              // through to edit_previous_shot.
            }
          } else if (sourceShotNode) {
            // No bridge node — legacy / i2v. shot_image.outputPath IS the LF.
            sourceLastFrame = getLastFramePath(sourceShotNode);
          }
          if (sourceLastFrame) {
            const assetsDir = join(this.config.projectDir, 'assets', 'images');
            if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
            const sourceAbs = sourceLastFrame.startsWith('/')
              ? sourceLastFrame
              : join(this.config.projectDir, sourceLastFrame);
            const ext = (sourceAbs.match(/\.(png|jpe?g|webp)$/i)?.[1] ?? 'png').toLowerCase();
            const destAbs = join(assetsDir, `${node.itemId}_first_frame_reuse.${ext}`);
            try {
              const { copyFileSync } = await import('fs');
              copyFileSync(sourceAbs, destAbs);
              firstFramePath = relative(this.config.projectDir, destAbs);
              this.log(`  first_frame (reuse_prior_frame): copied from ${sourceLastFrame} → ${firstFramePath}`);
            } catch (err) {
              this.log(`  reuse_prior_frame copy failed (${(err as Error).message}) — falling back to edit_previous_shot`);
              // Fall through to edit_previous_shot path below by
              // re-tagging the mode. The fallback handles the same
              // cross-shot scenario.
              firstFrameMode = 'edit_previous_shot';
            }
          } else {
            this.log(`  reuse_prior_frame: no source last_frame found (${sourceItemId}) — falling back to edit_previous_shot`);
            firstFrameMode = 'edit_previous_shot';
          }
        } else {
          this.log(`  reuse_prior_frame: anchor missing source — falling back to edit_previous_shot`);
          firstFrameMode = 'edit_previous_shot';
        }
      }

      if (firstFrameMode === 'edit_previous_shot') {
        // Cross-shot chaining: edit the previous shot's last frame.
        // Pattern B Phase 2: last_frame lives on the dedicated
        // shot_image_last_frame:X node. Fall back to the upstream
        // shot_image:X.outputPaths.last_frame for legacy projects
        // whose bridge node never ran (Phase 1 mirror).
        //
        // Layer C2: when this is shot 1 of scene N>1 we look across the
        // scene boundary at the prior scene's last completed shot. This
        // is what implements the "exits door A in scene N → enters door B
        // in scene N+1" continuity rule.
        const { getPreviousShotIdAcrossScenes, getLastFramePath } = await import('./crossShotChaining.js');
        const prevShotItemId = node.itemId ? getPreviousShotIdAcrossScenes(node.itemId, this.executor) : null;
        const prevBridgeNode = prevShotItemId
          ? this.executor.getNode(`shot_image_last_frame:${prevShotItemId}`)
          : null;
        const prevShotNode = prevShotItemId
          ? this.executor.getNode(`shot_image:${prevShotItemId}`)
          : null;
        const prevLastFrame =
          (prevBridgeNode?.status === 'completed' && prevBridgeNode.outputPath
            ? prevBridgeNode.outputPath
            : null)
          ?? (prevShotNode ? getLastFramePath(prevShotNode) : null);

        if (prevLastFrame) {
          const prevLastFrameAbs = join(this.config.projectDir, prevLastFrame);
          this.log(`  Cross-shot chaining: editing previous shot's last frame (${prevLastFrame})`);
          const provider = getProviderRegistry().getImageEditor();
          if (provider?.editImage) {
            const assetsDir = join(this.config.projectDir, 'assets', 'images');
            if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
            // Resolve character/setting refs — layered editing handles >4 refs
            const editRefPaths = this.resolveRefIds(firstFrameData.references ?? []);
            this.log(`  edit_previous_shot: ${editRefPaths.length} refs (layered if >4)`);
            const editFilePath = await this.editImageLayered(
              firstFrameData.imagePrompt,
              prevLastFrameAbs,
              editRefPaths,
              assetsDir,
              `${node.itemId}_first_frame`,
            );
            firstFramePath = relative(this.config.projectDir, editFilePath);
            this.log(`  first_frame (edit_previous_shot): ${firstFramePath}`);
          } else {
            this.log(`  No image editor — falling back to image_text_to_image`);
          }
        } else {
          this.log(`  No previous shot last frame found — falling back to image_text_to_image`);
        }
      }

      // Check if first_frame was already generated in a previous attempt (incremental retry)
      if (!firstFramePath && node.outputPaths?.['first_frame']) {
        const existingFirst = join(this.config.projectDir, node.outputPaths['first_frame']);
        if (existsSync(existingFirst)) {
          firstFramePath = node.outputPaths['first_frame'];
          this.log(`  first_frame already exists (incremental retry): ${firstFramePath}`);
        }
      }

      // Fallback: generate from refs if edit_previous_shot didn't produce a result
      if (!firstFramePath) {
        const firstFrameJson = JSON.stringify({
          imagePrompt: firstFrameData.imagePrompt,
          negativePrompt: parsedJson.negativePrompt || '',
          aspectRatio: parsedJson.aspectRatio || '16:9',
          generationMode: firstFrameMode === 'edit_previous_shot' ? 'image_text_to_image' : firstFrameMode,
          references: firstFrameData.references || [],
        });
        firstFramePath = await this.executeShotImageGeneration(node, firstFrameJson, toolCallId, 'first_frame');
        if (!firstFramePath) return null;
      }

      // Generate additional frames. In prompt_relay mode (default),
      // last/mid frames are skipped — the relay renders the whole scene
      // as one mp4 driven only by per-segment first_frames, so any
      // extra frames burn image-gen budget for nothing.
      //
      // Pattern B Phase 2: `last_frame` is excluded here — it lives on
      // the dedicated `shot_image_last_frame:X` node now (see
      // executeShotImageLastFrame.ts). `executeShotImage` only
      // produces `first_frame` (and `mid_frame` when present).
      const additionalFrames = Object.keys(parsedJson.frames)
        .filter(k => k !== 'first_frame' && k !== 'last_frame')
        .filter(k => shouldGenerateExtraFrame(k));
      if (isPromptRelayMode() && additionalFrames.length === 0) {
        const skipped = Object.keys(parsedJson.frames).filter(k => k !== 'first_frame');
        if (skipped.length > 0) this.log(`  prompt_relay mode: skipping extra frames ${skipped.join(', ')}`);
      }
      if (additionalFrames.length > 0) {
        node.outputPaths = { ...node.outputPaths, first_frame: firstFramePath };

        const agentName = this.config.name ?? 'dhee-executor';

        for (const frameId of additionalFrames) {
          const frameData = parsedJson.frames[frameId];
          if (!frameData?.imagePrompt) continue;

          // Check if this frame was already generated (incremental retry)
          if (node.outputPaths?.[frameId]) {
            const existingFrame = join(this.config.projectDir, node.outputPaths[frameId]);
            if (existsSync(existingFrame)) {
              this.log(`  ${frameId} already exists (incremental retry): ${node.outputPaths[frameId]}`);
              continue;
            }
          }

          const mode = frameData.generationMode || 'edit_first_frame';
          this.log(`  Generating ${frameId} (mode: ${mode})`);

          // Emit tool_call so the frame shows as its own card in the UI
          const frameCallId = `frame_${node.itemId}_${frameId}_${Date.now()}`;
          const frameToolName = 'generate_frame_image';
          this.emit({
            type: 'tool_call',
            toolCallId: frameCallId,
            toolName: frameToolName,
            arguments: {
              item: `${node.displayName} — ${frameId.replace('_', ' ')}`,
              mode,
              prompt: frameData.imagePrompt.substring(0, 150) + '...',
            },
            agentName,
          });
          this.emit({
            type: 'tool_streaming',
            toolCallId: frameCallId,
            chunk: `Generating ${frameId} (${mode})...`,
            done: false,
            agentName,
            toolName: frameToolName,
          });

          let frameRelPath: string | null = null;

          if (mode === 'edit_first_frame') {
            const firstFrameAbsPath = join(this.config.projectDir, firstFramePath);
            const provider = getProviderRegistry().getImageEditor();
            if (provider?.editImage) {
              const assetsDir = join(this.config.projectDir, 'assets', 'images');
              if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
              // Resolve refs — use first_frame refs if last_frame has none; layered if >4
              const frameRefs = frameData.references?.length > 0
                ? frameData.references
                : (firstFrameData.references ?? []);
              const editRefPaths = this.resolveRefIds(frameRefs);
              this.log(`  ${frameId} (edit_first_frame): ${editRefPaths.length} refs (layered if >4)`);
              const editFilePath = await this.editImageLayered(
                frameData.imagePrompt,
                firstFrameAbsPath,
                editRefPaths,
                assetsDir,
                `${node.itemId}_${frameId}`,
              );
              frameRelPath = relative(this.config.projectDir, editFilePath);
              node.outputPaths[frameId] = frameRelPath;
              this.log(`  ${frameId} (edit_first_frame): ${frameRelPath}`);
            } else {
              this.log(`  No image editor available — falling back to independent generation for ${frameId}`);
              const frameJson = JSON.stringify({
                imagePrompt: frameData.imagePrompt,
                negativePrompt: parsedJson.negativePrompt || '',
                aspectRatio: parsedJson.aspectRatio || '16:9',
                generationMode: 'image_text_to_image',
                references: frameData.references || firstFrameData.references || [],
              });
              const framePath = await this.executeShotImageGeneration(node, frameJson, toolCallId, frameId);
              if (framePath) {
                frameRelPath = framePath;
                node.outputPaths[frameId] = framePath;
                this.log(`  ${frameId} (fallback): ${framePath}`);
              }
            }
          } else {
            const frameJson = JSON.stringify({
              imagePrompt: frameData.imagePrompt,
              negativePrompt: parsedJson.negativePrompt || '',
              aspectRatio: parsedJson.aspectRatio || '16:9',
              generationMode: mode,
              references: frameData.references || [],
            });
            const framePath = await this.executeShotImageGeneration(node, frameJson, toolCallId, frameId);
            if (framePath) {
              frameRelPath = framePath;
              node.outputPaths[frameId] = framePath;
              this.log(`  ${frameId} (${mode}): ${framePath}`);
            }
          }

          // Emit result and register asset
          if (frameRelPath) {
            this.emit({
              type: 'tool_streaming',
              toolCallId: frameCallId,
              chunk: `${frameId} saved: ${frameRelPath}`,
              done: true,
              agentName,
              toolName: frameToolName,
            });
            this.emit({
              type: 'tool_result',
              toolCallId: frameCallId,
              toolName: frameToolName,
              result: { status: 'completed', file_path: frameRelPath, frame: frameId },
              agentName,
            });
            // Register as asset so it shows in sidebar AND lands
            // in project.scenes[].shots[].{firstFrame|lastFrame|midFrame}.
            // Critically: pass `frame: frameId` — without it,
            // applyAssetToProjectSchema bails and the scenes-tree
            // mirror never populates. Pinned by
            // tests/unit/addAssetDualWrite.test.ts under
            // "scene_image with nodeId but NO frame → scenes stays empty".
            // The narrow cast is safe: additionalFrames is filtered
            // through `shouldGenerateExtraFrame` which only admits the
            // three known frame keys.
            const narrowFrame =
              frameId === 'first_frame' || frameId === 'last_frame' || frameId === 'mid_frame'
                ? frameId
                : undefined;
            try {
              addAsset({
                id: `frame_${node.itemId}_${frameId}_${Date.now()}`,
                type: 'scene_image',
                path: frameRelPath,
                createdAt: Date.now(),
                nodeId: node.id,
                ...(narrowFrame ? { frame: narrowFrame } : {}),
              });
            } catch { /* non-fatal */ }
          } else {
            this.emit({
              type: 'tool_result',
              toolCallId: frameCallId,
              toolName: frameToolName,
              result: { status: 'failed', frame: frameId },
              agentName,
            });
          }
        }
        this.log(`  Multi-frame: ${Object.keys(node.outputPaths).length} frames generated`);
      }

      return firstFramePath;
    }

    // Legacy single-prompt format (i2v, t2v, or old-style shots)
    const firstFramePath = await this.executeShotImageGeneration(node, jsonContent, toolCallId, 'first_frame');
    if (!firstFramePath) return null;

    // Check if the video generation mode requires additional frame images
    const strategy = this.getGenerationStrategy(node);
    try {
      const modeRegistry = getWorkflowModeRegistry();
      const mode = modeRegistry.getWorkflowForStrategy(strategy, 'comfyui');
      if (mode) {
        const frameInputs = mode.inputRequirements.filter(
          r => r.type === 'image' && r.source === 'shot_image' && r.id !== 'first_frame'
        ).filter(r => shouldGenerateExtraFrame(r.id));

        if (frameInputs.length > 0) {
          node.outputPaths = { first_frame: firstFramePath };

          for (const frameReq of frameInputs) {
            const frameDesc = this.getFrameDescription(node, frameReq.id);
            if (frameDesc) {
              this.log(`  Generating additional frame (legacy): ${frameReq.id}`);
              const modifiedJson = this.buildFramePromptJson(jsonContent, frameDesc, frameReq.id);
              const framePath = await this.executeShotImageGeneration(node, modifiedJson, toolCallId, frameReq.id);
              if (framePath) {
                node.outputPaths[frameReq.id] = framePath;
                this.log(`  ${frameReq.id} generated: ${framePath}`);
              }
            }
          }
          this.log(`  Multi-frame: ${Object.keys(node.outputPaths).length} frames generated`);
        }
      }
    } catch {
      // Mode registry not available or mode not found — single frame is fine
    }

    return firstFramePath;
  }

  /**
   * Get frame description (firstFrame/lastFrame/midFrame) from scene_video_prompt JSON.
   */
  private getFrameDescription(node: ExecutionNode, frameId: string): string | null {
    const sceneMatch = node.itemId?.match(/scene_(\d+)/);
    const shotMatch = node.itemId?.match(/shot_(\d+)/);
    if (!sceneMatch) return null;
    const sceneNum = parseInt(sceneMatch[1]!, 10);
    const shotNum = shotMatch?.[1] ? parseInt(shotMatch[1], 10) : 1;

    const svpNode = this.executor.getNode(`scene_video_prompt:scene_${sceneNum}`);
    if (!svpNode?.outputPath) return null;

    try {
      const svpPath = join(this.config.projectDir, svpNode.outputPath);
      let content = readFileSync(svpPath, 'utf-8').trim();
      if (content.startsWith('```')) content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      const parsed = JSON.parse(content);
      const shot = parsed.shots?.find((s: { shotNumber: number }) => s.shotNumber === shotNum);
      if (!shot) return null;

      // Map frameId to the SVP field
      const frameMap: Record<string, string> = {
        last_frame: 'lastFrame',
        mid_frame: 'midFrame',
        first_frame: 'firstFrame',
      };
      const fieldName = frameMap[frameId];
      if (!fieldName) return null;

      const frame = shot[fieldName];
      return frame?.description || null;
    } catch {
      return null;
    }
  }

  /**
   * Build a modified shot_image_prompt JSON for a specific frame,
   * replacing the image prompt with the frame's description.
   */
  private buildFramePromptJson(originalJson: string, frameDescription: string, frameId: string): string {
    try {
      let cleaned = originalJson.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsed = JSON.parse(cleaned);
      // Replace the image prompt with the frame description
      parsed.imagePrompt = `${frameDescription} — ${frameId.replace('_', ' ')} of the shot`;
      return JSON.stringify(parsed);
    } catch {
      return originalJson;
    }
  }

  /**
   * Generate a shot image from structured JSON prompt.
   * Reads the JSON, resolves refIds to actual image paths, calls ComfyUI with FLUX Klein.
   */
  private async executeShotImageGeneration(
    node: ExecutionNode,
    jsonContent: string,
    toolCallId: string,
    frameId?: string,
  ): Promise<string | null> {
    const agentName = this.config.name ?? 'dhee-executor';

    try {
      // Parse the structured JSON
      let cleaned = jsonContent.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const shotJson = JSON.parse(cleaned) as {
        imagePrompt: string;
        negativePrompt?: string;
        aspectRatio?: string;
        generationMode: string;
        references: Array<{ imageNumber: number; type: string; refId: string }>;
      };

      if (!shotJson.imagePrompt) {
        this.log(`  No imagePrompt in shot JSON`);
        return null;
      }

      // Resolve refIds to actual file paths from the executor graph
      const resolvedRefs = shotJson.references
        .map(ref => {
          const refNode = this.executor.getNode(ref.refId);
          if (!refNode?.outputPath?.endsWith('.png')) {
            this.log(`  Reference ${ref.refId} not resolved (node: ${refNode?.status}, path: ${refNode?.outputPath})`);
            return null;
          }
          return {
            image_id: join(this.config.projectDir, refNode.outputPath),
            type: ref.type as 'character' | 'setting',
            name: ref.refId.split(':')[1] ?? ref.refId,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      this.log(`  Shot image: ${resolvedRefs.length}/${shotJson.references.length} refs resolved`);

      // Auto-repair: scan prompt for "from image N" refs that weren't in the references array
      // and inject them from the scene's character/setting metadata
      const imageRefPattern = /from image (\d+)/gi;
      const promptImageNums = new Set<number>();
      let match: RegExpExecArray | null;
      while ((match = imageRefPattern.exec(shotJson.imagePrompt)) !== null) {
        promptImageNums.add(parseInt(match[1] ?? '0', 10));
      }

      if (promptImageNums.size > resolvedRefs.length) {
        this.log(`  Prompt references ${promptImageNums.size} images but only ${resolvedRefs.length} resolved — auto-injecting missing refs`);

        // Find all available character/setting/object image nodes
        const allRefNodes = this.executor.getAllNodes().filter(
          n => ['character_image', 'setting_image', 'object_image'].includes(n.typeId)
            && n.status === 'completed' && n.outputPath?.endsWith('.png'),
        );

        // Inject any that aren't already in resolvedRefs
        for (const refNode of allRefNodes) {
          const alreadyIncluded = resolvedRefs.some(r => r.name === (refNode.itemId ?? ''));
          if (!alreadyIncluded && resolvedRefs.length < promptImageNums.size) {
            resolvedRefs.push({
              image_id: join(this.config.projectDir, refNode.outputPath ?? ''),
              type: refNode.typeId.replace('_image', '') as 'character' | 'setting',
              name: refNode.itemId ?? refNode.id.split(':')[1] ?? refNode.id,
            });
            this.log(`  Auto-injected ref: ${refNode.id} (${refNode.outputPath})`);
          }
        }
      }

      // Determine generation mode based on resolved references
      const hasRefs = resolvedRefs.length > 0;
      const generationMode = hasRefs ? 'image_text_to_image' : 'text_to_image';

      // Resolve active workflow name for display
      let shotImgWorkflowName = hasRefs ? 'FLUX 2 Klein Edit (built-in)' : 'Z-Image (built-in)';
      try {
        const modeRegistry = getWorkflowModeRegistry();
        const pipeline = hasRefs ? 'image_editing' as const : 'image_generation' as const;
        const mode = modeRegistry.getActiveForPipeline(pipeline, 'comfyui');
        if (mode) shotImgWorkflowName = mode.displayName;
      } catch { /* ignore */ }

      // Emit tool_call for the image generation
      const genCallId = `shotimg_${node.id}_${Date.now()}`;
      const toolName = 'generate_shot_image';
      this.emit({
        type: 'tool_call',
        toolCallId: genCallId,
        toolName,
        arguments: {
          item: node.displayName,
          workflow: shotImgWorkflowName,
          mode: generationMode,
          prompt: shotJson.imagePrompt,
          ...Object.fromEntries(resolvedRefs.map((r, i) => [
            `ref_${i + 1}_${r.type}`,
            r.image_id.replace(this.config.projectDir + '/', ''),
          ])),
        },
        agentName,
      });

      // Subscribe to ComfyUI progress
      let progressHandler: ComfyProgressHandler | null = null;
      progressHandler = (event) => {
        this.emit({
          type: 'tool_streaming',
          toolCallId: genCallId,
          chunk: event.message,
          done: false,
          agentName,
          toolName,
          reset: true,
        });
      };
      comfyProgressBus.onProgress(progressHandler);

      this.emit({
        type: 'tool_streaming',
        toolCallId: genCallId,
        chunk: `Generating shot image (${generationMode})...`,
        done: false,
        agentName,
        toolName,
      });

      const sceneNumber = parseInt(node.itemId?.match(/scene_(\d+)/)?.[1] ?? '1', 10);
      const shotNumber = parseInt(node.itemId?.match(/shot_(\d+)/)?.[1] ?? '0', 10) || undefined;

      // Shot images match the project's video resolution
      const shotWidth = this.config.project.resolutionWidth;
      const shotHeight = this.config.project.resolutionHeight;

      const result = await submitImageGeneration({
        scene_number: sceneNumber,
        shot_number: shotNumber,
        frame_id: frameId,
        prompt: shotJson.imagePrompt,
        negative_prompt: shotJson.negativePrompt,
        aspect_ratio: shotJson.aspectRatio ?? '16:9',
        width: shotWidth,
        height: shotHeight,
        image_type: 'scene',
        generation_mode: generationMode,
        reference_images: hasRefs ? resolvedRefs : undefined,
      });

      if (progressHandler) comfyProgressBus.offProgress(progressHandler);

      const job = mediaJobs.get(result.jobId);
      let filePath = job?.result?.path;
      const artifactId = job?.result?.artifactId;

      if (result.status === 'completed' && filePath) {
        this.log(`  Shot image generated: ${filePath}`);

        // Image quality gate: validate the generated image
        try {
          const { validateGeneratedImage } = await import('./imageValidator.js');
          const absPath = filePath.startsWith('/') ? filePath : join(this.config.projectDir, filePath);
          const expectedDims = (shotWidth && shotHeight) ? { width: shotWidth, height: shotHeight } : undefined;
          const validation = await validateGeneratedImage(absPath, shotJson.imagePrompt, expectedDims);
          if (!validation.valid) {
            this.log(`  Image validation warning: ${validation.error}`);
            // Log but don't block — basic validation failures are warnings, not hard stops
          } else {
            this.log(`  Image validation passed`);
            // Semantic image-quality judgment is the supervisor's job:
            // ConversationManager subscribes to BackgroundTaskRunner
            // 'asset' events, calls `describeImageWithVLM` against the
            // dedicated VLM_* config, and re-engages pi-agent with a
            // `[SYSTEM EVENT]` turn. Pi-agent decides whether to call
            // `kshana_invalidate` on the shot's node — that's where
            // a regenerate gets driven from. The legacy in-executor
            // `reviewImageWithVLM` + inline retry that lived here was
            // removed: it used the WRONG llm config (utility tier, not
            // the VLM_* env block), couldn't reflect pi-agent judgment,
            // and duplicated the supervisor path.
          }
        } catch (valErr) {
          this.log(`  Image validation skipped: ${(valErr as Error).message}`);
        }

        this.emit({
          type: 'tool_streaming',
          toolCallId: genCallId,
          chunk: `Image saved to ${filePath}`,
          done: true,
          agentName,
          toolName,
        });
        this.emit({
          type: 'tool_result',
          toolCallId: genCallId,
          toolName,
          result: { status: 'completed', file_path: filePath, artifact_id: artifactId },
          agentName,
        });
        return filePath;
      } else {
        if (progressHandler) comfyProgressBus.offProgress(progressHandler);
        const errStr = String(result.error ?? job?.error ?? 'unknown ComfyUI error');
        this.log(`  Shot image failed: ${errStr}`);
        this.lastNodeError = `Shot image: ${errStr}`;
        this.emit({
          type: 'tool_result',
          toolCallId: genCallId,
          toolName,
          result: { status: 'error', error: errStr },
          agentName,
          isError: true,
        });
        return null;
      }
    } catch (error) {
      const errStr = String(error);
      this.log(`  Shot image error: ${errStr}`);
      this.lastNodeError = `Shot image: ${errStr}`;
      return null;
    }
  }

  /**
   * Generate an actual image from a prompt file via the provider.
   */
  private async executeImageGeneration(
    node: ExecutionNode,
    promptFilePath: string,
    toolCallId: string,
    agentName: string,
  ): Promise<string | null> {
    this.log(`  Generating image from prompt: ${promptFilePath}`);

    // Resolve active workflow name for display
    let imgWorkflowName = 'Z-Image (built-in)';
    try {
      const modeRegistry = getWorkflowModeRegistry();
      const mode = modeRegistry.getActiveForPipeline('image_generation', 'comfyui');
      if (mode) imgWorkflowName = mode.displayName;
    } catch { /* ignore */ }

    // Emit a tool_call for the actual image generation
    const genCallId = `img_${node.id}_${Date.now()}`;
    const toolName = `generate_image`;
    this.emit({
      type: 'tool_call',
      toolCallId: genCallId,
      toolName,
      arguments: { item: node.displayName, workflow: imgWorkflowName },
      agentName,
    });

    // Subscribe to ComfyUI progress and forward to tool_streaming
    let progressHandler: ComfyProgressHandler | null = null;

    try {
      // Read and parse the JSON prompt file
      const rawContent = readFileSync(promptFilePath, 'utf-8');
      let cleaned = rawContent.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      let parsed: { imagePrompt?: string; prompt?: string; negativePrompt?: string; aspectRatio?: string; generationMode?: string; references?: Array<{ refId?: string; path?: string; name: string; type: string }> };
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // Fallback: try legacy markdown parsing
        parsed = parsePromptFile(rawContent);
        if (parsed.prompt) {
          parsed.imagePrompt = parsed.prompt;
        }
      }

      const prompt = parsed.imagePrompt ?? parsed.prompt;
      if (!prompt) {
        this.log(`  No prompt found in file`);
        return null;
      }

      // Determine image type from node type
      let imageType: 'character_ref' | 'setting_ref' | 'object_ref' | 'scene' = 'scene';
      let characterName: string | undefined;
      let settingName: string | undefined;
      let objectName: string | undefined;
      const sceneNumber = parseInt(node.itemId?.match(/(\d+)/)?.[1] ?? '1', 10);

      if (node.typeId === 'character_image') {
        imageType = 'character_ref';
        characterName = node.itemId;
      } else if (node.typeId === 'setting_image') {
        imageType = 'setting_ref';
        settingName = node.itemId;
      } else if (node.typeId === 'object_image') {
        // Without this branch, object_images fell into the 'scene'
        // fallback and got saved as `scene_1_0002.png` etc, indistinguishable
        // from shot images on the ComfyUI server.
        imageType = 'object_ref';
        objectName = node.itemId;
      }

      // Phase D — chained-edit (derivedFrom). If this ref node was
      // spawned by the shot_image_prompt turn-2 LLM as a reframe /
      // variant of an existing ref, render it as a Klein image-edit
      // using the parent's outputPath as the base canvas instead of
      // a plain text-to-image call.
      const derivedFromRefId = node.metadata?.derivedFrom;
      let chainedEditRef: { artifactId: string; type: 'character' | 'setting'; name: string } | null = null;
      if (derivedFromRefId) {
        const parentNode = this.executor.getNode(derivedFromRefId);
        if (parentNode?.outputPath && parentNode.artifactId) {
          const parentType: 'character' | 'setting' =
            parentNode.typeId === 'setting_image' ? 'setting' : 'character';
          chainedEditRef = {
            artifactId: parentNode.artifactId,
            type: parentType,
            name: parentNode.itemId ?? parentNode.id,
          };
          this.log(
            `  [${node.id}] derivedFrom=${derivedFromRefId} → chained edit using parent canvas ${parentNode.outputPath}`,
          );
        } else {
          this.log(
            `  [${node.id}] derivedFrom=${derivedFromRefId} but parent has no outputPath/artifactId yet — falling back to text-to-image`,
          );
        }
      }
      progressHandler = (event) => {
        // Use reset: true so each progress update REPLACES the previous one
        // Format matches webui.ts progress bar detector: "Step N/M (X%)"
        this.emit({
          type: 'tool_streaming',
          toolCallId: genCallId,
          chunk: event.message,
          done: false,
          agentName,
          toolName,
          reset: true,  // Replace previous content instead of appending
        });
      };
      comfyProgressBus.onProgress(progressHandler);

      // Emit progress start
      this.emit({
        type: 'tool_streaming',
        toolCallId: genCallId,
        chunk: `Generating ${node.displayName}...`,
        done: false,
        agentName,
        toolName,
      });

      // Call the actual image generation (blocks until done).
      // Default: character/setting images are text_to_image with no refs.
      // Phase D: when this node was spawned with `derivedFrom`, switch
      // to image_text_to_image and pass the parent's artifact as the
      // single reference — Klein renders the new ref as a reframe of
      // the parent canvas.
      const result = await submitImageGeneration({
        scene_number: sceneNumber,
        prompt,
        negative_prompt: parsed.negativePrompt,
        aspect_ratio: parsed.aspectRatio ?? '1:1',
        image_type: imageType,
        character_name: characterName,
        setting_name: settingName,
        object_name: objectName,
        generation_mode: chainedEditRef ? 'image_text_to_image' : 'text_to_image',
        ...(chainedEditRef
          ? {
              reference_images: [
                {
                  image_id: chainedEditRef.artifactId,
                  type: chainedEditRef.type,
                  name: chainedEditRef.name,
                },
              ],
            }
          : {}),
      });

      // Unsubscribe from progress
      if (progressHandler) comfyProgressBus.offProgress(progressHandler);

      // Get the result from the job store
      const job = mediaJobs.get(result.jobId);
      const artifactId = job?.result?.artifactId;
      const filePath = job?.result?.path;

      if (result.status === 'completed' && filePath) {
        this.log(`  Image generated: ${filePath} (artifact: ${artifactId})`);
        this.emit({
          type: 'tool_streaming',
          toolCallId: genCallId,
          chunk: `Image saved to ${filePath}`,
          done: true,
          agentName,
          toolName,
        });
        this.emit({
          type: 'tool_result',
          toolCallId: genCallId,
          toolName,
          result: { status: 'completed', file_path: filePath, artifact_id: artifactId },
          agentName,
        });
        return filePath;
      } else {
        const error = String(result.error ?? job?.error ?? 'Unknown error');
        this.log(`  Image generation failed: ${error}`);
        this.lastNodeError = `Image generation: ${error}`;
        this.emit({
          type: 'tool_result',
          toolCallId: genCallId,
          toolName,
          result: { status: 'error', error },
          agentName,
          isError: true,
        });
        return null;
      }
    } catch (error) {
      if (progressHandler) comfyProgressBus.offProgress(progressHandler);
      const errStr = String(error);
      this.log(`  Image generation error: ${errStr}`);
      this.lastNodeError = `Image generation: ${errStr}`;
      this.emit({
        type: 'tool_result',
        toolCallId: genCallId,
        toolName,
        result: { status: 'error', error: errStr },
        agentName,
        isError: true,
      });
      return null;
    }
  }

  /**
   * Generate a shot video — purely deterministic, no LLM.
   * Takes: shot image (from shot_image_prompt dep) + motion description (from scene_video_prompt JSON)
   * Calls video provider to generate the clip.
   */
  private async executeShotVideo(
    node: ExecutionNode,
    toolCallId: string,
  ): Promise<string | null> {
    const agentName = this.config.name ?? 'dhee-executor';

    // ── prompt_relay mode: render the whole scene as one bundle mp4
    // and return that path for every shot in the scene. The render
    // fires once; concurrent shot_video nodes for the same scene
    // share the in-flight promise via sceneBundleLocks. The
    // assembler-side dedupe (collapseBundleSegments) collapses the N
    // identical timeline segments back to one concat input.
    if (isPromptRelayMode()) {
      const bundlePath = await this.renderOrAwaitSceneBundle(node, toolCallId, agentName);
      if (bundlePath) return bundlePath;
      // Fallthrough to per-shot if bundle render failed — better to
      // limp than to drop the scene.
      this.log(`  prompt_relay bundle render failed; falling back to per-shot for ${node.id}`);
    }

    // 1. Find the MATCHING shot image (same itemId)
    let shotImagePath: string | undefined;
    const matchingImageId = `shot_image:${node.itemId}`;
    const matchingImageNode = this.executor.getNode(matchingImageId);
    if (matchingImageNode?.status === 'completed' && matchingImageNode.outputPath) {
      shotImagePath = matchingImageNode.outputPath;
    }
    if (!shotImagePath) {
      // Fallback: find matching by itemId in dependencies
      for (const depId of node.dependencies) {
        const dep = this.executor.getNode(depId);
        if (dep && dep.itemId === node.itemId && dep.outputPath &&
            (dep.outputPath.endsWith('.png') || dep.outputPath.endsWith('.jpg'))) {
          shotImagePath = dep.outputPath;
          break;
        }
      }
    }

    if (!shotImagePath) {
      this.log(`  No shot image found for ${node.id}`);
      return null;
    }

    // 2. Get motion description from scene_video_prompt JSON
    // Extract scene and shot number from itemId: "scene_1_shot_2"
    const sceneMatch = node.itemId?.match(/scene_(\d+)/);
    const shotMatch = node.itemId?.match(/shot_(\d+)/);
    const sceneNum = sceneMatch?.[1] ? parseInt(sceneMatch[1], 10) : 1;
    const shotNum = shotMatch?.[1] ? parseInt(shotMatch[1], 10) : 1;

    const svpNode = this.executor.getNode(`scene_video_prompt:scene_${sceneNum}`);
    let motionPrompt = '';
    let shotDuration = 5;
    let generationStrategy = 'i2v';

    // 1. Try to use shot_motion_directive (preferred — LTX-optimized)
    const motionDirectiveNode = this.executor.getNode(`shot_motion_directive:${node.itemId}`);
    if (motionDirectiveNode?.status === 'completed' && motionDirectiveNode.outputPath) {
      const mdPath = join(this.config.projectDir, motionDirectiveNode.outputPath);
      if (existsSync(mdPath)) {
        let rawContent = readFileSync(mdPath, 'utf-8').trim();
        // Strip markdown code fences if present
        if (rawContent.startsWith('```')) {
          rawContent = rawContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        }
        // Parse JSON format ({"motionDirective": "..."}) or fall back to raw text
        try {
          const parsed = JSON.parse(rawContent);
          motionPrompt = parsed.motionDirective || rawContent;
        } catch {
          // Legacy plain-text format — use as-is
          motionPrompt = rawContent;
        }
        this.log(`  Using motion directive: ${motionPrompt.substring(0, 80)}...`);
      }
    }

    // 2. Read shot metadata from scene_video_prompt JSON
    if (svpNode?.outputPath) {
      const svpPath = join(this.config.projectDir, svpNode.outputPath);
      if (existsSync(svpPath)) {
        try {
          let content = readFileSync(svpPath, 'utf-8').trim();
          if (content.startsWith('```')) {
            content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          }
          const parsed = JSON.parse(content);
          const shot = parsed.shots?.find((s: { shotNumber: number }) => s.shotNumber === shotNum);
          if (shot) {
            shotDuration = shot.duration || 5;
            // Legacy: read strategy from scene_video_prompt if present
            if (shot.videoGenerationMode || shot.generationStrategy) {
              generationStrategy = shot.videoGenerationMode || shot.generationStrategy || 'i2v';
            }

            // Fallback: if no motion directive, use description + cameraWork + audio
            if (!motionPrompt) {
              const { buildFallbackMotionPrompt } = await import('./shotReferenceMapping.js');
              motionPrompt = buildFallbackMotionPrompt(shot);
            }
          }
        } catch {
          this.log(`  Failed to parse scene_video_prompt JSON for motion`);
        }
      }
    }

    // 3. Check shot_image_prompt for generationStrategy (preferred in slim scene breakdown)
    const sipNode = this.executor.getNode(`shot_image_prompt:${node.itemId}`);
    if (sipNode?.outputPath) {
      const sipPath = join(this.config.projectDir, sipNode.outputPath);
      if (existsSync(sipPath)) {
        try {
          let sipContent = readFileSync(sipPath, 'utf-8').trim();
          if (sipContent.startsWith('```')) {
            sipContent = sipContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          }
          const sipParsed = JSON.parse(sipContent);
          if (sipParsed.generationStrategy) {
            generationStrategy = sipParsed.generationStrategy;
          }
        } catch { /* ignore */ }
      }
    }

    if (!motionPrompt) {
      motionPrompt = `Cinematic shot with subtle camera movement, scene ${sceneNum} shot ${shotNum}`;
    }

    // Determine video strategy: v2v_extend for continuation shots, flfv for fresh
    const { getVideoStrategy, getPreviousVideoPath } = await import('./crossShotChaining.js');
    const shotPurpose = (() => {
      try {
        if (!svpNode?.outputPath) return '';
        const svpPath = join(this.config.projectDir, svpNode.outputPath);
        let c = readFileSync(svpPath, 'utf-8').trim();
        if (c.startsWith('```')) c = c.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        const p = JSON.parse(c);
        const s = (p.shots ?? p)?.find?.((s: any) => s.shotNumber === shotNum);
        return s?.purpose || '';
      } catch { return ''; }
    })();

    // Default OFF so each shot's generated first/last frames actually appear
    // in the final video. Opt-in via `useV2V: true` in project.json. See
    // ProjectManager.ts:382 — that comment captures the original intent;
    // the runtime previously defaulted ON, so projects without the flag
    // (legacy or hand-edited) were silently running v2v_extend.
    const v2vEnabled = this.config.project.useV2V === true;
    const videoStrategy = v2vEnabled
      ? getVideoStrategy(node.itemId ?? '', shotPurpose)
      : 'flfv';
    let previousVideoPath: string | null = null;
    if (videoStrategy === 'v2v_extend') {
      previousVideoPath = getPreviousVideoPath(node.itemId ?? '', this.executor);
      if (previousVideoPath) {
        generationStrategy = 'v2v_extend';
        this.log(`  V2V Extend: will extend ${previousVideoPath}`);
      } else {
        this.log(`  V2V Extend: no previous video found — falling back to flfv`);
        generationStrategy = generationStrategy || 'flfv';
      }
    }
    if (!v2vEnabled) {
      this.log(`  V2V disabled (useV2V=false) — using flfv for all shots`);
    }

    // t2v is no longer a valid strategy — every shot uses a first frame image
    const isT2V = false;
    if (!shotImagePath) {
      this.log(`  No shot image found for ${node.id}`);
      return null;
    }

    // 3. Resolve active workflow name for display — use strategy-aware routing
    let activeWorkflowName = 'LTX-2.3 (built-in)';
    try {
      const modeRegistry = getWorkflowModeRegistry();
      const resolved = modeRegistry.getWorkflowForStrategy(generationStrategy, 'comfyui');
      if (resolved) {
        activeWorkflowName = resolved.displayName;
      }
    } catch { /* ignore */ }

    // 4. Emit tool_call
    const genCallId = `shotvid_${node.id}_${Date.now()}`;
    const toolName = 'generate_shot_video';
    this.emit({
      type: 'tool_call',
      toolCallId: genCallId,
      toolName,
      arguments: { item: node.displayName, workflow: activeWorkflowName, source_image: isT2V ? '(text-to-video)' : shotImagePath, duration: shotDuration, prompt: motionPrompt },
      agentName,
    });

    // 5. Subscribe to progress
    let progressHandler: ComfyProgressHandler | null = null;
    progressHandler = (event) => {
      this.emit({
        type: 'tool_streaming',
        toolCallId: genCallId,
        chunk: event.message,
        done: false,
        agentName,
        toolName,
        reset: true,
      });
    };
    comfyProgressBus.onProgress(progressHandler);

    this.emit({
      type: 'tool_streaming',
      toolCallId: genCallId,
      chunk: `Generating shot video (${shotDuration}s)...`,
      done: false,
      agentName,
      toolName,
    });

    try {
      // 5. Call video provider
      const provider = getProviderRegistry().getVideoGenerator();
      if (!provider?.generateVideo) {
        this.log(`  No video generation provider available`);
        if (progressHandler) comfyProgressBus.offProgress(progressHandler);
        return null;
      }

      const assetsDir = join(this.config.projectDir, 'assets', 'videos', 'shots');
      if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });

      // Video resolution from project settings (defaults to 480p)
      const videoWidth = this.config.project.resolutionWidth ?? 848;
      const videoHeight = this.config.project.resolutionHeight ?? 480;

      // Collect additional frame images.
      // Pattern B Phase 2: last_frame lives on shot_image_last_frame:X
      // (the bridge node owns it). mid_frame still on shot_image:X
      // since Phase 2 only moved last_frame. Legacy projects may have
      // last_frame on shot_image:X.outputPaths.last_frame — that path
      // is the fallback below.
      const frameImages: Record<string, string> = {};
      const lastFrameBridge = node.itemId
        ? this.executor.getNode(`shot_image_last_frame:${node.itemId}`)
        : null;
      const lastFrameRel =
        (lastFrameBridge?.status === 'completed' && lastFrameBridge.outputPath
          ? lastFrameBridge.outputPath
          : null)
        ?? matchingImageNode?.outputPaths?.['last_frame'];
      if (lastFrameRel) {
        frameImages['last_frame'] = join(this.config.projectDir, lastFrameRel);
      }
      if (matchingImageNode?.outputPaths) {
        for (const [frameId, framePath] of Object.entries(matchingImageNode.outputPaths)) {
          if (frameId === 'first_frame' || frameId === 'last_frame') continue;
          frameImages[frameId] = join(this.config.projectDir, framePath);
        }
      }

      const result = await provider.generateVideo(
        {
          sourceImagePath: isT2V ? '' : join(this.config.projectDir, shotImagePath),
          sourceVideoPath: previousVideoPath ? join(this.config.projectDir, previousVideoPath) : undefined,
          prompt: motionPrompt,
          durationSeconds: shotDuration,
          width: videoWidth,
          height: videoHeight,
          outputDir: assetsDir,
          filenamePrefix: `scene_${sceneNum}_shot_${shotNum}`,
          modeId: generationStrategy,
          frameImages: Object.keys(frameImages).length > 0 ? frameImages : undefined,
        },
        (info) => {
          this.emit({
            type: 'tool_streaming',
            toolCallId: genCallId,
            chunk: info.message,
            done: false,
            agentName,
            toolName,
            reset: true,
          });
        },
      );

      if (progressHandler) comfyProgressBus.offProgress(progressHandler);

      const relPath = relative(this.config.projectDir, result.filePath);
      const workflowUsed = (result.metadata as Record<string, unknown>)?.['workflowName'] as string | undefined;

      // Validate the returned asset is actually a video file. LTX
      // cloud has been observed (bdry3 run 2026-05-23) returning a
      // `.png` for an FL2V call — an unrelated asset from another
      // project ended up in the response. Accepting that as a "shot
      // video" then polluted the final cut. Fail loudly here so the
      // executor retries instead of silently shipping a still image.
      const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
      const ext = (result.filePath.match(/\.([a-z0-9]+)$/i)?.[0] ?? '').toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) {
        throw new Error(
          `Shot video provider returned non-video asset (extension=${ext || 'none'}, path=${relPath}). ` +
          `LTX cloud occasionally returns image fallbacks on certain failures; refusing to accept.`,
        );
      }

      this.log(`  Shot video generated: ${relPath} (${shotDuration}s) [workflow: ${workflowUsed ?? 'unknown'}]`);

      try {
        addAsset({
          id: `shotvid_${Date.now()}`,
          type: 'scene_video',
          path: relPath,
          createdAt: Date.now(),
          metadata: { sceneNumber: sceneNum, shotNumber: shotNum, duration: shotDuration, generationStrategy },
          nodeId: node.id,
        });
      } catch { /* non-fatal */ }

      this.emit({
        type: 'tool_streaming',
        toolCallId: genCallId,
        chunk: `Video saved to ${relPath}`,
        done: true,
        agentName,
        toolName,
      });
      this.emit({
        type: 'tool_result',
        toolCallId: genCallId,
        toolName,
        result: { status: 'completed', file_path: relPath },
        agentName,
      });
      return relPath;
    } catch (error) {
      if (progressHandler) comfyProgressBus.offProgress(progressHandler);
      const errStr = String(error);
      this.log(`  Shot video error: ${errStr}`);
      this.lastNodeError = `Shot video: ${errStr}`;
      this.emit({
        type: 'tool_result',
        toolCallId: genCallId,
        toolName,
        result: { status: 'error', error: errStr },
        agentName,
        isError: true,
      });
      return null;
    }
  }

  /**
   * prompt_relay mode: render the scene as one or more bundle mp4s.
   * The first shot_video for a scene to arrive fires the render(s);
   * concurrent shot_videos for the same scene await the same
   * in-flight promise (sceneBundleLocks). Long scenes that exceed
   * the LTX caps (>20 shots or >1000 frames) are split into multiple
   * chunks via chunkSceneIntoBundles; each chunk is rendered as its
   * own scene_video asset with metadata.coversShots listing which
   * shots it covers. The FFmpegAssembler's tier-3.5 fallback uses
   * coversShots to pick the right chunk per shot.
   */
  private async renderOrAwaitSceneBundle(
    node: ExecutionNode,
    _toolCallId: string,
    agentName: string,
  ): Promise<string | null> {
    const sceneMatch = node.itemId?.match(/scene_(\d+)/);
    const shotMatch = node.itemId?.match(/shot_(\d+)$/);
    if (!sceneMatch || !shotMatch) {
      this.log(`  prompt_relay: cannot parse scene/shot from ${node.itemId}`);
      return null;
    }
    const sceneNum = parseInt(sceneMatch[1]!, 10);
    const shotNum = parseInt(shotMatch[1]!, 10);
    if (this.unbundleableScenes.has(sceneNum)) {
      return null;
    }
    const chunkMap = await this.sceneBundleLocks.acquire(sceneNum, () => this.executeSceneBundle(sceneNum, agentName));
    if (!chunkMap) return null;
    return chunkMap.get(shotNum) ?? null;
  }

  /** Gather all shots, split into chunks, render each. Returns a map
   *  shotNumber → bundle relative path (the chunk covering that shot). */
  private async executeSceneBundle(sceneNum: number, agentName: string): Promise<Map<number, string> | null> {
    const { renderSceneBundle } = await import('./sceneBundleRenderer.js');
    const { chunkSceneIntoBundles } = await import('./sceneBundleChunker.js');
    void agentName;

    // 1. Find all shot_video nodes for this scene, ordered by shot number
    const allNodes = this.executor.getAllNodes();
    const sceneShotNodes = allNodes
      .filter(n => n.typeId === 'shot_video' && n.itemId?.startsWith(`scene_${sceneNum}_shot_`))
      .map(n => {
        const m = n.itemId?.match(/shot_(\d+)$/);
        const shotNumber = m?.[1] ? parseInt(m[1], 10) : 0;
        return { node: n, shotNumber };
      })
      .filter(x => x.shotNumber > 0)
      .sort((a, b) => a.shotNumber - b.shotNumber);

    if (sceneShotNodes.length === 0) {
      this.log(`  prompt_relay: scene ${sceneNum} has no shot_video nodes`);
      return null;
    }

    // 2. For each shot: first_frame path, motion prompt, duration
    const shots: SceneBundleShot[] = [];
    let svpJson: { shots?: Array<{ shotNumber?: number; duration?: number; description?: string }> } | null = null;
    const svpNode = this.executor.getNode(`scene_video_prompt:scene_${sceneNum}`);
    if (svpNode?.outputPath) {
      try {
        let c = readFileSync(join(this.config.projectDir, svpNode.outputPath), 'utf-8').trim();
        if (c.startsWith('```')) c = c.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        svpJson = JSON.parse(c);
      } catch { /* ignore */ }
    }

    for (const { node, shotNumber } of sceneShotNodes) {
      // first_frame from shot_image node
      const imgNode = this.executor.getNode(`shot_image:${node.itemId}`);
      const firstFrameRel = imgNode?.outputPaths?.['first_frame'] ?? imgNode?.outputPath;
      if (!firstFrameRel) {
        this.log(`  prompt_relay: scene ${sceneNum} shot ${shotNumber} has no first_frame yet — bundle waits`);
        return null;
      }
      const firstFrameAbs = join(this.config.projectDir, firstFrameRel);
      if (!existsSync(firstFrameAbs)) {
        this.log(`  prompt_relay: first_frame missing on disk for scene ${sceneNum} shot ${shotNumber}: ${firstFrameAbs}`);
        return null;
      }

      // motion prompt
      let motionPrompt = '';
      const mdNode = this.executor.getNode(`shot_motion_directive:${node.itemId}`);
      if (mdNode?.outputPath) {
        try {
          let raw = readFileSync(join(this.config.projectDir, mdNode.outputPath), 'utf-8').trim();
          if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          try {
            const parsed = JSON.parse(raw);
            motionPrompt = (typeof parsed?.motionDirective === 'string' ? parsed.motionDirective : raw).trim();
          } catch {
            motionPrompt = raw;
          }
        } catch { /* ignore */ }
      }
      if (!motionPrompt) motionPrompt = `Cinematic shot, scene ${sceneNum} shot ${shotNumber}.`;

      // duration from scene_video_prompt
      const shotMeta = svpJson?.shots?.find(s => s.shotNumber === shotNumber);
      const duration = typeof shotMeta?.duration === 'number' && shotMeta.duration > 0 ? shotMeta.duration : 5;

      shots.push({ shotNumber, firstFramePath: firstFrameAbs, motionPrompt, duration });
    }

    // 3. Split into chunks that fit LTX caps. The chunker honors both
    // 20-shot and 1000-frame caps, re-aligning frame counts per chunk
    // (each chunk's first segment gets +1 to keep the chunk's total
    // ≡ 1 mod 8). Single-bundle scenes return one chunk; long scenes
    // return multiple chunks rendered one after another.
    const chunks = chunkSceneIntoBundles(
      shots.map(s => ({ shotNumber: s.shotNumber, durationSec: s.duration })),
      24,
    );
    if (chunks.length === 0) return null;

    // Defensive: confirm every chunk passed eligibility. The chunker
    // is supposed to guarantee this, but if a single shot is so long
    // that even alone it exceeds 1000 frames, we land here. Mark the
    // scene unbundleable rather than submit a doomed render.
    for (const chunk of chunks) {
      const elig = checkSceneBundleEligibility({ shotCount: chunk.shots.length, totalFrames: chunk.totalFrames });
      if (!elig.eligible) {
        this.log(`  prompt_relay: scene ${sceneNum} chunk ${chunk.chunkIndex} ineligible — ${elig.reason}`);
        if (elig.permanent) {
          this.log(`  prompt_relay: marking scene ${sceneNum} unbundleable; falling back to per-shot`);
          this.unbundleableScenes.add(sceneNum);
        }
        return null;
      }
    }

    // 4. Render each chunk serially. Per-chunk output filename
    // includes _chunk${index} so chunks for the same scene don't
    // collide on disk.
    const characters = this.collectCharacterIdentities();
    const sceneDescription = this.collectSceneDescription(sceneNum, svpJson);
    const width = this.config.project.resolutionWidth ?? 848;
    const height = this.config.project.resolutionHeight ?? 480;
    const style = (this.config.project as { style?: string }).style || 'cinematic';

    this.log(`  prompt_relay: scene ${sceneNum} rendering ${shots.length} shots in ${chunks.length} chunk(s)`);

    const chunkPathByShot = new Map<number, string>();

    for (const chunk of chunks) {
      // Map the chunker's shot list back to SceneBundleShot (carries
      // the first_frame/motion data we already gathered).
      const chunkShots: SceneBundleShot[] = chunk.shots
        .map(c => shots.find(s => s.shotNumber === c.shotNumber))
        .filter((s): s is SceneBundleShot => !!s);
      if (chunkShots.length !== chunk.shots.length) {
        this.log(`  prompt_relay: scene ${sceneNum} chunk ${chunk.chunkIndex} missing shot data — abort`);
        return null;
      }

      this.log(`  prompt_relay: scene ${sceneNum} chunk ${chunk.chunkIndex + 1}/${chunks.length} (${chunkShots.length} shots, ${chunk.totalFrames} frames, ~${Math.round(chunk.totalFrames * 1.4 / 60)}min expected)`);
      // Throttled progress logging so the user can see the chunk
      // render is alive during its 10-25 minute window. Without this,
      // executor.log goes silent between "uploaded N first frames"
      // and the eventual completion — easy to mistake for a hang.
      let lastProgressLog = 0;
      const renderStart = Date.now();
      const onProgress = (pct: number, msg: string) => {
        const now = Date.now();
        if (now - lastProgressLog < 15000) return;  // throttle to every 15s
        lastProgressLog = now;
        const elapsedSec = Math.round((now - renderStart) / 1000);
        this.log(`  prompt_relay: scene ${sceneNum} chunk ${chunk.chunkIndex} [${pct.toFixed(0)}% / ${elapsedSec}s elapsed] ${msg}`);
      };
      let result: SceneBundleResult;
      try {
        result = await renderSceneBundle({
          sceneNumber: sceneNum,
          shots: chunkShots,
          characters,
          sceneDescription,
          style,
          projectDir: this.config.projectDir,
          width,
          height,
          log: (m) => this.log(`  prompt_relay: ${m}`),
          onProgress,
          chunkIndex: chunks.length > 1 ? chunk.chunkIndex : undefined,
        });
      } catch (err) {
        this.log(`  prompt_relay: scene ${sceneNum} chunk ${chunk.chunkIndex} render threw: ${String(err)}`);
        return null;
      }

      try {
        addAsset({
          id: `scenebundle_${sceneNum}_chunk${chunk.chunkIndex}_${Date.now()}`,
          type: 'scene_video',
          path: result.bundleRelativePath,
          createdAt: Date.now(),
          metadata: {
            sceneNumber: sceneNum,
            isBundle: true,
            coversShots: chunkShots.map(s => s.shotNumber),
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunks.length,
            generationStrategy: 'prompt_relay',
            totalFrames: result.totalFrames,
            segmentFrames: result.segmentFrames,
            promptId: result.promptId,
          },
        });
      } catch { /* non-fatal */ }

      for (const s of chunkShots) {
        chunkPathByShot.set(s.shotNumber, result.bundleRelativePath);
      }
      this.log(`  prompt_relay: scene ${sceneNum} chunk ${chunk.chunkIndex} saved → ${result.bundleRelativePath}`);
    }

    return chunkPathByShot;
  }

  /** Read each character's "Physical Description" from characters/*.md
   *  for the global-prompt builder. Conservative — only files listed
   *  on the project's content registry, deduped by name. */
  private collectCharacterIdentities(): CharacterId[] {
    const out: CharacterId[] = [];
    const items = (this.config.project as unknown as { content?: { characters?: { items?: string[]; itemFiles?: Record<string, string> } } }).content?.characters;
    const itemFiles = items?.itemFiles ?? {};
    const seen = new Set<string>();
    for (const name of items?.items ?? []) {
      const key = name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const rel = itemFiles[name];
      if (!rel) continue;
      const abs = join(this.config.projectDir, rel);
      if (!existsSync(abs)) continue;
      try {
        const md = readFileSync(abs, 'utf-8');
        const m = md.match(/###\s*Physical Description\s*\n([\s\S]+?)(?:\n###|\n---|$)/i);
        if (m) {
          out.push({ name, description: m[1]!.replace(/\s+/g, ' ').trim() });
        }
      } catch { /* ignore */ }
    }
    return out;
  }

  /** Pull a brief, visual description for a scene from
   *  prompts/scene_summaries.json or the SVP JSON, kept short to avoid
   *  drowning the per-segment local prompts. */
  private collectSceneDescription(
    sceneNum: number,
    svpJson: { shots?: Array<{ description?: string }> } | null,
  ): string {
    const summariesPath = join(this.config.projectDir, 'prompts/scene_summaries.json');
    if (existsSync(summariesPath)) {
      try {
        const all = JSON.parse(readFileSync(summariesPath, 'utf-8')) as Record<string, string>;
        const s = all[`scene_${sceneNum}`];
        if (typeof s === 'string' && s.trim().length > 0) return s.trim();
      } catch { /* ignore */ }
    }
    // Fall back to first shot's description
    return svpJson?.shots?.[0]?.description?.trim() ?? '';
  }

  /**
   * Run the focused story-essence LLM call and persist the result.
   *
   * Reads the story node's outputPath, calls `extractStoryEssence`, writes
   * `prompts/story_essence.json` (the artifact's filePattern), caches the
   * result on `this.storyEssence` so downstream consumers (hierarchical
   * scene extraction, scene-prose context builder) can use it without
   * re-reading the file.
   *
   * Returns the relative output path on success, or null on failure
   * (so the dispatch in the run loop can mark the node failed).
   */
  private async executeStoryEssenceNode(
    node: ExecutionNode,
    toolCallId: string,
    agentName: string,
  ): Promise<string | null> {
    const storyNode = this.executor.getAllNodes().find(n => n.typeId === 'story' && n.status === 'completed');
    if (!storyNode?.outputPath) {
      const msg = 'cannot find completed story node with outputPath';
      this.log(`  story_essence: ${msg}`);
      this.lastNodeError = `Story essence: ${msg}`;
      return null;
    }
    const storyAbs = join(this.config.projectDir, storyNode.outputPath);
    if (!existsSync(storyAbs)) {
      const msg = `story file missing on disk: ${storyAbs}`;
      this.log(`  story_essence: ${msg}`);
      this.lastNodeError = `Story essence: ${msg}`;
      return null;
    }

    let storyContent: string;
    try {
      storyContent = readFileSync(storyAbs, 'utf-8');
    } catch (err) {
      const msg = (err as Error).message;
      this.log(`  story_essence: failed to read story: ${msg}`);
      this.lastNodeError = `Story essence: failed to read story (${msg})`;
      return null;
    }

    const toolName = 'extract_story_essence';
    this.emit({
      type: 'tool_call',
      toolCallId,
      toolName,
      arguments: { source: storyNode.outputPath, model: this.modelFor('structured.story_essence') },
      agentName,
    });

    let essence: StoryEssence;
    try {
      const targetDurationSec = this.config.goal.preferences.duration;
      essence = await extractStoryEssence(storyContent, this.llmFor('structured.story_essence'), {
        ...(typeof targetDurationSec === 'number' ? { targetDurationSec } : {}),
      });
    } catch (err) {
      const msg = (err as Error).message;
      this.log(`  story_essence: extraction failed: ${msg}`);
      // When the failure is a parse / validation error from the LLM
      // response, the StoryEssenceParseError carries the raw content
      // that failed — persist it so the user can inspect / hand-fix
      // the JSON. Other failures (LLM transport errors, timeouts) have
      // no content to save.
      let recoveryHint = '';
      if (err instanceof StoryEssenceParseError) {
        const sidecar = writeFailedAttempt(
          node,
          err.rawContent,
          msg,
          this.config.projectDir,
          this.config.template,
        );
        if (sidecar.contentPath) {
          recoveryHint = `\nBroken content saved to: ${sidecar.contentPath} — edit and rename to remove the .failed suffix to recover, or send any message to retry.`;
        }
      }
      this.lastNodeError = `${msg}${recoveryHint}`;
      this.emit({
        type: 'tool_result',
        toolCallId,
        toolName,
        result: { status: 'failed', error: msg },
        agentName,
      });
      return null;
    }

    // Successful parse — drop any stale .failed sidecar from a prior run.
    clearFailedAttempt(node, this.config.projectDir, this.config.template);

    const outputRel = node.outputPath ?? 'prompts/story_essence.json';
    const outputAbs = join(this.config.projectDir, outputRel);
    const outputDir = join(this.config.projectDir, 'prompts');
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    atomicWriteFileSync(outputAbs, JSON.stringify(essence, null, 2));

    this.storyEssence = essence;
    this.log(`  story_essence: wrote ${outputRel} (genre=${essence.genre})`);

    this.emit({
      type: 'tool_result',
      toolCallId,
      toolName,
      result: { status: 'completed', file: outputRel, genre: essence.genre },
      agentName,
    });
    this.emit({
      type: 'agent_text',
      text: `**Story Essence** → \`${outputRel}\` — genre: ${essence.genre}; throughline: ${essence.throughline}`,
      isFinal: false,
    });

    return outputRel;
  }

  /**
   * Stage C of the hierarchical scene-breakdown flow — deterministic
   * assembly of scene_shot_plan + N shot_breakdown outputs into the
   * existing sceneVideoPromptSchema shape, with all the post-validators
   * the legacy single-call path ran (continuity, one-setting, dialogue
   * fit, multi-speaker scan).
   *
   * Returns the relative output path on success, null on failure (and
   * marks the node failed via executor.markFailed).
   */
  private async executeSceneVideoPromptAssembly(
    node: ExecutionNode,
    toolCallId: string,
    agentName: string,
  ): Promise<string | null> {
    const sceneId = node.itemId;
    if (!sceneId) {
      this.executor.markFailed(node.id, `scene_video_prompt node has no itemId`);
      return null;
    }

    const toolName = 'assemble_scene_breakdown';
    this.emit({
      type: 'tool_call',
      toolCallId,
      toolName,
      arguments: { item: node.displayName, deterministic: true, scene: sceneId },
      agentName,
    });

    // 1. Load the scene_shot_plan (Stage A output) for this scene.
    const planNode = this.executor.getNode(`scene_shot_plan:${sceneId}`);
    if (!planNode || planNode.status !== 'completed' || !planNode.outputPath) {
      const msg = `scene_shot_plan:${sceneId} is not completed (status=${planNode?.status ?? 'missing'})`;
      this.executor.markFailed(node.id, msg);
      this.emit({ type: 'tool_result', toolCallId, toolName, result: { status: 'error', error: msg }, agentName, isError: true });
      this.emitTodoUpdate();
      return null;
    }
    let plan;
    try {
      const planPath = join(this.config.projectDir, planNode.outputPath);
      const planContent = readFileSync(planPath, 'utf-8').trim();
      const cleaned = planContent.startsWith('```')
        ? planContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
        : planContent;
      const parsed = JSON.parse(cleaned);
      const r = shotPlanSchema.safeParse(parsed);
      if (!r.success) {
        throw new Error(`shotPlanSchema mismatch: ${r.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ')}`);
      }
      plan = r.data;
    } catch (err) {
      const msg = `Failed to load scene_shot_plan for ${sceneId}: ${(err as Error).message}`;
      this.executor.markFailed(node.id, msg);
      this.emit({ type: 'tool_result', toolCallId, toolName, result: { status: 'error', error: msg }, agentName, isError: true });
      this.emitTodoUpdate();
      return null;
    }

    // 2. Load every shot_breakdown:{sceneId}_shot_* output. Order doesn't
    // matter — the assembler sorts by shotNumber.
    const shotNodes = this.executor.getAllNodes().filter(n =>
      n.typeId === 'shot_breakdown' && n.itemId?.startsWith(`${sceneId}_shot_`),
    );
    if (shotNodes.length === 0) {
      const msg = `No shot_breakdown nodes found for ${sceneId}`;
      this.executor.markFailed(node.id, msg);
      this.emit({ type: 'tool_result', toolCallId, toolName, result: { status: 'error', error: msg }, agentName, isError: true });
      this.emitTodoUpdate();
      return null;
    }
    const shots: SingleShot[] = [];
    for (const shotNode of shotNodes) {
      if (shotNode.status !== 'completed' || !shotNode.outputPath) {
        const msg = `${shotNode.id} is not completed (status=${shotNode.status})`;
        this.executor.markFailed(node.id, msg);
        this.emit({ type: 'tool_result', toolCallId, toolName, result: { status: 'error', error: msg }, agentName, isError: true });
        this.emitTodoUpdate();
        return null;
      }
      try {
        const shotPath = join(this.config.projectDir, shotNode.outputPath);
        const shotContent = readFileSync(shotPath, 'utf-8').trim();
        const cleaned = shotContent.startsWith('```')
          ? shotContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
          : shotContent;
        const parsed = JSON.parse(cleaned);
        const r = singleShotSchema.safeParse(parsed);
        if (!r.success) {
          throw new Error(`singleShotSchema mismatch: ${r.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ')}`);
        }
        shots.push(r.data);
      } catch (err) {
        const msg = `Failed to load ${shotNode.id}: ${(err as Error).message}`;
        this.executor.markFailed(node.id, msg);
        this.emit({ type: 'tool_result', toolCallId, toolName, result: { status: 'error', error: msg }, agentName, isError: true });
        this.emitTodoUpdate();
        return null;
      }
    }

    // 3. Stitch.
    //
    // Look up the prior scene's last shot so the first shot of THIS
    // scene can anchor on its last_frame (cross-scene continuity:
    // "exits door A in scene N → enters door B in scene N+1"). For
    // scene 1, or when the prior scene's plan isn't on disk yet,
    // we pass null and the assembler falls back to `fresh` for the
    // first shot.
    const sceneNumMatch = sceneId.match(/^scene_(\d+)$/);
    const sceneNum = sceneNumMatch ? parseInt(sceneNumMatch[1]!, 10) : 0;
    let priorSceneLastShot: { sceneId: string; shotNumber: number } | null = null;
    if (sceneNum >= 2) {
      const priorSceneId = `scene_${sceneNum - 1}`;
      const priorShotBreakdowns = this.executor.getAllNodes()
        .filter((n) => n.typeId === 'shot_breakdown' && n.itemId?.startsWith(`${priorSceneId}_shot_`))
        .map((n) => {
          const m = n.itemId!.match(/_shot_(\d+)$/);
          return m ? parseInt(m[1]!, 10) : 0;
        })
        .filter((n) => n > 0)
        .sort((a, b) => b - a);
      if (priorShotBreakdowns.length > 0) {
        priorSceneLastShot = { sceneId: priorSceneId, shotNumber: priorShotBreakdowns[0]! };
      }
    }

    let assembled;
    try {
      assembled = assembleSceneVideoPrompt(plan, shots, priorSceneLastShot);
    } catch (err) {
      const msg = `Assembler rejected inputs for ${sceneId}: ${(err as Error).message}`;
      this.executor.markFailed(node.id, msg);
      this.emit({ type: 'tool_result', toolCallId, toolName, result: { status: 'error', error: msg }, agentName, isError: true });
      this.emitTodoUpdate();
      return null;
    }

    // 4. Run the existing post-validators by routing the assembled JSON
    // through validateJsonOutput — that path runs normalizeSceneVideoPrompt,
    // continuity-sequence, one-setting-per-scene, dialogue-fit and
    // multi-speaker checks. Any of them rejecting marks the node failed
    // so the user sees the same error semantics as the legacy LLM path.
    const content = JSON.stringify(assembled, null, 2);
    const validation = this.validateJsonOutput(content, node);
    if (!validation.valid) {
      // Persist the assembled-but-rejected content so the user can
      // inspect what was stitched (often the post-validators flag a
      // continuity / dialogue-fit issue and the user wants to see
      // exactly which shot tripped which rule).
      const sidecar = writeFailedAttempt(
        node,
        content,
        validation.error ?? 'unknown validation error',
        this.config.projectDir,
        this.config.template,
      );
      const hint = sidecar.contentPath
        ? ` Assembled output saved to ${sidecar.contentPath} (.failed).`
        : '';
      const msg = `Assembled scene_video_prompt failed post-validation: ${validation.error}.${hint}`;
      this.executor.markFailed(node.id, msg);
      this.emit({ type: 'tool_result', toolCallId, toolName, result: { status: 'error', error: msg }, agentName, isError: true });
      this.emitTodoUpdate();
      return null;
    }
    const finalContent = validation.normalizedContent ?? content;

    // 5. Write to disk and emit completion.
    const outputRel = writeOutput(node, finalContent, this.config.projectDir, this.config.template);
    // Clean up any prior .failed sidecars from a previous broken run.
    clearFailedAttempt(node, this.config.projectDir, this.config.template);
    this.log(`  scene_video_prompt assembled: ${outputRel} (${shots.length} shots)`);
    this.emit({
      type: 'tool_result',
      toolCallId,
      toolName,
      result: { status: 'completed', file: outputRel, shots: shots.length },
      agentName,
    });
    this.emit({
      type: 'agent_text',
      text: `**Scene Breakdown** → \`${outputRel}\` (assembled ${shots.length} shots from plan + per-shot LLM outputs)`,
      isFinal: false,
    });

    return outputRel;
  }

  /**
   * Generate an actual video from a motion prompt file + scene image.
   */
  private async executeVideoGeneration(
    node: ExecutionNode,
    promptFilePath: string,
    toolCallId: string,
    agentName: string,
  ): Promise<string | null> {
    this.log(`  Generating video from prompt: ${promptFilePath}`);

    const genCallId = `vid_${node.id}_${Date.now()}`;
    const toolName = `generate_video`;
    this.emit({
      type: 'tool_call',
      toolCallId: genCallId,
      toolName,
      arguments: { item: node.displayName },
      agentName,
    });

    try {
      // Find the source image from completed dependencies
      // For shot_video: the source image comes from shot_image_prompt (which generates the shot image)
      // For legacy scene_video: would come from scene_image
      let sourceImagePath: string | undefined;
      for (const depId of node.dependencies) {
        const dep = this.executor.getNode(depId);
        if (dep?.outputPath?.endsWith('.png') || dep?.outputPath?.endsWith('.jpg')) {
          sourceImagePath = dep.outputPath;
          break;
        }
      }

      if (!sourceImagePath) {
        this.log(`  No source image found in dependencies for video gen`);
        this.log(`  Dependencies: ${node.dependencies.join(', ')}`);
        for (const depId of node.dependencies) {
          const dep = this.executor.getNode(depId);
          this.log(`    ${depId}: status=${dep?.status}, outputPath=${dep?.outputPath}`);
        }
        return null;
      }

      // Read motion prompt
      const motionContent = readFileSync(promptFilePath, 'utf-8');
      const sceneNumber = parseInt(node.itemId?.match(/(\d+)/)?.[1] ?? '1', 10);
      const shotNumber = parseInt(node.itemId?.match(/shot_(\d+)/)?.[1] ?? '1', 10);

      this.emit({
        type: 'tool_streaming',
        toolCallId: genCallId,
        chunk: `Generating video for ${node.displayName}...\n`,
        done: false,
        agentName,
        toolName,
      });

      // Call video generation via provider
      const provider = getProviderRegistry().getVideoGenerator();
      if (!provider?.generateVideo) {
        this.log(`  No video generation provider available`);
        return null;
      }

      const assetsDir = join(this.config.projectDir, 'assets', 'videos');
      if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });

      const result = await provider.generateVideo(
        {
          sourceImagePath: join(this.config.projectDir, sourceImagePath),
          prompt: motionContent,
          outputDir: assetsDir,
          filenamePrefix: `scene_${sceneNumber}_shot_${shotNumber}`,
        },
        (info) => {
          this.emit({
            type: 'tool_streaming',
            toolCallId: genCallId,
            chunk: `Step ${info.step ?? 0}/${info.maxSteps ?? 0} (${info.percentage}%)`,
            done: info.done,
            agentName,
            toolName,
          });
        },
      );

      const relPath = relative(this.config.projectDir, result.filePath);
      this.log(`  Video generated: ${relPath}`);

      // Register asset
      const artifactId = `vid_${Date.now()}`;
      try {
        addAsset({
          id: artifactId,
          type: 'scene_video',
          path: relPath,
          createdAt: Date.now(),
          nodeId: node.id,
        });
      } catch { /* non-fatal */ }

      this.emit({
        type: 'tool_result',
        toolCallId: genCallId,
        toolName,
        result: { status: 'completed', file_path: relPath },
        agentName,
      });
      return relPath;
    } catch (error) {
      this.log(`  Video generation error: ${String(error)}`);
      this.emit({
        type: 'tool_result',
        toolCallId: genCallId,
        toolName,
        result: { status: 'error', error: String(error) },
        agentName,
        isError: true,
      });
      return null;
    }
  }

  /**
   * Execute final video assembly from timeline. Purely deterministic — no LLM.
   * Creates timeline skeleton if needed, validates, and runs FFmpeg.
   */
  private async executeFinalAssembly(
    node: ExecutionNode,
    toolCallId: string,
  ): Promise<string | null> {
    const agentName = this.config.name ?? 'dhee-executor';
    const projectDir = this.config.projectDir;

    this.log(`  Starting final assembly`);
    this.emit({
      type: 'tool_call',
      toolCallId,
      toolName: 'assemble_final_video',
      arguments: { item: node.displayName },
      agentName,
    });
    this.emit({
      type: 'tool_streaming',
      toolCallId,
      chunk: 'Assembling final video from timeline...\n',
      done: false,
      agentName,
      toolName: 'assemble_final_video',
    });

    try {
      this.ensureTimelineInitialized();
      if (!this.timeline) {
        const msg = 'Timeline missing — cannot assemble';
        this.log(`  ${msg}`);
        this.lastNodeError = `Final assembly: ${msg}`;
        return null;
      }

      const validation = validateTimeline(this.timeline);
      this.log(`  Timeline: ${validation.filledDuration}/${this.timeline.totalDuration}s filled, ${validation.warnings.length} warnings`);

      const { resolved, errors } = resolveSegmentFilePaths(this.timeline, projectDir);
      if (errors.length > 0) {
        const msg = `Timeline resolution errors: ${errors.join('; ')}`;
        this.log(`  ${msg}`);
        this.lastNodeError = `Final assembly: ${msg}`;
        return null;
      }
      if (resolved.length === 0) {
        const msg = 'No resolved segments from timeline — cannot assemble';
        this.log(`  ${msg}`);
        this.lastNodeError = `Final assembly: ${msg}`;
        return null;
      }
      let resolvedSegments = resolved;

      this.emit({
        type: 'tool_streaming',
        toolCallId,
        chunk: `Timeline: ${resolved.length} segments resolved (${Math.round(validation.filledDuration)}s filled)\n`,
        done: false,
        agentName,
        toolName: 'assemble_final_video',
      });

      // Filter out shots subsumed by v2v_extend successors.
      // A v2v_extend video already contains the previous shot's frames — including both
      // in the assembly would duplicate content.
      // Only uses explicit generationStrategy from manifest metadata — never guesses.
      {
        const { filterSubsumedShots } = await import('./crossShotChaining.js');
        const manifestPath = join(projectDir, 'assets', 'manifest.json');
        let manifest: Array<{ path: string; metadata?: Record<string, unknown> }> = [];
        try {
          if (existsSync(manifestPath)) {
            manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')).assets ?? [];
          }
        } catch { /* no manifest */ }

        // Build path→strategy lookup from manifest metadata (only explicit, never inferred)
        const strategyByPath = new Map<string, string>();
        for (const asset of manifest) {
          const strategy = asset.metadata?.['generationStrategy'] as string | undefined;
          if (strategy && asset.path) {
            strategyByPath.set(join(projectDir, asset.path), strategy);
          }
        }

        const enriched = resolvedSegments.map(s => ({
          ...s,
          strategy: strategyByPath.get(s.filePath),
        }));

        const filtered = filterSubsumedShots(enriched);
        const removedCount = resolvedSegments.length - filtered.length;
        if (removedCount > 0) {
          this.log(`  V2V dedup: removed ${removedCount} shot(s) subsumed by v2v_extend successors`);
          this.emit({
            type: 'tool_streaming',
            toolCallId,
            chunk: `V2V dedup: ${removedCount} shot(s) subsumed by v2v_extend — skipped to avoid duplicate frames\n`,
            done: false,
            agentName,
            toolName: 'assemble_final_video',
          });
        }
        resolvedSegments = filtered;
      }

      // Log transition data for debugging
      const transitionSummary = resolvedSegments
        .filter(s => s.transition && s.transition !== 'cut')
        .map(s => `${s.segmentId}:${s.transition}(${s.transitionDuration}s)`);
      this.log(`  Transitions: ${transitionSummary.length > 0 ? transitionSummary.join(', ') : 'none (all cuts)'}`);
      const totalDuration = resolvedSegments.reduce((sum, s) => sum + s.duration, 0);

      this.emit({
        type: 'tool_streaming',
        toolCallId,
        chunk: `Total duration: ${Math.round(totalDuration)}s from ${resolvedSegments.length} shots (${transitionSummary.length} transitions)\n`,
        done: false,
        agentName,
        toolName: 'assemble_final_video',
      });

      // Run FFmpeg assembly
      const outputDir = join(projectDir, 'assets', 'videos', 'final');
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
      // Don't overwrite existing final videos — find next available version
      let outputPath = join(outputDir, 'final_video.mp4');
      if (existsSync(outputPath)) {
        let version = 2;
        while (existsSync(join(outputDir, `final_video${version}.mp4`))) {
          version++;
        }
        outputPath = join(outputDir, `final_video${version}.mp4`);
        this.log(`  Previous final video exists — writing to final_video${version}.mp4`);
      }

      this.emit({
        type: 'tool_streaming',
        toolCallId,
        chunk: `Running FFmpeg assembly...\n`,
        done: false,
        agentName,
        toolName: 'assemble_final_video',
      });

      const result = await assembleVideos(resolvedSegments, outputPath);

      if (result.success) {
        const relPath = relative(projectDir, result.outputPath);
        this.log(`  Final video assembled: ${relPath} (${result.duration}s, ${result.fileSize} bytes)`);

        // Snapshot the inputs that fed this cut + diff against the
        // most recent prior final_video. Stamping both onto the asset
        // metadata is what powers Watch's V1/V2/V3 changelog cards.
        // Snapshot paths are stored RELATIVE to projectDir so they
        // stay valid if the project is moved between machines.
        let currentSnapshot: FinalVideoSnapshot | null = null;
        let diffMeta:
          | { added: string[]; removed: string[]; modified: string[]; reorderedCount: number; fromVersion: number }
          | null = null;
        let versionNumber = 1;
        try {
          currentSnapshot = buildFinalVideoSnapshot(
            resolvedSegments.map((s) => ({
              ...s,
              filePath: relative(projectDir, s.filePath),
            })),
            (relP) => {
              try {
                return statSync(join(projectDir, relP)).mtimeMs;
              } catch {
                return 0;
              }
            },
            Date.now(),
          );
          const manifestPath = join(projectDir, 'assets', 'manifest.json');
          let priorAssets: Array<{
            type?: string;
            createdAt?: number;
            created_at?: number;
            metadata?: { snapshot?: FinalVideoSnapshot; versionNumber?: number };
          }> = [];
          if (existsSync(manifestPath)) {
            try {
              priorAssets = JSON.parse(readFileSync(manifestPath, 'utf-8')).assets ?? [];
            } catch {
              priorAssets = [];
            }
          }
          const priorFinals = priorAssets
            .filter((a) => a.type === 'final_video')
            .sort((a, b) => (a.createdAt ?? a.created_at ?? 0) - (b.createdAt ?? b.created_at ?? 0));
          versionNumber = priorFinals.length + 1;
          const previous = priorFinals[priorFinals.length - 1];
          const previousSnapshot = previous?.metadata?.snapshot ?? null;
          if (previousSnapshot) {
            const previousVersionNumber = previous?.metadata?.versionNumber ?? priorFinals.length;
            const rawDiff = diffFinalVideoSnapshots(previousSnapshot, currentSnapshot);
            diffMeta = { ...rawDiff, fromVersion: previousVersionNumber };
          }
        } catch (err) {
          this.log(`  Snapshot/diff capture failed (non-fatal): ${String(err)}`);
        }

        // Register asset
        try {
          const baseMeta: Record<string, unknown> = {
            duration: result.duration,
            fileSize: result.fileSize,
            versionNumber,
          };
          if (currentSnapshot) baseMeta['snapshot'] = currentSnapshot;
          if (diffMeta) baseMeta['diff'] = diffMeta;
          addAsset({
            id: `final-video-${Date.now()}`,
            type: 'final_video',
            path: relPath,
            createdAt: Date.now(),
            metadata: baseMeta,
            nodeId: node.id,
          });
        } catch { /* non-fatal */ }

        captureFinalVideoCreated({
          durationSeconds: result.duration,
          fileSizeBytes: result.fileSize,
          versionNumber,
          templateId: this.config.project.templateId,
          style: this.config.project.style,
          segmentCount: resolvedSegments.length,
          projectDir,
          assemblyPathType: 'executor_final_assembly',
        });

        this.emit({
          type: 'tool_streaming',
          toolCallId,
          chunk: `Final video: ${relPath} (${Math.round(result.duration)}s)`,
          done: true,
          agentName,
          toolName: 'assemble_final_video',
        });

        // Emit tool_result so the UI can render the video in the timeline
        this.emit({
          type: 'tool_result',
          toolCallId,
          toolName: 'assemble_final_video',
          result: { status: 'completed', file_path: relPath, duration: result.duration, fileSize: result.fileSize },
          agentName,
        });

        return relPath;
      } else {
        const msg = 'FFmpeg assembly returned failure';
        this.log(`  Assembly failed`);
        this.lastNodeError = `Final assembly: ${msg}`;
        return null;
      }
    } catch (error) {
      const msg = String(error);
      this.log(`  Assembly error: ${msg}`);
      this.lastNodeError = `Final assembly: ${msg}`;
      this.emit({
        type: 'tool_result',
        toolCallId,
        toolName: 'assemble_final_video',
        result: { status: 'error', error: msg },
        agentName,
        isError: true,
      });
      return null;
    }
  }

  private persistState(): void {
    try {
      this.config.project.executorState = this.executor.getState();
      this.config.project.updatedAt = Date.now();
      const dir = this.config.projectDir;
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const filePath = join(dir, 'project.json');
      atomicWriteFileSync(filePath, JSON.stringify(this.config.project, null, 2), 'utf-8');
    } catch (error) {
      // Non-fatal — execution can continue without persistence
      this.emit({
        type: 'notification',
        level: 'warning',
        message: `Failed to persist state: ${String(error)}`,
      });
    }
  }
}
