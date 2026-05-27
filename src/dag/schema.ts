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

export type InputScope = 'all' | 'matching' | 'any';

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
  /** Terminal node — what the walker tries to produce. */
  goal: string;
  nodes: NodeDef[];
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
  /** The node being executed. */
  node: NodeDef;
  /** For collection items: the specific item id (e.g. 'scene_1'). */
  itemId?: string;
  /**
   * Resolved input values. For each input, the runner gets back what the
   * walker pulled from upstream — file paths, parsed JSON, aggregated lists.
   */
  inputs: Record<string, unknown>;
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
