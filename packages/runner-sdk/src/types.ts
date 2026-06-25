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
  /**
   * VRAM safety budget, expressed as a maximum (frames × pixels)
   * product for one chunk's latent. `limit` is the model's audio-latent
   * frame cap (resolution-independent); this is the GPU memory cap
   * (resolution-DEPENDENT, since the sampled latent volume grows with
   * width×height). When set, the walker scales the per-chunk frame cap
   * down at higher resolutions so the chunk still fits in VRAM:
   * `min(limit, floor(maxFramePixels / renderArea))`. Measured at the
   * proven baseline (e.g. 1000 × 854 × 480 = 409,920,000). Absent →
   * only `limit` applies (legacy). See src/dag/chunkBudget.ts.
   */
  maxFramePixels?: number;
  /**
   * Total GPU VRAM (bytes) the `maxFramePixels` budget was measured on.
   * At walk time the walker probes the actual GPU's VRAM (Comfy
   * /system_stats) and scales the budget by `actualVram / referenceVram`,
   * so a budget tuned on a 12 GiB card automatically grows on a 24 GiB
   * card (longer chunks) and shrinks on an 8 GiB card. Defaults to 12 GiB
   * when absent. Only meaningful alongside `maxFramePixels`.
   */
  referenceVramBytes?: number;
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

  /**
   * Human-facing label for this stage, shown in the desktop's Production
   * View (layer bar, section headers, stage rail) and run cockpit. Lets a
   * bundle present "Shots" / "Shot Prompts" / "Final Cut" instead of the
   * raw node id. Falls back to a humanized node id when omitted.
   */
  displayName?: string;
}

export interface BundleDependencies {
  /**
   * Required runners, keyed by tool name, valued by a semver range.
   * The walker validates against the RunnerRegistry before running the
   * bundle — declared runners must be registered AND their installed
   * version must satisfy the declared range.
   */
  runners?: Record<string, string>;
  /**
   * Optional install hint: maps a required runner TOOL id (a key in
   * `runners`) to the npm PACKAGE that provides it, optionally pinned
   * (`"dhee-runner-runway"` or `"dhee-runner-runway@^1.2.0"`). Lets the
   * requirements check tell the user exactly what to install for a
   * missing runner (`npm i <package>`) instead of just naming the tool.
   *
   * Two ways to satisfy a missing runner (complementary):
   *   1. Ship the bundle as an npm package and list the runner package
   *      in its package.json `dependencies` / `peerDependencies` — then
   *      `npm i <bundle-pkg>` pulls the runner and discovery registers it.
   *   2. Declare it here so checkBundleRunners() can surface the install
   *      command during bundle discovery (works for built-in / local
   *      bundles that aren't themselves npm packages).
   * When a tool is missing and unmapped, the checker falls back to the
   * `dhee-runner-<namespace>` naming convention as a best-effort guess.
   */
  runnerPackages?: Record<string, string>;
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
 *
 * Presentation fields (`label`, `control`, `options`, `unit`,
 * `placeholder`, `multiline`, `allowCustom`) are consumed by the
 * desktop's New Project flow to render the right form control. They
 * have no runtime semantics — the walker ignores them, and
 * `applyBundleInputs` writes whatever value the form supplied (preset
 * OR custom) straight to `project.<field>` with no option whitelist.
 */
export interface BundleInputOption {
  value: string | number | boolean;
  label: string;
}

export type BundleInputControl = 'textarea' | 'text' | 'pills' | 'select' | 'number';

export type BundleInputDecl =
  | {
      id: string;
      kind: 'file';
      path: string;
      required?: boolean;
      label?: string;
      placeholder?: string;
      multiline?: boolean;
    }
  | {
      id: string;
      kind: 'project';
      field: string;
      default?: unknown;
      required?: boolean;
      label?: string;
      control?: BundleInputControl;
      options?: BundleInputOption[];
      /**
       * When true, the desktop renders an "Other…" affordance alongside
       * the preset `options` (a free text box for `select`/`text`, a
       * number box for `pills`/`number`) so the user can supply a value
       * outside the presets. The custom value is written to
       * `project.<field>` verbatim — e.g. a free-form style phrase that
       * flows into `world_style` via `{{style}}`, an arbitrary duration
       * in seconds, or a non-listed resolution. No effect without
       * `options`/a select-or-pills control.
       */
      allowCustom?: boolean;
      unit?: string;
      placeholder?: string;
    };

export interface DagBundle {
  id: string;
  version: string;
  /**
   * SPDX license identifier for THIS bundle (e.g. "MIT", "Apache-2.0",
   * "CC-BY-4.0", or "LicenseRef-Proprietary" for closed bundles).
   *
   * Bundles are runtime data + runner manifests loaded by the engine
   * through the Apache-2.0 `@dheeai/runner-sdk` boundary; they are NOT
   * derivative works of the AGPL-3.0 engine and carry their own license
   * (see BUNDLE_LICENSING.md). Bundle authors may choose any license,
   * including proprietary. First-party bundles are MIT.
   *
   * Optional for back-compat (legacy bundles validate without it), but
   * the marketplace requires a declared license on submission.
   */
  license?: string;
  /**
   * Human-readable display name for the bundle (e.g. "Narrative Prompt
   * Relay"). Shown in bundle picker cards + project tiles. When omitted,
   * the desktop falls back to `titleizeBundleId(id)` (snake_case → Title
   * Case). Set explicitly when the auto-fallback doesn't give you what
   * you want (e.g. "LTX Director Chain" instead of "Ltx Director Chain").
   */
  displayName?: string;
  /**
   * Short marketing-style summary (one sentence, ≤120 chars) for the
   * bundle picker card. `description` below is the long-form prose;
   * `summary` is the tagline. When omitted, the desktop derives it from
   * the first sentence of `description`.
   */
  summary?: string;
  /**
   * Optional technical spec line — small uppercase mono caption on the
   * bundle picker card (e.g. "LTX-2 RELAY · DIRECTOR CHAIN"). Lets the
   * user see what's under the hood without explaining it in prose.
   */
  techLine?: string;
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
  /**
   * Maximum TOTAL walks per dispatch when review nodes (or other
   * runners) stamp pendingCritiques. The walker checks at the end of
   * each walk: if pendingCritiques is non-empty AND walks-so-far <
   * max, invalidate those entries and re-walk.
   *
   * Semantics:
   *   - `0` or `1` → no auto-rewalk; single-shot behavior preserved.
   *     Existing dhee_critique_node flow (stamp + dispatch single
   *     walk) is unchanged.
   *   - `3` → up to 3 total walks. e.g. attempt 1 fails review →
   *     re-walk #2 → attempt 2 still fails → re-walk #3 → walker
   *     exits regardless of verdict (cap reached).
   *
   * Recommended 2–3 for bundles with judge nodes; higher risks
   * spending budget on stubborn shots that won't converge.
   */
  reviewLoopMax?: number;
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
  /**
   * Optional declared requirements for the bundle's ComfyUI workflows:
   * the model files and custom-node packs they need, with human
   * curation (download URLs, sizes, install hints) that can't be
   * inferred from the workflow JSON alone. Drives the desktop Bundle
   * Configurator's "Download ↗ / Install ↗" affordances — a bare
   * missing-filename becomes "FLUX dev (24 GB) ↗".
   *
   * Optional: gap DETECTION (checkBundle) works without it; this only
   * upgrades a detected gap into an actionable remediation hint. Can
   * be auto-stubbed from the workflows via scripts/gen-bundle-
   * requirements.ts, then curated.
   */
  requirements?: BundleRequirements;
}

/**
 * Declared model + custom-node requirements for a bundle's workflows.
 * See deriveBundleRequirements() for the auto-stub generator.
 */
export interface BundleRequirements {
  /** Custom-node packs the workflows reference (non-core ComfyUI classes). */
  customNodes?: RequiredCustomNode[];
  /** Model files the workflows reference. */
  models?: RequiredModel[];
}

export interface RequiredCustomNode {
  /** ComfyUI node class_type (the key that must exist in /object_info). */
  classType: string;
  /** Human name of the node pack that provides this class. */
  pack?: string;
  /** Preferred install route. */
  installVia?: 'manager' | 'git';
  /** Git URL when installVia === 'git' (or for reference). */
  gitUrl?: string;
  /** Free-text hint shown to the user. */
  note?: string;
}

export interface RequiredModel {
  /** `<LoaderClass>.<field>` the model plugs into, e.g. "UNETLoader.unet_name". */
  classField: string;
  /** Canonical filename the bundle's workflow references. */
  canonicalFilename: string;
  /** Coarse model kind, inferred from the loader field (unet/vae/clip/lora/checkpoint/…). */
  type?: string;
  /** Where to download it (HuggingFace / source). */
  downloadUrl?: string;
  /** Approx download size in GB (for the user's "this'll take a while" expectation). */
  sizeGb?: number;
  /** When true, the workflow still runs without it (e.g. an optional upscaler). */
  optional?: boolean;
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
// LLM access capability
// ---------------------------------------------------------------------------

export type LLMAccessTier = 'heavy' | 'medium' | 'light';
export type LLMAccessMessageRole = 'system' | 'user' | 'assistant';

export interface LLMAccessMessage {
  role: LLMAccessMessageRole;
  content: string;
}

export interface LLMGenerateTextOptions {
  messages: LLMAccessMessage[];
  tier?: LLMAccessTier;
  purpose?: string;
  signal?: AbortSignal;
  responseFormat?: { type: 'json_object' };
  temperature?: number;
  maxTokens?: number;
}

export interface LLMGenerateTextResult {
  content?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Capability object the walker injects as `ctx.llm`. Lets a runner —
 * especially a third-party / SDK-only runner that must NOT import core
 * providers directly — call the routed LLM without reaching into
 * kshana-core internals.
 */
export interface LLMAccess {
  generateText(opts: LLMGenerateTextOptions): Promise<LLMGenerateTextResult>;
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
  /**
   * LLM access capability, injected by the walker. Runners that need an
   * LLM call `ctx.llm.generateText(...)` instead of importing a provider
   * — required for SDK-only / sandboxed third-party runners. Optional:
   * legacy callers / tests may omit it.
   */
  llm?: LLMAccess;
}

/** A produced artifact, when a runner emits more than the primary output. */
export interface RunnerArtifact {
  path: string;
  kind?: 'file' | 'text' | 'json' | 'image' | 'video' | 'audio';
  metadata?: Record<string, unknown>;
}

export type RunnerResult =
  | {
      ok: true;
      outputPath: string;
      /** Additional artifacts beyond the primary outputPath (optional). */
      outputs?: RunnerArtifact[];
      metadata?: Record<string, unknown>;
    }
  | { ok: false; error: string };

/** A runner is a TypeScript module exporting these two things. */
export interface Runner {
  describe: () => RunnerDescription;
  run: (ctx: RunnerContext) => Promise<RunnerResult>;
}

// ---------------------------------------------------------------------------
// Runner manifest (registration record) + permissions
// ---------------------------------------------------------------------------

/**
 * Declared capability surface a runner needs. Currently DECLARATIVE —
 * surfaced in requirements/checks (e.g. checkBundleRunners); runtime
 * sandbox enforcement (network/fs) is future work. The boundary that IS
 * enforced today is structural: a published runner depends only on
 * `@dheeai/runner-sdk`, never on kshana-core internals (runner-sdk firewall test).
 */
export interface RunnerPermissions {
  /** Hostnames the runner may reach (e.g. ['openrouter.ai']). */
  network?: string[];
  /** Filesystem scope. */
  filesystem?: 'project' | 'none' | 'temp';
  /** Whether the runner spawns subprocesses. */
  subprocess?: boolean;
  /** Env vars the runner reads. */
  env?: string[];
}

/**
 * Registration record for a runner tool. Built-in runners declare these
 * inline; external runners ship them as `runner.json` (sideloaded via
 * discoverRunners) or via the `dhee.runners` npm entry point (see
 * docs/ecosystem-package-conventions.md). The registry validates a
 * bundle's declared runner dependencies against these before the walk.
 */
export interface RunnerManifest {
  /** Unique tool id, dot-namespaced (e.g. 'llm.generate', 'openrouter.image'). */
  tool: string;
  /** Semver version of the runner. */
  version: string;
  /** Semver range of engine versions this runner is compatible with. */
  engineCompat: string;
  /** Env var names the runner requires; bundles using it fail validation if unset. */
  credentials: string[];
  displayName?: string;
  description?: string;
  /** Entry module for sideloaded/external runners, relative to the package. */
  entry?: string;
  /** Declared capability surface (see RunnerPermissions). */
  permissions?: RunnerPermissions;
}
