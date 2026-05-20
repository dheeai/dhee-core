/**
 * Core Types for Goal-Driven Planning
 *
 * These types support the backward-planning system that determines
 * the minimal execution path from user goals.
 */

/**
 * User's goal as understood by the agent.
 * NOT a fixed enum - the agent determines this dynamically
 * through natural language understanding.
 */
export interface UserGoal {
  /** What artifact types the user ultimately wants */
  targetArtifacts: string[];

  /** User's preferences extracted from conversation */
  preferences: GoalPreferences;

  /** Original user description of what they want */
  description: string;
}

/**
 * Persisted goal with lifecycle metadata.
 * Stored in project.json to survive across sessions.
 */
export interface PersistedGoal extends UserGoal {
  /** When the goal was set */
  setAt: number;
  /** When the goal was achieved (plan returned 0 steps) */
  achievedAt?: number;
  /** Goal lifecycle status */
  status: 'active' | 'achieved' | 'superseded';
}

/**
 * Preferences extracted from user's goal description
 */
export interface GoalPreferences {
  /** Visual style preference (e.g., "anime", "realistic") */
  style?: string;

  /** Target duration in seconds */
  duration?: number;

  /** Output format preference */
  format?: string;

  /** Any other key-value preferences */
  [key: string]: string | number | boolean | undefined;
}

/**
 * Asset that already exists or was provided by the user.
 * Assets can come from various sources and may satisfy
 * artifact requirements without needing generation.
 */
export interface ProvidedAsset {
  /** Unique identifier for this asset */
  id: string;

  /** The artifact type this asset can satisfy */
  artifactTypeId: string;

  /** For collection items: the specific item ID */
  itemId?: string;

  /** Path to the asset file (if file-based) */
  path?: string;

  /** Content of the asset (if inline) */
  content?: string;

  /** Where this asset came from */
  source: AssetSource;

  /** When this asset was registered */
  registeredAt: number;

  /** Optional metadata about the asset */
  metadata?: Record<string, unknown>;
}

/**
 * Sources an asset can come from
 */
export type AssetSource =
  | 'user_provided'      // User explicitly provided the asset
  | 'previously_generated' // Generated in a previous session
  | 'imported'           // Imported from an external source
  | 'detected';          // Auto-detected from project directory

/**
 * Registry tracking what assets already exist.
 * Used to determine what can be skipped during planning.
 */
export interface AssetRegistry {
  /** All known assets, keyed by asset ID */
  assets: Map<string, ProvidedAsset>;

  /** Which artifact types are fully or partially satisfied */
  satisfiedArtifacts: Map<string, SatisfactionLevel>;

  /** Timestamp of last scan */
  lastScanAt: number;
}

/**
 * How completely an artifact type is satisfied
 */
export type SatisfactionLevel =
  | 'full'     // All required items exist
  | 'partial'; // Some items exist but not all

/**
 * Execution plan built by backward traversal through the dependency graph.
 * Contains only the steps needed to reach the user's goal.
 */
export interface ExecutionPlan {
  /** The goal this plan achieves */
  goal: UserGoal;

  /** Ordered list of steps to execute */
  steps: PlanStep[];

  /** Artifact types that will be skipped (already exist) */
  skippedArtifacts: SkippedArtifact[];

  /** Human-readable summary of the plan */
  summary: string;

  /** Total number of expensive operations */
  expensiveStepCount: number;

  /** Whether user approval is recommended before execution */
  requiresApproval: boolean;

  /** Duration-aware planning hints (present when goal has duration preference) */
  timelineHints?: TimelineHints;
}

/**
 * Information about an artifact that will be skipped
 */
export interface SkippedArtifact {
  /** Artifact type ID */
  typeId: string;

  /** Reason for skipping */
  reason: string;

  /** Asset IDs that satisfy this artifact */
  satisfiedBy: string[];
}

/**
 * Single step in the execution plan
 */
export interface PlanStep {
  /** Unique step identifier */
  id: string;

  /** Artifact type to create */
  artifactTypeId: string;

  /** For collections: specific item to create */
  itemId?: string;

  /** Step IDs this step depends on */
  dependsOn: string[];

  /** Why this step is needed (human-readable) */
  reason: string;

  /** Whether this is an expensive (image/video) operation */
  isExpensive: boolean;

  /** Display name for the artifact */
  displayName: string;

  /** Estimated relative cost (for ordering/prioritization) */
  estimatedCost: number;
}

/**
 * Duration-aware hints for the agent to plan enough content.
 * Computed when the goal has a duration preference.
 */
export interface TimelineHints {
  /** Recommended number of segments to fill the duration */
  suggestedSegmentCount: number;
  /** Recommended duration per segment (seconds) */
  suggestedSegmentDuration: number;
  /** Total target duration (seconds) */
  totalDuration: number;
  /** Maximum duration for a single generated clip (seconds) */
  maxClipDuration: number;
  /** Human-readable explanation for the agent */
  reasoning: string;
}

/**
 * Result of scanning for existing assets
 */
export interface ScanResult {
  /** The asset registry built from the scan */
  registry: AssetRegistry;

  /** Number of assets found */
  assetCount: number;

  /** Any issues encountered during scanning */
  issues: ScanIssue[];
}

/**
 * Issue encountered during asset scanning
 */
export interface ScanIssue {
  /** Type of issue */
  type: 'warning' | 'error';

  /** Description of the issue */
  message: string;

  /** Path or location related to the issue */
  location?: string;
}

/**
 * Options for the backward planner
 */
export interface PlannerOptions {
  /** Include optional dependencies in the plan */
  includeOptional?: boolean;

  /** Maximum depth to traverse (for cycle protection) */
  maxDepth?: number;

  /** Whether to validate the plan before returning */
  validate?: boolean;
}

/**
 * Result of plan validation
 */
export interface PlanValidation {
  /** Whether the plan is valid */
  valid: boolean;

  /** Validation errors */
  errors: string[];

  /** Validation warnings */
  warnings: string[];
}

// ============================================================================
// Dependency Graph Executor Types
// ============================================================================

/**
 * Status of a node in the execution graph.
 */
export type NodeStatus = 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/**
 * A node in the dependency execution graph.
 * Represents a single artifact (or collection item) to be created.
 */
export interface ExecutionNode {
  /** Unique node ID: "{typeId}" or "{typeId}:{itemId}" */
  id: string;

  /** Artifact type (e.g., "character", "scene_image") */
  typeId: string;

  /** For collection items: the specific item (e.g., "alice", "scene_1") */
  itemId?: string;

  /** Current status */
  status: NodeStatus;

  /** Human-readable name */
  displayName: string;

  /** Whether this is an expensive operation (image/video generation) */
  isExpensive: boolean;

  /** Whether this is a type-level placeholder for a collection (not yet expanded) */
  isCollection: boolean;

  /** Node IDs this depends on */
  dependencies: string[];

  /** Node IDs that depend on this */
  dependents: string[];

  /** Error message if status is 'failed' */
  error?: string;

  /** Timestamp when generation completed */
  completedAt?: number;

  /** Timestamp when generation started */
  startedAt?: number;

  /** Path where output was written */
  outputPath?: string;

  /** Multiple output paths keyed by frame requirement ID (for multi-frame modes) */
  outputPaths?: Record<string, string>;

  /**
   * Path where the intermediate prompt JSON was written — for two-stage
   * media nodes where the LLM first produces a prompt JSON (step 1) and
   * then ComfyUI renders an image/video from it (step 2).
   *
   * Tracked separately from `outputPath` (which holds the final image/video
   * path) so the executor can distinguish "prompt already generated, only
   * re-render the image" from "everything's fresh."
   *
   * CRITICAL: project.json is the source of truth — if `promptPath` is
   * undefined, any JSON file at the expected disk location is an ORPHAN
   * from a prior run and must NOT short-circuit LLM regeneration. This
   * is what makes `/reset <stage>` actually regenerate prompts on the
   * next `/run-to`.
   */
  promptPath?: string;

  /** Artifact instance ID after creation */
  artifactId?: string;

  /**
   * Per-item user-facing metadata that used to live on parallel flat
   * arrays (`project.characters[i].approvalStatus` etc.). Living here
   * makes the graph node the single source of truth for everything
   * about this artifact — content + execution state + approval —
   * which is the goal of the
   * `refactor/unify-graph-as-source-of-truth` branch.
   *
   * All fields optional. New fields are added here, not on a separate
   * entity, so we don't recreate the dual-state mess.
   */
  metadata?: ExecutionNodeMetadata;
}

export interface ExecutionNodeMetadata {
  /** User-facing name when distinct from `displayName` (which carries
   *  the typeDef prefix, e.g. "Character: Jan"). */
  name?: string;
  /** A 1-line summary surfaced in agent-context tools / UI. */
  summary?: string;
  // NOTE: approval / regeneration / feedback state is intentionally
  // NOT modeled here. Approval lives in pi-agent (the external
  // orchestrator); dhee-core just runs the executor. Don't
  // reintroduce approval fields without explicit direction.
}

/**
 * Serializable state of the executor for persistence across sessions.
 */
export interface ExecutorState {
  /** All nodes keyed by node ID */
  nodes: Record<string, ExecutionNode>;

  /** Target artifact types requested by the user */
  targetArtifacts: string[];

  /** Description of the user's goal */
  goalDescription: string;

  /** When the executor was created */
  createdAt: number;

  /** Last state update */
  updatedAt: number;

  /** When all targets were completed */
  completedAt?: number;
}

/**
 * Resolved inputs for a node — all dependency content pre-loaded by code.
 */
export interface ResolvedInputs {
  /** Formatted context block with all dependency content */
  contextBlock: string;

  /** Individual dependency contents keyed by typeId (or typeId:itemId) */
  dependencies: Record<string, string>;

  /** Reference image paths (verified to exist on disk) */
  referenceImages: Array<{
    name: string;
    path: string;
    type: 'character' | 'setting';
  }>;

  /** Files that were read (for logging/debugging) */
  filesRead: string[];
}

/**
 * Progress summary of the executor.
 */
export interface ExecutorProgress {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  failed: number;
  skipped: number;
}

/**
 * Callbacks for the executor to communicate with the UI layer.
 *
 * @deprecated DELETE — entire interface and all members are dead. Zero
 * implementations and zero callers in src/. The current `ExecutorAgent` does
 * not consume an `ExecutorCallbacks` shape; UI streaming flows through the
 * `ConversationManager` event bus, not through these callbacks. The
 * `onApprovalNeeded` member in particular is an approval-fatigue artifact —
 * see `todos/cleanup-deprecated-agent-architecture.md`. Note: a separate
 * `todos/approval-gates.md` proposes a *new* structured-review feature that
 * would reuse the name `onApprovalNeeded`, but it is not built — the existing
 * declaration here is dead, not in flight.
 */
export interface ExecutorCallbacks {
  /** Called when a node starts processing */
  onNodeStarted(node: ExecutionNode): void;

  /** Called for expensive ops — return true to proceed, false to skip */
  onApprovalNeeded(node: ExecutionNode, inputs: ResolvedInputs): Promise<boolean>;

  /** Called when a node completes */
  onNodeCompleted(node: ExecutionNode, outputPath: string): void;

  /** Called when a node fails — return true to retry */
  onNodeFailed(node: ExecutionNode, error: unknown): Promise<boolean>;

  /** Called when all nodes complete */
  onComplete(progress: ExecutorProgress): void;

  /** Called to stream content to UI during generation */
  onContentStreaming(node: ExecutionNode, chunk: string): void;
}

/**
 * Items extracted from a collection node's output.
 */
export interface CollectionItems {
  /** Character names found */
  characters?: string[];

  /** Setting/location names found */
  settings?: string[];

  /** Object/prop names found */
  objects?: string[];

  /** Scene descriptions found. `estimatedDuration` is populated by the
   * duration-first extractor (sum of beat durations). Downstream uses it
   * for `perSceneDuration` instead of `targetDuration / sceneCount`. */
  scenes?: Array<{
    sceneNumber: number;
    title: string;
    summary: string;
    estimatedDuration?: number;
  }>;

  /** Shots extracted from a scene video prompt (structured JSON) */
  shots?: Array<{
    shotNumber: number;
    shotType: string;
    duration: number;
    description: string;
    cameraWork?: string;
    characters?: string[];
    setting?: string | null;
  }>;
}
