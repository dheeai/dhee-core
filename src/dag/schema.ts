/**
 * DAG Bundle Schema — minimal v1.
 *
 * A bundle is a dependency graph of nodes, each of which declares its
 * inputs and which runner produces its output. The walker backward-walks
 * from a goal node and runs nodes in dependency order.
 *
 * See docs/dag-bundles-sketch.md for the full design.
 *
 * v1 scope: enough to express the LTX prompt-relay flow against existing
 * project artifacts. Not yet: collection materialization at runtime,
 * redo isolation, abort recovery, runner-swap agent verb. These belong
 * to v2/v3 when the bundle layer eventually replaces DependencyGraphExecutor.
 */

export type NodeKind = 'stage' | 'collection';

export type InputUsage = 'context' | 'reference' | 'input' | 'aggregate';

export type InputScope = 'all' | 'matching' | 'any' | 'previousN';

export interface AggregateConfig {
  /** How upstream items are packed into this node's call. */
  strategy: 'list' | 'join';
  /** Separator for `join` strategy. */
  sep?: string;
  /** Maximum items to include. Omit for "no cap, take all available". */
  limit?: number;
}

export interface NodeInput {
  /** Upstream node id. */
  from: string;
  /** How this dependency is used by the downstream node. */
  usage: InputUsage;
  /** For collection sources: which items to pull. Defaults to 'all'. */
  scope?: InputScope;
  /**
   * For scope='previousN': how many prior instances to include.
   * The walker collects up to N upstream instances whose shotNumber is
   * strictly less than the current instance's shotNumber, sorted by
   * shotNumber DESC and truncated to N. Exposed as an array of
   * { shotNumber, outputAbs, ... } to the runner. Used by Qwen-chain
   * bundles where the LLM picks the best prior shot to use as the
   * edit base.
   */
  n?: number;
  /** For 'aggregate' usage: how N upstream items become one call. */
  aggregate?: AggregateConfig;
}

export interface NodeOutput {
  format: 'md' | 'json' | 'image' | 'video' | 'audio' | 'text';
  /** File pattern relative to the project dir. Supports {{scene_id}}, {{shot_id}}, {{id}}. */
  pattern: string;
}

/**
 * Chunking strategy — when a collection's natural unit (e.g. a scene's
 * full shot list) exceeds the runner's hard constraint, the walker
 * subdivides it into smaller per-chunk instances. The chunking decision
 * is the bundle's responsibility, not the runner's — this is what
 * makes "swap to a runner with a different cap" a config change rather
 * than a code change.
 */
export interface ChunkBy {
  /** What we're chunking against. */
  constraint: 'max_frames';
  /** The runner's hard cap on the constrained dimension. */
  limit: number;
  /** Frames-per-second basis for frame-count chunking. */
  fps?: number;
  /**
   * For each chunk, the first segment in LTX-style relay workflows is
   * +1 frame after 8-frame alignment. Set true for ltx_director-style
   * runners so chunk sizing accounts for the offset. Defaults false.
   */
  firstSegmentPlusOne?: boolean;
}

export interface NodeDef {
  /** Unique node id within the bundle (e.g. 'scene_clip', 'final_video'). */
  id: string;
  kind: NodeKind;
  /** For collections: upstream id whose items we fan out over. */
  itemSource?: string;
  /**
   * For collections sourced from an upstream that emits a JSON object
   * with multiple arrays (e.g. scenes_plan emits both `scenes` and
   * `shots`): which key to fan out over. Without this, the walker
   * picks the first array property — which is ambiguous when more
   * than one array exists. Set to e.g. 'shots' or 'characters'.
   */
  itemKey?: string;
  /**
   * For collections that may need to subdivide their items to fit
   * runner constraints. The walker calls a chunker matching this spec
   * during materialization and produces one node instance per chunk.
   */
  chunkBy?: ChunkBy;
  inputs: NodeInput[];
  outputs: NodeOutput;
  runner: {
    /** Runner tool name (e.g. 'comfy.ltx_director', 'ffmpeg.concat'). */
    tool: string;
    /** Tool-specific config. Validated against runner's input JSON Schema. */
    config: Record<string, unknown>;
  };
  /**
   * For `outputs.format: 'json'` nodes: dot-path into the produced JSON
   * naming the headline field — the primary text the desktop's Inspector
   * Canvas shows on the card or tile. Examples:
   *   - 'deltaText'                          (narrative_qwen_chain_relay shot prompts)
   *   - 'frames.first_frame.imagePrompt'     (narrative_prompt_relay shot prompts)
   *   - 'name'                               (characters_plan / settings_plan items)
   *
   * Renderer falls back to a generic key/value tree when absent or when
   * the path doesn't resolve. Ignored for non-json kinds.
   */
  headlineField?: string;
  /**
   * Optional display capability tag — the contract between a bundle's
   * artifacts and the desktop's views. The desktop discovers what to
   * render by *capability*, not by node id, so bundles can use any
   * internal node naming and any output path layout without the desktop
   * needing per-bundle code.
   *
   * Reserved kshana-core capabilities (see docs/display-capabilities.md):
   *   - 'shot.prompt'         per-shot image-generation prompt JSON
   *   - 'shot.motion'         per-shot motion / video prompt JSON
   *   - 'shot.first_frame'    per-shot first-frame image PNG
   *   - 'shot.last_frame'     per-shot last-frame image PNG
   *   - 'shot.video'          per-shot video clip MP4
   *   - 'scene.video'         per-scene relay clip MP4
   *   - 'scene.plan'          scene plan (scenes + shots arrays) JSON
   *   - 'character.image'     character reference PNG
   *   - 'character.prompt'    character image prompt JSON
   *   - 'setting.image'       setting reference PNG
   *   - 'setting.prompt'      setting image prompt JSON
   *   - 'final.video'         final assembled video MP4
   *
   * Custom capabilities (anything outside the reserved set) are allowed
   * — desktop views without a handler for that capability simply ignore
   * those nodes. Convention: use `<domain>.<artifact>` dotted form.
   *
   * Bundles that omit `displayCapability` fall back to legacy node-id
   * heuristics in the desktop (best-effort; not guaranteed).
   */
  displayCapability?: string;
}

export interface BundleDependencies {
  /**
   * Required runners, keyed by tool name, valued by a semver range.
   * The walker validates against the RunnerRegistry before running the
   * bundle — declared runners must be registered AND their installed
   * version must satisfy the declared range.
   */
  runners?: Record<string, string>;
}

/**
 * Bundle-level input declaration — values made available to every
 * node's ctx.inputs from outside the DAG. Typically the user-supplied
 * story text, the project's target duration, the style preset, etc.
 *
 * `kind: 'file'` — read the file at `path` (relative to projectDir).
 *                  Content is the resolved value (string for .md, parsed
 *                  for .json).
 * `kind: 'project'` — read a field from project.json. `field` is a
 *                  dot-path (e.g. 'targetDuration', 'goal.targetDuration').
 */
export type BundleInputDecl =
  | { id: string; kind: 'file'; path: string; required?: boolean }
  | { id: string; kind: 'project'; field: string; default?: unknown; required?: boolean };

export interface DagBundle {
  id: string;
  version: string;
  description?: string;
  /**
   * Range of kshana engine versions this bundle is known to work
   * against (semver range). Future-facing — the engine doesn't enforce
   * this yet in v1, but bundle authors should declare it so future
   * cutovers (e.g. when the engine moves to v2) can warn or refuse.
   */
  engineCompat?: string;
  /** Required runners (and their version ranges). See BundleDependencies. */
  dependencies?: BundleDependencies;
  /**
   * Bundle-level inputs (e.g. user story text, project metadata).
   * Resolved once at walk start, available to every node via ctx.inputs.
   */
  inputs?: BundleInputDecl[];
  /** Terminal node — what the walker tries to produce. */
  goal: string;
  nodes: NodeDef[];
  /**
   * Optional UI metadata so the desktop's project list / tiles / detail
   * panels can render this bundle's outputs without hardcoding paths or
   * node ids. Bundle authors describe what to use as a thumbnail and
   * what numbers to summarize in the tile; the desktop just consumes.
   *
   * Without this block, the desktop falls back to a generic
   * folder-icon thumbnail + an empty stats line. So legacy bundles
   * still display — they just don't get the rich tile treatment.
   *
   * See docs/display-capabilities.md for the full reserved capability
   * registry; the `from` / `source` fields here reference those.
   */
  display?: BundleDisplay;
}

/**
 * Bundle-author-declared display metadata. Drives the project tile on
 * the desktop's landing screen — thumbnail + summary stats.
 */
export interface BundleDisplay {
  /**
   * Source for the project tile's thumbnail image. The desktop finds
   * a completed instance of a node with this capability tag and uses
   * its outputPath as the image.
   *
   * Capability needs to produce an image-format artifact (png/jpg/
   * webp). Bundles that produce only text/audio should omit this and
   * the tile falls back to a generic icon.
   */
  thumbnail?: {
    from: string;
    /**
     * Which completed instance to pick when multiple match. Default
     * 'first_completed' (lowest scene/shot id in lex order). Use
     * 'random_completed' for galleries that should feel alive on
     * each landing-screen visit. 'latest_completed' = most recently
     * walker-recorded; useful for "what just finished?" feel.
     */
    pick?: 'first_completed' | 'random_completed' | 'latest_completed';
  };
  /**
   * Inline numbers to summarize in the tile (e.g. "3 scenes · 31 shots"
   * for narrative; "12 tracks · 47 min" for a music project).
   *
   * Each entry is either:
   *  - count of completed collection instances tagged with `source`
   *    (`count_completed: true`)
   *  - a number / array.length extracted via dot-path from the JSON
   *    file at the `source` capability's outputPath (`path: "..."`).
   *
   * Stats with no matching capability or unreadable source are
   * silently skipped — the tile shows whatever's available.
   */
  stats?: Array<{
    /** Display label (e.g. "scenes", "shots", "tracks", "min", "panels"). */
    label: string;
    /** Capability whose node(s) to inspect. */
    source: string;
    /**
     * Count completed collection instances of `source`. Mutually
     * exclusive with `path`.
     */
    count_completed?: boolean;
    /**
     * Dot-path into the source node's output JSON. Examples:
     *   - "scenes.length" — length of an array property
     *   - "totalDuration" — top-level scalar
     *   - "metadata.wordCount" — nested scalar
     * Mutually exclusive with `count_completed`.
     */
    path?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Runner self-description
// ---------------------------------------------------------------------------

export interface RunnerDescription {
  id: string;
  displayName: string;
  description: string;
  capabilities: string[];
  modalities: {
    input: Array<'text' | 'image' | 'video' | 'audio'>;
    output: Array<'text' | 'image' | 'video' | 'audio'>;
  };
  /** Pseudo-JSON-Schema for the runner's config block. */
  configSchema: Record<string, unknown>;
  costHint?: 'free' | 'paid_api' | 'local_gpu' | 'cloud_gpu';
}

// ---------------------------------------------------------------------------
// Runner invocation
// ---------------------------------------------------------------------------

/** What a node's runner sees at invocation time. */
export interface RunnerContext {
  /** Absolute project directory. */
  projectDir: string;
  /**
   * Absolute path to the bundle directory the runner was dispatched from.
   * Runners that load files declared in their config by path (prompt
   * templates, output schemas, Comfy workflows) resolve them against
   * this dir. Optional for back-compat with legacy callers that
   * pre-resolve all paths into config; new runners require it and
   * fail loudly when absent.
   */
  bundleDir?: string;
  /** The node being executed. */
  node: NodeDef;
  /** For collection items: the specific item id (e.g. 'scene_1'). */
  itemId?: string;
  /**
   * Resolved input values. For each input, the runner gets back what the
   * walker pulled from upstream — file paths, parsed JSON, aggregated lists.
   */
  inputs: Record<string, unknown>;
  /**
   * Cooperative cancellation signal. Walker passes its own AbortSignal
   * through; runners thread it to network calls / subprocess spawns so
   * the chain cancels cleanly. Optional — runners must tolerate its
   * absence (legacy tests, CLI smoke).
   */
  signal?: AbortSignal;
  /** Log function (writes to CLI + project log file). */
  log: (msg: string) => void;
}

export type RunnerResult =
  | { ok: true; outputPath: string; metadata?: Record<string, unknown> }
  | { ok: false; error: string };

/** A runner is a TypeScript module exporting these two things. */
export interface Runner {
  describe: () => RunnerDescription;
  run: (ctx: RunnerContext) => Promise<RunnerResult>;
}
