/**
 * Type definitions for the state-based video generation workflow.
 * 8-phase workflow: plot → story → characters_settings → scenes → character_setting_images → scene_images → video → video_combine
 */

import type { PersistedGoal } from '../../../core/planner/types.js';

/**
 * Project file version - used to detect incompatible old projects.
 */
export const PROJECT_VERSION = '3.0';

/**
 * Visual style for the project.
 * This determines the overall aesthetic of generated images and videos.
 */
export type ProjectStyle = 'cinematic_realism' | 'anime' | (string & {});

/**
 * Style configuration with display names and prompt modifiers.
 */
export interface StyleConfig {
  /** Display name shown to user */
  displayName: string;
  /** Short description of the style */
  description: string;
  /** Positive prompt additions for this style */
  promptModifier: string;
  /** Negative prompt additions for this style */
  negativePromptModifier: string;
}

/**
 * Style configurations for each project style.
 */
export const STYLE_CONFIGS: Record<ProjectStyle, StyleConfig> = {
  cinematic_realism: {
    displayName: 'Cinematic Realism',
    description: 'Photorealistic, cinematic look with dramatic lighting and film-quality visuals',
    promptModifier:
      'cinematic, photorealistic, dramatic lighting, high detail, film quality, 8k, professional photography',
    negativePromptModifier: 'anime, cartoon, illustration, drawing, sketch, 2d, cel shaded',
  },
  anime: {
    displayName: 'Anime',
    description: 'Japanese anime style with vibrant colors and expressive characters',
    promptModifier:
      'anime style, anime art, vibrant colors, detailed anime, studio quality anime, anime aesthetic',
    negativePromptModifier: 'photorealistic, realistic, photograph, live action, 3d render',
  },
};

/**
 * Type of input provided by the user.
 * This determines which phases can be skipped.
 */
export type InputType = 'idea' | 'story' | 'multi_input';

// ============================================================================
// Multi-Input Type System
// ============================================================================

/**
 * Source type - where the input comes from.
 */
export type InputSourceType = 'local_path' | 'remote_url' | 'youtube' | 'inline';

/**
 * Media type - what kind of content.
 */
export type InputMediaType = 'text' | 'audio' | 'image' | 'video';

/**
 * Purpose - how the input will be used in the workflow.
 */
export type InputPurpose =
  | 'narration' // Story/script (text or audio)
  | 'style_ref' // Visual style reference
  | 'motion_ref' // Motion/animation reference
  | 'character_ref' // Character appearance reference
  | 'setting_ref' // Setting/location reference
  | 'anchor_video' // Pre-recorded speaker
  | 'background_music' // Audio for background
  | 'reference_general'; // General reference (user specifies how)

/**
 * Anchor video workflow mode - how to use pre-recorded speaker video.
 */
export type AnchorWorkflowMode =
  | 'b_roll_overlay' // Picture-in-picture / cutaways
  | 'scene_integration' // Composite into generated scenes
  | 'audio_extraction'; // Use audio only, generate new visuals

/**
 * Processing status for an input.
 */
export type InputProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Single input entry for the project.
 */
export interface ProjectInput {
  /** Unique identifier for this input */
  id: string;

  /** Source information */
  source: {
    /** Type of source (local file, URL, YouTube, inline text) */
    type: InputSourceType;
    /** The actual path, URL, or inline content */
    value: string;
    /** Original user-provided string before any normalization */
    originalValue?: string;
  };

  /** Classification */
  /** Type of media (text, audio, image, video) */
  mediaType: InputMediaType;
  /** Intended purpose of this input */
  purpose: InputPurpose;
  /** Workflow mode for anchor videos only */
  anchorMode?: AnchorWorkflowMode;

  /** Metadata about the input */
  metadata: {
    /** Original filename if from file */
    originalFilename?: string;
    /** MIME type if known */
    mimeType?: string;
    /** Duration in seconds for audio/video */
    duration?: number;
    /** Resolution for images/video */
    resolution?: { width: number; height: number };
    /** File size in bytes */
    fileSize?: number;
    /** YouTube video ID if from YouTube */
    youtubeId?: string;
    /** YouTube video title */
    youtubeTitle?: string;
    /** Timestamp when user provided the input */
    addedAt: number;
    /** Timestamp when processing completed */
    processedAt?: number;
  };

  /** Processing results */
  processing: {
    /** Current processing status */
    status: InputProcessingStatus;
    /** Local path to downloaded/copied content */
    localPath?: string;
    /** Transcription text for audio inputs */
    transcription?: string;
    /** Path to transcription file */
    transcriptionPath?: string;
    /** Path to extracted audio (from video) */
    extractedAudioPath?: string;
    /** Paths to extracted keyframes (from video) */
    keyframePaths?: string[];
    /** Timing markers for audio sync */
    timingMarkers?: Array<{
      /** Start time in seconds */
      start: number;
      /** End time in seconds */
      end: number;
      /** Text content for this segment */
      text: string;
    }>;
    /** Error message if processing failed */
    error?: string;
  };

  /** User annotations/notes about this input */
  notes?: string;
}

/**
 * Primary narration source configuration.
 */
export interface PrimaryNarrationConfig {
  /** ID of the input used as narration */
  inputId: string;
  /** Type of narration source */
  type: 'text' | 'audio' | 'transcription';
  /** Whether to preserve original audio in final video */
  preserveAudio: boolean;
}

/**
 * Video workflow phases in execution order.
 * 8-phase workflow matching Sequence.md specification.
 * NOTE: This enum must be declared before INPUT_TYPE_CONFIGS which references it.
 */
export enum WorkflowPhase {
  /** Phase 1: Analyze input and create plot outline */
  PLOT = 'plot',

  /** Phase 2: Generate full story from plot (or accept direct story input) */
  STORY = 'story',

  /** Phase 3: Plan and create detailed descriptions for each character and setting */
  CHARACTERS_SETTINGS = 'characters_settings',

  /** Phase 4: Break story into individual visual scenes with descriptions */
  SCENES = 'scenes',

  /** Phase 5: Generate reference images for each character and setting (text-to-image) */
  CHARACTER_SETTING_IMAGES = 'character_setting_images',

  /** Phase 6: Generate scene images using character/setting references (image+text-to-image) */
  SCENE_IMAGES = 'scene_images',

  /** Phase 7: Generate video clip for each scene image */
  VIDEO = 'video',

  /** Phase 8: Stitch all scene videos into final video */
  VIDEO_COMBINE = 'video_combine',

  /** Workflow complete */
  COMPLETED = 'completed',
}

/**
 * Input type configuration with display names and phase implications.
 */
export interface InputTypeConfig {
  /** Display name shown to user */
  displayName: string;
  /** Description of this input type */
  description: string;
  /** Which phase to start from */
  startPhase: WorkflowPhase;
  /** Phases to mark as skipped/completed */
  skipPhases: WorkflowPhase[];
}

/**
 * Input type configurations.
 */
export const INPUT_TYPE_CONFIGS: Record<InputType, InputTypeConfig> = {
  idea: {
    displayName: 'Story Idea',
    description: 'A brief concept or premise that needs to be developed into a full story',
    startPhase: WorkflowPhase.PLOT,
    skipPhases: [],
  },
  story: {
    displayName: 'Complete Story',
    description: 'A full story, chapter, or detailed narrative ready for visualization',
    startPhase: WorkflowPhase.CHARACTERS_SETTINGS,
    skipPhases: [WorkflowPhase.PLOT, WorkflowPhase.STORY],
  },
  multi_input: {
    displayName: 'Multi-Input Project',
    description:
      'Project with multiple input sources (text, audio, images, video) that can be added dynamically',
    startPhase: WorkflowPhase.PLOT, // Default start, adjusted based on inputs
    skipPhases: [], // Determined dynamically based on provided inputs
  },
};

/**
 * Planner stage within a phase.
 * Each planning agent goes through these stages.
 */
export enum PlannerStage {
  /** Initial planning - creating the first draft */
  PLANNING = 'planning',
  /** Presenting plan to user for verification */
  VERIFY = 'verify',
  /** Refining based on user feedback */
  REFINING = 'refining',
  /** Plan approved, ready to execute */
  COMPLETE = 'complete',
}

/**
 * Phase status values.
 */
export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

/**
 * Phase metadata stored in project.json.
 */
export interface PhaseInfo {
  /** Current status of the phase */
  status: PhaseStatus;
  /** Current planner stage (if in_progress) */
  plannerStage?: PlannerStage;
  /** Path to the plan file (relative to .dhee/) */
  planFile?: string;
  /** Timestamp when phase started */
  startedAt?: number;
  /** Timestamp when phase was completed */
  completedAt: number | null;
  /** Number of refinement iterations */
  refinementCount?: number;
}

/**
 * @deprecated DELETE — approval-fatigue artifact from the pre-graph-executor world.
 * The dependency-graph executor does not gate per-item user approvals; it generates,
 * cascades regenerations, and surfaces results. No code reads or writes this status.
 * Tracked in `todos/cleanup-deprecated-agent-architecture.md`.
 */
export type ItemApprovalStatus = 'pending' | 'in_review' | 'approved' | 'rejected' | 'regenerating';

/**
 * @deprecated DELETE — see `ItemApprovalStatus`. Approval-fatigue artifact; no live readers/writers.
 * Tracked in `todos/cleanup-deprecated-agent-architecture.md`.
 */
export interface ItemApprovalEntry {
  /** Unique identifier for this item */
  id: string;
  /** Item type */
  type: 'character' | 'setting' | 'scene';
  /** Item name */
  name: string;
  /** Current approval status */
  status: ItemApprovalStatus;
  /** Number of regeneration attempts */
  regenerationCount: number;
  /** Associated content artifact ID (if generated) */
  contentArtifactId?: string;
  /** Associated image artifact ID (if generated) */
  imageArtifactId?: string;
  /** Associated video artifact ID (if generated) */
  videoArtifactId?: string;
  /** User feedback (if rejected) */
  feedback?: string;
  /** Timestamp when approved */
  approvedAt?: number;
}

/**
 * Character data stored in characters/[name].md.
 * The .md file contains markdown-formatted character description.
 */
export interface CharacterData {
  name: string;
  description: string;
  visualDescription: string;
  /** Approval status for the character description (CHARACTERS_SETTINGS phase) */
  approvalStatus: ItemApprovalStatus;
  /** Approval status for the reference image (CHARACTER_SETTING_IMAGES phase) */
  referenceImageApprovalStatus?: ItemApprovalStatus;
  /** Content artifact ID for the description */
  contentArtifactId?: string;
  /** Reference image artifact ID */
  referenceImageId?: string;
  /** Reference image file path */
  referenceImagePath?: string;
  /** Timestamp when content was approved */
  approvedAt?: number;
  /** Timestamp when reference image was approved */
  referenceImageApprovedAt?: number;
  /** Number of regeneration attempts */
  regenerationCount: number;
  /** Path to the saved image prompt file */
  imagePromptPath?: string;
  /** Approval status for the image prompt */
  imagePromptApprovalStatus?: ItemApprovalStatus;
}

/**
 * Setting data stored in settings/[name].md.
 * The .md file contains markdown-formatted setting description.
 */
export interface SettingData {
  name: string;
  description: string;
  visualDescription: string;
  /** Approval status for the setting description (CHARACTERS_SETTINGS phase) */
  approvalStatus: ItemApprovalStatus;
  /** Approval status for the reference image (CHARACTER_SETTING_IMAGES phase) */
  referenceImageApprovalStatus?: ItemApprovalStatus;
  /** Content artifact ID for the description */
  contentArtifactId?: string;
  /** Reference image artifact ID */
  referenceImageId?: string;
  /** Reference image file path */
  referenceImagePath?: string;
  /** Timestamp when content was approved */
  approvedAt?: number;
  /** Timestamp when reference image was approved */
  referenceImageApprovedAt?: number;
  /** Number of regeneration attempts */
  regenerationCount: number;
  /** Path to the saved image prompt file */
  imagePromptPath?: string;
  /** Approval status for the image prompt */
  imagePromptApprovalStatus?: ItemApprovalStatus;
}

/**
 * Scene reference in project.json index.
 * Full scene content is stored in plans/scenes.md or scenes/*.md files.
 * Tracks approval status separately for content, image, and video phases.
 */
export interface SceneRef {
  /** Scene number/identifier */
  sceneNumber: number;
  /** Reference to scene file (relative to .dhee/) */
  file?: string;
  /** Scene title */
  title?: string;
  /** Scene description summary */
  description?: string;

  // Content approval (SCENES phase)
  /** Approval status for the scene description */
  contentApprovalStatus: ItemApprovalStatus;
  /** Content artifact ID for the description */
  contentArtifactId?: string;
  /** Timestamp when content was approved */
  contentApprovedAt?: number;

  // Image prompt approval (before SCENE_IMAGES generation)
  /** Path to the saved image prompt file */
  imagePromptPath?: string;
  /** Approval status for the image prompt */
  imagePromptApprovalStatus?: ItemApprovalStatus;

  // Image approval (SCENE_IMAGES phase)
  /** Approval status for the scene image */
  imageApprovalStatus: ItemApprovalStatus;
  /** Generated image artifact ID */
  imageArtifactId?: string;
  /** Image generation prompt used */
  imagePrompt?: string;
  /** Timestamp when image was approved */
  imageApprovedAt?: number;

  // Video prompt approval (before VIDEO generation)
  /** Path to the saved video/motion prompt file */
  videoPromptPath?: string;
  /** Approval status for the video prompt */
  videoPromptApprovalStatus?: ItemApprovalStatus;

  // Video approval (VIDEO phase)
  /** Approval status for the scene video */
  videoApprovalStatus: ItemApprovalStatus;
  /** Generated video artifact ID */
  videoArtifactId?: string;
  /** Timestamp when video was approved */
  videoApprovedAt?: number;

  /** Number of regeneration attempts across all phases */
  regenerationCount: number;
  /** Latest feedback from user */
  feedback?: string;
}

/**
 * Asset metadata stored in assets/manifest.json.
 */
export interface AssetInfo {
  id: string;
  type: 'character_ref' | 'setting_ref' | 'scene_image' | 'scene_video' | 'scene_infographic' | 'final_video';
  path: string;
  scene_number?: number;
  version?: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
  /** Executor node ID for redo support (e.g., "character_image:kai") */
  nodeId?: string;
  /**
   * For scene_image entries: which frame this asset represents. Phase-2
   * dual-write into project.json relies on this to populate
   * scenes[].shots[].firstFrame / lastFrame / midFrame.
   */
  frame?: 'first_frame' | 'last_frame' | 'mid_frame';
}

/**
 * Content type supported by the content registry.
 */
export type ContentTypeName =
  | 'plot'
  | 'story'
  | 'characters'
  | 'settings'
  | 'scenes'
  | 'images'
  | 'videos';

/**
 * Status of content availability.
 */
export type ContentStatus = 'available' | 'partial' | 'missing';

/**
 * Content entry in the registry.
 * Tracks what content exists and where to find it.
 */
export interface ContentEntry {
  /** Current status of this content */
  status: ContentStatus;
  /** Path to the main file for this content (relative to .dhee/). Only set when file exists. */
  file?: string;
  /** For itemized content (characters/settings), list of item names */
  items?: string[];
  /** For itemized content, paths to individual item files */
  itemFiles?: Record<string, string>;
}

/**
 * Content Registry - tracks what creative content is available.
 * This is the single source of truth for both readers and writers.
 */
export interface ContentRegistry {
  plot: ContentEntry;
  story: ContentEntry;
  characters: ContentEntry;
  settings: ContentEntry;
  scenes: ContentEntry;
  images: ContentEntry;
  videos: ContentEntry;
}

/**
 * Final video information after stitching.
 */
export interface FinalVideoInfo {
  /** Artifact ID of the final video */
  artifactId: string;
  /** File path to the final video */
  path: string;
  /** Total duration in seconds */
  duration: number;
  /** Creation timestamp */
  createdAt: number;
}

/**
 * Main project file structure (project.json).
 * This is an INDEX file - content lives in .md files, this just tracks references.
 * Version 2.0 - 8-phase workflow with per-item approval.
 */
export interface ProjectFile {
  /** Project version. Source of truth: PROJECT_VERSION constant above. */
  version: '3.0';
  /** Unique project identifier */
  id: string;
  /** Project title */
  title: string;
  /** Path to original input file (relative to .dhee/) */
  originalInputFile: string;
  /** Visual style for the project (cinematic_realism or anime) */
  style: ProjectStyle;
  /** Type of input provided (idea or story) - determines which phases to skip */
  inputType: InputType;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;

  /** Current workflow phase */
  currentPhase: WorkflowPhase | string;

  /** Template ID used to create this project (undefined for legacy narrative projects) */
  templateId?: string;

  /** Phase status tracking - dynamic based on template (narrative has 8 fixed phases, others derived from template) */
  phases: Record<string, PhaseInfo>;

  /** Content registry - tracks what creative content is available */
  content: ContentRegistry;

  /** Character data with approval tracking */
  characters: CharacterData[];
  /** Setting data with approval tracking */
  settings: SettingData[];
  /** Scene references with approval tracking (full data in plans/scenes.md or scenes/*.md) */
  scenes: SceneRef[];
  /** Asset IDs (detailed info in assets/manifest.json) */
  assets: string[];

  /** Final video information (populated after VIDEO_COMBINE phase) */
  finalVideo?: FinalVideoInfo;

  /** Timestamp when production started */
  productionStartedAt?: number;
  /** Timestamp when production completed (final video stitched) */
  productionCompletedAt?: number;
  /** Timestamp of last checkpoint save */
  lastCheckpointAt?: number;

  /** Accumulated active agent time in milliseconds */
  elapsedMs?: number;
  /** Wall-clock ms when current agent run started (set = running, cleared on stop) */
  timerLastStartedAt?: number;

  /** Target video duration in seconds (selected by user at startup) */
  targetDuration?: number;

  /**
   * Whether to use V2V_extend (video-to-video) chaining between shots.
   * Default for new projects: false. With v2v off, every shot renders via
   * FL2V from its own first+last frame, which guarantees all generated
   * keyframes appear in the final assembly (no subsumption) at the cost of
   * continuous camera motion between shots. Image-anchored shot chaining at
   * the IMAGE layer still provides visual continuity even with v2v off.
   */
  useV2V?: boolean;

  /** Legacy/setup mirror of selected duration for UI compatibility */
  duration?: number;

  /** Whether autonomous mode was selected in project setup */
  autonomousMode?: boolean;

  /** Persisted todo list for resuming work */
  todos?: PersistedTodo[];

  /** All inputs for this project (multi-input support) */
  inputs?: ProjectInput[];

  /** Primary narration source configuration */
  primaryNarration?: PrimaryNarrationConfig;

  /**
   * List of files that actually exist in the project.
   * This helps agents understand what content is available without
   * parsing the full phases/content structure.
   */
  files?: Array<{
    /** Type of file (original_input, plot, story, character, setting, scene, image, video) */
    type: string;
    /** Relative path within .dhee directory */
    path: string;
    /** Optional name for items (character name, setting name, scene number) */
    name?: string;
    /** Brief summary of file contents (1-2 sentences) for quick reference */
    summary?: string;
  }>;

  /** Artifact-centric state for fine-grained control - individual artifact tracking with versioning */
  artifacts?: Record<string, ArtifactState>;

  /** Persisted user goal for session resumption */
  goal?: PersistedGoal;

  /**
   * Dependency-graph executor state — the canonical source of truth
   * for what the executor has run and what's left to run. Written by
   * `ExecutorAgent.persistState()` after every public mutation on
   * the underlying `DependencyGraphExecutor`.
   *
   * The legacy flat fields above (`characters[]`, `settings[]`,
   * `scenes[]`, `phases{}`, `content{}`, `files[]`, `artifacts{}`)
   * are scheduled for removal — `executorState.nodes` already
   * encodes everything they hold. Until those PRs land, both
   * representations are written.
   *
   * Typed as `unknown` here to keep this types module independent
   * of the planner; readers narrow via the
   * `src/core/planner/projectView.ts` helpers.
   */
  executorState?: unknown;
}

/**
 * Persisted todo item for project resumption.
 */
export interface PersistedTodo {
  id: string;
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'expanded';
  visible: boolean;
  depth: number;
}

/**
 * Agent type for a phase.
 */
export type AgentType = 'planning' | 'content' | 'image' | 'video';

/**
 * Item processing mode for a phase.
 * Determines how items are iterated in per-item approval phases.
 */
export type ItemProcessMode =
  | 'single' // Single item (plot, story, video_combine)
  | 'list_characters' // Process each character
  | 'list_settings' // Process each setting
  | 'list_scenes' // Process each scene
  | 'list_all_refs' // Process all character + setting refs
  | 'list_scene_images'; // Process each scene for image generation

/**
 * Content type for content agent dispatch.
 */
export type ContentType = 'plot' | 'story' | 'character' | 'setting' | 'scene' | 'narration';

/**
 * Configuration for each workflow phase.
 */
export interface PhaseConfig {
  /** Phase identifier */
  phase: WorkflowPhase;
  /** Human-readable name */
  displayName: string;
  /** Next phase after completion */
  nextPhase: WorkflowPhase | null;
  /** Prompt file name (without .json) for agent */
  promptFile: string;
  /** Path to plan output file (relative to .dhee/) */
  planOutputFile?: string;
  /** Primary agent type for this phase */
  agentType: AgentType;
  /** Tools available in this phase */
  allowedTools: string[];
  /** How items are processed in this phase */
  itemProcessMode: ItemProcessMode;
  /** Whether each item requires individual user approval */
  requiresPerItemApproval: boolean;
  /** Is this an expensive phase (image/video generation)? */
  isExpensive: boolean;
  /** Description of what this phase does */
  description: string;
  /** Content type for content agent (if agentType is 'content') */
  contentType?: ContentType;
}

/**
 * Phase configurations map for 8-phase workflow.
 */
export const PHASE_CONFIGS: Record<WorkflowPhase, PhaseConfig> = {
  [WorkflowPhase.PLOT]: {
    phase: WorkflowPhase.PLOT,
    displayName: 'Plot Development',
    nextPhase: WorkflowPhase.STORY,
    promptFile: 'plot',
    planOutputFile: 'plans/plot.md',
    agentType: 'planning',
    allowedTools: [
      'think',
      'ask_user',
      'read_file',
      'import_file',
      'read_project',
      'update_project',
      'dispatch_agent',
    ],
    itemProcessMode: 'single',
    requiresPerItemApproval: false,
    isExpensive: false,
    description: 'Analyze user input and create plot outline',
  },

  [WorkflowPhase.STORY]: {
    phase: WorkflowPhase.STORY,
    displayName: 'Story Development',
    nextPhase: WorkflowPhase.CHARACTERS_SETTINGS,
    promptFile: 'story',
    planOutputFile: 'plans/story.md',
    agentType: 'content',
    contentType: 'story',
    allowedTools: [
      'think',
      'ask_user',
      'read_file',
      'import_file',
      'read_project',
      'update_project',
      'dispatch_content_agent',
    ],
    itemProcessMode: 'single',
    requiresPerItemApproval: false,
    isExpensive: false,
    description: 'Generate full story from plot (or accept direct story input)',
  },

  [WorkflowPhase.CHARACTERS_SETTINGS]: {
    phase: WorkflowPhase.CHARACTERS_SETTINGS,
    displayName: 'Character & Setting Descriptions',
    nextPhase: WorkflowPhase.SCENES,
    promptFile: 'characters-settings',
    planOutputFile: 'plans/characters-settings.md',
    agentType: 'content',
    allowedTools: [
      'think',
      'ask_user',
      'read_file',
      'import_file',
      'read_project',
      'update_project',
      'dispatch_agent',
      'dispatch_content_agent',
      'todo_write',
    ],
    itemProcessMode: 'list_all_refs',
    requiresPerItemApproval: true,
    isExpensive: false,
    description: 'Plan and create detailed descriptions for each character and setting',
  },

  [WorkflowPhase.SCENES]: {
    phase: WorkflowPhase.SCENES,
    displayName: 'Scene Breakdown',
    nextPhase: WorkflowPhase.CHARACTER_SETTING_IMAGES,
    promptFile: 'scenes',
    planOutputFile: 'plans/scenes-outline.md',
    agentType: 'content',
    contentType: 'scene',
    allowedTools: [
      'think',
      'ask_user',
      'read_file',
      'import_file',
      'read_project',
      'update_project',
      'dispatch_agent',
      'dispatch_content_agent',
      'todo_write',
    ],
    itemProcessMode: 'list_scenes',
    requiresPerItemApproval: true,
    isExpensive: false,
    description: 'Break story into individual visual scenes with descriptions',
  },

  [WorkflowPhase.CHARACTER_SETTING_IMAGES]: {
    phase: WorkflowPhase.CHARACTER_SETTING_IMAGES,
    displayName: 'Reference Image Generation',
    nextPhase: WorkflowPhase.SCENE_IMAGES,
    promptFile: 'character-setting-images',
    planOutputFile: 'plans/ref-images.md',
    agentType: 'image',
    allowedTools: [
      'think',
      'ask_user',
      'read_file',
      'import_file',
      'read_project',
      'update_project',
      'dispatch_image_agent',
      'generate_image',
      'todo_write',
    ],
    itemProcessMode: 'list_all_refs',
    requiresPerItemApproval: true,
    isExpensive: true,
    description: 'Generate reference images for each character and setting (text-to-image)',
  },

  [WorkflowPhase.SCENE_IMAGES]: {
    phase: WorkflowPhase.SCENE_IMAGES,
    displayName: 'Scene Image Generation',
    nextPhase: WorkflowPhase.VIDEO,
    promptFile: 'scene-images',
    planOutputFile: 'plans/scene-images.md',
    agentType: 'image',
    allowedTools: [
      'think',
      'ask_user',
      'read_file',
      'import_file',
      'read_project',
      'update_project',
      'dispatch_image_agent',
      'generate_image',
      'todo_write',
    ],
    itemProcessMode: 'list_scene_images',
    requiresPerItemApproval: true,
    isExpensive: true,
    description: 'Generate scene images using character/setting references (image+text-to-image)',
  },

  [WorkflowPhase.VIDEO]: {
    phase: WorkflowPhase.VIDEO,
    displayName: 'Video Generation',
    nextPhase: WorkflowPhase.VIDEO_COMBINE,
    promptFile: 'video',
    planOutputFile: 'plans/video.md',
    agentType: 'video',
    allowedTools: [
      'think',
      'ask_user',
      'read_file',
      'import_file',
      'read_project',
      'update_project',
      'dispatch_video_agent',
      'generate_video',
      'todo_write',
    ],
    itemProcessMode: 'list_scenes',
    requiresPerItemApproval: true,
    isExpensive: true,
    description: 'Generate video clip for each scene image',
  },

  [WorkflowPhase.VIDEO_COMBINE]: {
    phase: WorkflowPhase.VIDEO_COMBINE,
    displayName: 'Video Stitching',
    nextPhase: WorkflowPhase.COMPLETED,
    promptFile: 'video-combine',
    planOutputFile: 'plans/final-video.md',
    agentType: 'video',
    allowedTools: [
      'think',
      'ask_user',
      'read_file',
      'read_project',
      'update_project',
      'manage_timeline',
      'assemble_from_timeline',
    ],
    itemProcessMode: 'single',
    requiresPerItemApproval: false,
    isExpensive: true,
    description: 'Stitch all scene videos into final video',
  },

  [WorkflowPhase.COMPLETED]: {
    phase: WorkflowPhase.COMPLETED,
    displayName: 'Completed',
    nextPhase: null,
    promptFile: 'completed',
    agentType: 'planning',
    allowedTools: ['think', 'read_file', 'read_project'],
    itemProcessMode: 'single',
    requiresPerItemApproval: false,
    isExpensive: false,
    description: 'Workflow complete - present final video to user',
  },
};

/**
 * Order of phases for iteration (8-phase workflow).
 */
export const PHASE_ORDER: WorkflowPhase[] = [
  WorkflowPhase.PLOT,
  WorkflowPhase.STORY,
  WorkflowPhase.CHARACTERS_SETTINGS,
  WorkflowPhase.SCENES,
  WorkflowPhase.CHARACTER_SETTING_IMAGES,
  WorkflowPhase.SCENE_IMAGES,
  WorkflowPhase.VIDEO,
  WorkflowPhase.VIDEO_COMBINE,
  WorkflowPhase.COMPLETED,
];

/**
 * Project file name within the active project directory.
 */
export const PROJECT_FILE = 'project.json';

/**
 * Auto-approve timeout in milliseconds (15 seconds).
 * If user doesn't respond to ask_user within this time, assume approval.
 */
export const AUTO_APPROVE_TIMEOUT_MS = 15000;

/**
 * State transition rules - determines what phase to go to next.
 */
export interface StateTransitionResult {
  /** Next phase to transition to (WorkflowPhase for narrative, string for template-driven) */
  nextPhase: WorkflowPhase | string;
  /** Reason for the transition */
  reason: string;
  /** Whether this is an automatic transition (no user input needed) */
  isAutomatic: boolean;
}

/**
 * Create a default CharacterData entry. Used by callers that
 * still build flat character objects for legacy serialisation;
 * approval / regeneration tracking has moved to the dependency
 * graph executor's per-item nodes.
 */
export function createDefaultCharacterData(name: string): CharacterData {
  return {
    name,
    description: '',
    visualDescription: '',
    approvalStatus: 'pending',
    regenerationCount: 0,
  };
}

/**
 * Create a default SettingData entry.
 */
export function createDefaultSettingData(name: string): SettingData {
  return {
    name,
    description: '',
    visualDescription: '',
    approvalStatus: 'pending',
    regenerationCount: 0,
  };
}

/**
 * Create a default SceneRef entry.
 */
export function createDefaultSceneRef(sceneNumber: number, title?: string): SceneRef {
  return {
    sceneNumber,
    title,
    contentApprovalStatus: 'pending',
    imageApprovalStatus: 'pending',
    videoApprovalStatus: 'pending',
    regenerationCount: 0,
  };
}

// ============================================================================
// ARTIFACT-CENTRIC STATE (Fine-Grained Control)
// ============================================================================

export type ArtifactType =
  | 'scene'
  | 'character'
  | 'setting'
  | 'image'
  | 'video'
  | 'audio'
  | 'overlay';

export type ArtifactStatus = 'pending' | 'generating' | 'complete' | 'needs_review';

export interface PromptVersion {
  version: number;
  prompt: string;
  feedback?: string;
  createdAt: number;
  approvedAt?: number;
}

export interface ArtifactState {
  id: string;
  type: ArtifactType;
  status: ArtifactStatus;
  prompt: string;
  promptVersion: number;
  promptHistory: PromptVersion[];
  source: 'generated' | 'external';
  assetPath?: string;
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
}

export interface PromptRefinement {
  currentVersion: number;
  proposedVersion: number;
  proposedPrompt: string;
  changes: string[];
  explanation: string;
}

export interface PromptComparison {
  versionA: PromptVersion;
  versionB: PromptVersion;
  diff: string;
}
