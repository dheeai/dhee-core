/**
 * WorkflowModeRegistry — discovers and serves workflow modes for both
 * video generation and image processing pipelines.
 *
 * Scans `workflows/` for `*.manifest.json` sidecar files, aggregates them,
 * and generates dynamic prompt sections for LLM injection.
 *
 * For API providers (Google, xAI), returns hardcoded modes since their
 * capabilities are fixed.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { finddheeCoreRoot } from '../../agent/pi/paths.js';
import { getUserWorkflowsDir, markRegistryInitialized } from './workflowsRoot.js';
import type { WorkflowManifest, WorkflowManifestFile, WorkflowPipeline } from './types.js';

/** Directories to scan for manifest files.
 *
 * We always scan BOTH `workflows/built-in/` and `workflows/cloud/`,
 * regardless of `process.env.COMFY_MODE`. Per-manifest filtering by
 * mode happens in `refresh()` using the manifest's `mode` field
 * (inferred from directory when unset).
 *
 * Why "always both" rather than mode-gating the scan:
 *   The desktop sets `COMFY_MODE=cloud` AFTER dhee-core is imported.
 *   The registry singleton is constructed lazily on first lookup;
 *   between the two events, calls into the registry would see only
 *   `workflows/built-in/` and never find cloud workflows. Even with
 *   explicit `refresh()` calls scattered through the providers,
 *   timing bugs around env-var flips kept resurfacing. Scanning both
 *   directories every time and selecting via the existing
 *   per-manifest `mode` filter eliminates the directory/env race
 *   entirely.
 *
 * Computed fresh on every refresh() — NOT at module load. Built-in
 * manifests in `workflows/built-in/` ship with `"mode": "local"` (or
 * unset → inferred local). Cloud manifests in `workflows/cloud/`
 * default to `mode: 'cloud'` when their JSON doesn't set the field.
 */
function workflowDirs(): string[] {
  return [
    'workflows/built-in',
    'workflows/cloud',
    'workflows/user',
    'workflows',
  ];
}

/**
 * Infer the mode a manifest applies to when its `mode` field is unset.
 * Built-in directory → 'local'; cloud directory → 'cloud'; everywhere
 * else (user uploads, root) → 'both' so user workflows light up in
 * any environment.
 */
function inferManifestMode(absDir: string): 'local' | 'cloud' | 'both' {
  if (absDir.endsWith('/workflows/cloud') || absDir.endsWith('\\workflows\\cloud')) {
    return 'cloud';
  }
  if (absDir.endsWith('/workflows/built-in') || absDir.endsWith('\\workflows\\built-in')) {
    return 'local';
  }
  // User uploads (workflows/user/, dhee-desktop's userData/...) and
  // anything else: default to 'local'. Reason: user manifests reference
  // custom nodes / model files only present on the user's own ComfyUI
  // install — they can't run on cloud ComfyUI. saveWorkflow() forces
  // mode=local explicitly; this is the second line of defense for any
  // legacy manifest persisted before that lock was in place.
  return 'local';
}

/** Valid pipeline values for manifest validation */
const VALID_PIPELINES: Set<string> = new Set([
  'image_generation', 'image_editing', 'image_processing', 'video_generation',
]);

/** Valid input source values */
const VALID_SOURCES: Set<string> = new Set([
  'shot_image', 'shot_video', 'shot_motion_directive', 'image_processing', 'llm', 'user', 'system',
]);

/**
 * Hardcoded modes for API providers that don't use ComfyUI workflows.
 * These are static — API providers have fixed capabilities.
 * IDs are prefixed with provider name to avoid collisions.
 */
const API_PROVIDER_MODES: Record<string, WorkflowManifest[]> = {
  google: [
    {
      id: 'google_i2v',
      displayName: 'Image to Video (Google API)',
      pipeline: 'video_generation',
      llmDescription: 'Generates video from a single first-frame image using the Google cloud API. High quality but limited control.',
      selectionCriteria: 'Use for any shot that has a character or setting reference image.',
      outputType: 'video',
      priority: 10,
      inputRequirements: [
        { id: 'first_frame', type: 'image', source: 'shot_image', description: 'First frame image', required: true },
        { id: 'prompt', type: 'text', source: 'shot_motion_directive', description: 'Motion prompt', required: true },
      ],
      workflowFile: '',
      format: 'api',
      parameterMappings: [],
      builtIn: true,
      active: true,
    },
  ],
  xai: [
    {
      id: 'xai_i2v',
      displayName: 'Image to Video (xAI API)',
      pipeline: 'video_generation',
      llmDescription: 'Generates video from a single first-frame image using the xAI cloud API.',
      selectionCriteria: 'Use for any shot that has a character or setting reference image.',
      outputType: 'video',
      priority: 10,
      inputRequirements: [
        { id: 'first_frame', type: 'image', source: 'shot_image', description: 'First frame image', required: true },
        { id: 'prompt', type: 'text', source: 'shot_motion_directive', description: 'Motion prompt', required: true },
      ],
      workflowFile: '',
      format: 'api',
      parameterMappings: [],
      builtIn: true,
      active: true,
    },
  ],
};

/**
 * Validate a manifest has all required fields with valid values.
 * Returns null if valid, error message string if invalid.
 */
function validateManifest(m: WorkflowManifest, sourceFile: string): string | null {
  if (!m.id || typeof m.id !== 'string') {
    return `${sourceFile}: missing or invalid 'id'`;
  }
  if (!m.pipeline || !VALID_PIPELINES.has(m.pipeline)) {
    return `${sourceFile}: invalid 'pipeline' value '${m.pipeline}' (must be one of: ${[...VALID_PIPELINES].join(', ')})`;
  }
  if (!m.displayName || typeof m.displayName !== 'string') {
    return `${sourceFile}: missing 'displayName'`;
  }
  if (!m.outputType || (m.outputType !== 'image' && m.outputType !== 'video')) {
    return `${sourceFile}: invalid 'outputType' (must be 'image' or 'video')`;
  }
  if (!Array.isArray(m.inputRequirements)) {
    return `${sourceFile}: missing 'inputRequirements' array`;
  }
  for (const req of m.inputRequirements) {
    if (!req.id || !req.type || !req.source) {
      return `${sourceFile}: inputRequirement missing 'id', 'type', or 'source'`;
    }
    if (!VALID_SOURCES.has(req.source)) {
      return `${sourceFile}: inputRequirement '${req.id}' has invalid source '${req.source}'`;
    }
  }
  if (!Array.isArray(m.parameterMappings)) {
    return `${sourceFile}: missing 'parameterMappings' array`;
  }
  return null;
}

/** Separate map for manifest directory paths — avoids (manifest as any) casts */
const manifestDirMap = new Map<string, string>();

export class WorkflowModeRegistry {
  private modes = new Map<string, WorkflowManifest>();
  private projectRoot: string;

  constructor(projectRoot?: string) {
    // process.cwd() is wrong in the embedded desktop path (cwd is the
    // desktop's repo, which has no `workflows/` directory). Resolve
    // the dhee-core package root explicitly so the workflow scan
    // finds the manifests that ship with dhee-core regardless of
    // who's hosting it. Fall back to cwd if the package root can't
    // be found (shouldn't happen — but better than throwing here).
    if (projectRoot) {
      this.projectRoot = projectRoot;
    } else {
      try {
        this.projectRoot = finddheeCoreRoot(import.meta.url);
      } catch {
        this.projectRoot = process.cwd();
      }
    }
  }

  /**
   * Scan workflow directories for *.manifest.json files and load all modes.
   * Validates each manifest before loading. Also loads hardcoded API provider modes.
   */
  refresh(): void {
    this.modes.clear();
    manifestDirMap.clear();

    const isCloudMode = process.env['COMFY_MODE'] === 'cloud';

    // Build the scan list: dhee-core's built-in/cloud subdirs (always),
    // plus user uploads. When a host (dhee-desktop) has set a user
    // workflows directory via setUserWorkflowsDir(), we use *that*
    // for user workflows and skip dhee-core's `workflows/user/` —
    // otherwise dev-machine workflows under the dhee-core checkout
    // would leak into a packaged-app user's view. CLI / dev runs
    // fall back to the dhee-core-relative paths.
    const hostUserDir = getUserWorkflowsDir();
    const scanDirs: string[] = [];
    for (const d of workflowDirs()) {
      // Skip the dhee-core-relative user dir if the host has set its own.
      if (hostUserDir && (d === 'workflows/user' || d === 'workflows')) continue;
      scanDirs.push(join(this.projectRoot, d));
    }
    if (hostUserDir) scanDirs.push(hostUserDir);

    // Scan filesystem for ComfyUI workflow manifests
    for (const absDir of scanDirs) {
      if (!existsSync(absDir)) continue;
      try {
        const files = readdirSync(absDir);
        for (const file of files) {
          if (!file.endsWith('.manifest.json')) continue;
          try {
            const content = readFileSync(join(absDir, file), 'utf-8');
            const parsed: WorkflowManifestFile = JSON.parse(content);
            const manifests = Array.isArray(parsed) ? parsed : [parsed];

            for (const manifest of manifests) {
              // Validate manifest schema
              const validationError = validateManifest(manifest, file);
              if (validationError) {
                console.warn(`[WorkflowModeRegistry] INVALID MANIFEST: ${validationError}`);
                continue;
              }

              // Resolve workflow file path relative to manifest directory
              if (manifest.workflowFile && !manifest.workflowFile.startsWith('/')) {
                const workflowAbsPath = join(absDir, manifest.workflowFile);
                if (!existsSync(workflowAbsPath)) {
                  console.warn(`[WorkflowModeRegistry] Workflow file not found: ${workflowAbsPath} (from ${file})`);
                  continue;
                }
              }
              // Store the directory for later workflow path resolution
              manifestDirMap.set(manifest.id, absDir);
              // Tag built-in vs user — only manifests living under the
              // built-in / cloud subdirs of projectRoot count as built-in.
              // Host-supplied user dirs always yield user manifests.
              manifest.builtIn =
                absDir.includes('built-in') || absDir.includes('cloud');
              manifest.active = manifest.active !== false; // default active
              // Filter by mode: "local", "cloud", or "both" (default).
              // When the manifest doesn't declare a mode, infer it from
              // the source directory: cloud manifests default to 'cloud',
              // built-in to 'local', user uploads to 'both'.
              const manifestMode = manifest.mode || inferManifestMode(absDir);
              const currentMode = isCloudMode ? 'cloud' : 'local';
              if (manifestMode !== 'both' && manifestMode !== currentMode) {
                continue; // Skip manifests that don't match current mode
              }
              this.modes.set(manifest.id, manifest);
            }
          } catch (err) {
            console.warn(`[WorkflowModeRegistry] Failed to parse ${file}: ${err}`);
          }
        }
      } catch { /* directory not readable */ }
    }

    // Load API provider modes
    for (const [, modes] of Object.entries(API_PROVIDER_MODES)) {
      for (const mode of modes) {
        // Don't overwrite ComfyUI modes with API modes
        if (!this.modes.has(mode.id)) {
          this.modes.set(mode.id, mode);
        }
      }
    }
  }

  /**
   * Get all active modes for a specific pipeline and provider.
   */
  getAvailableModes(pipeline: WorkflowPipeline, providerId?: string): WorkflowManifest[] {
    const results: WorkflowManifest[] = [];
    for (const mode of this.modes.values()) {
      if (mode.pipeline !== pipeline) continue;
      if (mode.active === false) continue;
      // Filter by provider: non-ComfyUI providers only see API-only modes (no workflowFile)
      // ComfyUI sees ALL modes (both litegraph and api format have workflowFile)
      if (providerId && providerId !== 'comfyui' && mode.workflowFile) continue;
      results.push(mode);
    }
    return results.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get a specific mode by ID.
   */
  getMode(modeId: string): WorkflowManifest | undefined {
    return this.modes.get(modeId);
  }

  /**
   * Return every loaded mode (built-in + user + cloud + API providers)
   * as a flat array. Used by the workflow management UI which lists
   * everything regardless of pipeline.
   */
  getAllModes(): WorkflowManifest[] {
    return Array.from(this.modes.values()).sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get the absolute directory path where a mode's manifest file lives.
   * Used to resolve the workflow JSON file path relative to the manifest.
   */
  getManifestDir(modeId: string): string | undefined {
    return manifestDirMap.get(modeId);
  }

  /**
   * Check if an ID belongs to a built-in workflow.
   */
  isBuiltInId(id: string): boolean {
    const mode = this.modes.get(id);
    return mode?.builtIn === true;
  }

  /**
   * Get the active workflow for a pipeline type.
   * If a user has set an override, returns that. Otherwise returns the built-in default.
   * Built-in defaults are always present and cannot be removed.
   */
  getActiveForPipeline(pipeline: WorkflowPipeline, providerId?: string): WorkflowManifest | undefined {
    const modes = this.getAvailableModes(pipeline, providerId);
    // User override takes precedence
    const override = modes.find(m => m.isOverride && !m.builtIn);
    if (override) return override;
    // Fall back to built-in default (highest priority = lowest number)
    return modes.find(m => m.builtIn) || modes[0];
  }

  /**
   * Infer which generation strategies a workflow supports from its inputRequirements.
   * Returns the explicit `strategies` array if set, otherwise infers from inputs.
   */
  getStrategies(mode: WorkflowManifest): string[] {
    if (mode.strategies && mode.strategies.length > 0) return mode.strategies;

    const imageInputs = mode.inputRequirements.filter(
      r => r.type === 'image' && r.source === 'shot_image'
    );
    const imageIds = new Set(imageInputs.map(r => r.id));
    const strategies: string[] = [];

    if (imageIds.has('first_frame') && imageIds.has('last_frame') && imageIds.has('mid_frame')) {
      strategies.push('fmlfv');
    }
    if (imageIds.has('first_frame') && imageIds.has('last_frame')) {
      strategies.push('flfv');
    }
    if (imageIds.has('first_frame')) {
      strategies.push('i2v');
    }
    // If no image inputs required, supports t2v
    if (imageInputs.length === 0 || imageInputs.every(r => !r.required)) {
      strategies.push('t2v');
    }

    return strategies.length > 0 ? strategies : ['i2v']; // default fallback
  }

  /**
   * Find the best workflow for a specific generation strategy.
   *
   * Priority: active user workflow (if it supports the strategy) > built-in mode.
   * Multiple user workflows can coexist — each covers different strategies.
   * User workflows are preferred over built-ins (sorted by priority).
   */
  getWorkflowForStrategy(strategy: string, providerId?: string): WorkflowManifest | undefined {
    const modes = this.getAvailableModes('video_generation', providerId);

    // 1. Check active user workflows that support this strategy (best priority first)
    const userMatch = modes
      .filter(m => !m.builtIn && m.active && this.getStrategies(m).includes(strategy))
      .sort((a, b) => a.priority - b.priority)[0];
    if (userMatch) return userMatch;

    // 2. Find a built-in mode whose ID matches the strategy directly (e.g., 'i2v', 't2v')
    const builtIn = modes.find(m => m.builtIn && m.id === strategy);
    if (builtIn) return builtIn;

    // 3. Find any mode that supports this strategy
    const anyMatch = modes
      .filter(m => this.getStrategies(m).includes(strategy))
      .sort((a, b) => a.priority - b.priority)[0];
    if (anyMatch) return anyMatch;

    // 4. Fall back to pipeline default
    return this.getActiveForPipeline('video_generation', providerId);
  }

  /**
   * Get all unique strategies available across all active video generation modes.
   * Used to tell the LLM which strategies it can choose from.
   */
  getAvailableStrategies(providerId?: string): Array<{ strategy: string; description: string; frameInputs: string[] }> {
    const modes = this.getAvailableModes('video_generation', providerId);
    const seen = new Map<string, { description: string; frameInputs: string[] }>();

    // Collect strategies from all modes, preferring user override descriptions
    for (const mode of modes) {
      const strategies = this.getStrategies(mode);
      for (const strategy of strategies) {
        if (!seen.has(strategy) || (mode.isOverride && !mode.builtIn)) {
          const frameInputs = mode.inputRequirements
            .filter(r => r.type === 'image' && r.source === 'shot_image')
            .map(r => r.id);
          seen.set(strategy, {
            description: mode.selectionCriteria,
            frameInputs,
          });
        }
      }
    }

    return Array.from(seen.entries()).map(([strategy, info]) => ({
      strategy,
      ...info,
    }));
  }

  /**
   * Activate a user workflow — makes it available for strategy-based routing.
   * Multiple user workflows can be active simultaneously (each covers different strategies).
   * Persists to disk.
   */
  setOverride(modeId: string): boolean {
    const mode = this.modes.get(modeId);
    if (!mode || mode.builtIn) return false;
    mode.isOverride = true;
    mode.active = true;
    this.persistManifest(mode);
    return true;
  }

  /**
   * Deactivate a user workflow — removes it from strategy routing.
   * Falls back to built-in for strategies this workflow covered.
   * Persists change to disk.
   */
  clearOverride(pipeline: WorkflowPipeline, modeId?: string): void {
    for (const m of this.modes.values()) {
      if (m.pipeline === pipeline && !m.builtIn && m.isOverride) {
        if (modeId && m.id !== modeId) continue; // only deactivate the specified one
        m.isOverride = false;
        this.persistManifest(m);
      }
    }
  }

  /**
   * Remove a user-uploaded workflow. Built-ins cannot be removed.
   * Automatically clears override if the removed workflow was the active override.
   */
  removeMode(modeId: string): boolean {
    const mode = this.modes.get(modeId);
    if (!mode || mode.builtIn) return false;
    // If this was the active override, clear it first
    if (mode.isOverride) {
      this.clearOverride(mode.pipeline);
    }
    this.modes.delete(modeId);
    manifestDirMap.delete(modeId);
    return true;
  }

  /**
   * Get the absolute path to a mode's workflow file.
   */
  getWorkflowPath(mode: WorkflowManifest): string | undefined {
    if (!mode.workflowFile) return undefined;
    // Use stored manifest directory if available
    const dir = manifestDirMap.get(mode.id);
    if (dir) {
      const absPath = join(dir, mode.workflowFile);
      if (existsSync(absPath)) return absPath;
    }
    // Fallback: scan all directories
    for (const d of workflowDirs()) {
      const absPath = join(this.projectRoot, d, mode.workflowFile);
      if (existsSync(absPath)) return absPath;
    }
    return undefined;
  }

  /**
   * Generate a markdown section describing available video generation strategies.
   * Presents clean strategy IDs (i2v, t2v, flfv, fmlfv) for LLM selection,
   * not raw workflow IDs. Injected via {{AVAILABLE_VIDEO_MODES}} placeholder.
   */
  generateVideoModesSection(providerId?: string): string {
    // Filter out t2v and i2v — every shot should use flfv (first + last frame) for video consistency
    // flfv anchors both start and end of the shot; fmlfv for complex shots
    const strategies = this.getAvailableStrategies(providerId)
      .filter(s => s.strategy !== 't2v' && s.strategy !== 'i2v');
    if (strategies.length === 0) {
      return '## Video Generation Mode\n\nNo video generation modes are currently available. Use `"videoGenerationMode": null`.';
    }

    const STRATEGY_NAMES: Record<string, string> = {
      'i2v': 'Image to Video',
      't2v': 'Text to Video',
      'flfv': 'First + Last Frame Video',
      'fmlfv': 'First + Mid + Last Frame Video',
      'i2v_late_entry': 'Image to Video (Late Character Entry)',
    };

    const STRATEGY_DESCRIPTIONS: Record<string, string> = {
      'i2v': 'Animates a single first-frame image into video. Best for character shots where visual consistency matters.',
      't2v': 'Generates video purely from text prompt with no source image. The model has full creative freedom.',
      'flfv': 'Uses both a first frame and a last frame image, generating video that transitions between them. Best for shots with a clear visual start and end state.',
      'fmlfv': 'Uses first, middle, and last frame images for maximum control. Best for complex shots with specific visual beats.',
      'i2v_late_entry': 'First frame shows only setting/environment — no characters. A character enters the frame mid-shot.',
    };

    const lines = ['## Video Generation Mode', '', 'Choose a `videoGenerationMode` for each shot:', ''];
    for (const { strategy, description, frameInputs } of strategies) {
      const name = STRATEGY_NAMES[strategy] ?? strategy;
      const desc = STRATEGY_DESCRIPTIONS[strategy] ?? description;
      const frames = frameInputs.length > 0 ? frameInputs.join(', ') : 'none';
      lines.push(`- **\`${strategy}\`** (${name}) — ${desc}`);
      lines.push(`  *Use when:* ${description}`);
      lines.push(`  *Frame images needed:* ${frames}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Generate a markdown section describing available image processing modes.
   * Injected into LLM prompts via {{AVAILABLE_PROCESSING_MODES}} placeholder.
   */
  generateProcessingModesSection(providerId?: string): string {
    const modes = this.getAvailableModes('image_processing', providerId);
    if (modes.length === 0) {
      return '## Image Processing Mode\n\nNo image processing workflows are currently installed. Set `"imageProcessingMode": null` for all shots.';
    }

    const lines = ['## Image Processing Mode', '', 'Optionally choose an `imageProcessingMode` per shot (set to `null` if not needed):', ''];
    for (const mode of modes) {
      lines.push(`- **\`${mode.id}\`** (${mode.displayName}) — ${mode.llmDescription}`);
      lines.push(`  *Use when:* ${mode.selectionCriteria}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Generate frame generation guide for the shot_image_prompt LLM.
   * Tells it how many frame images to generate per video generation strategy.
   */
  generateFrameGuideSection(providerId?: string): string {
    const strategies = this.getAvailableStrategies(providerId)
      .filter(s => s.strategy !== 't2v' && s.strategy !== 'i2v');
    const lines = ['## Frame Images Per Mode', '', 'Generate the required frame images based on the shot\'s `videoGenerationMode`:', ''];

    for (const { strategy, frameInputs } of strategies) {
      if (frameInputs.length === 0) {
        lines.push(`- **\`${strategy}\`**: No frame images needed (text-only generation)`);
      } else if (frameInputs.length === 1) {
        lines.push(`- **\`${strategy}\`**: Generate 1 image — \`${frameInputs[0]}\``);
      } else {
        const imgs = frameInputs.map(f => `\`${f}\``).join(', ');
        lines.push(`- **\`${strategy}\`**: Generate ${frameInputs.length} images — ${imgs}`);
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * List all registered modes (for management UI).
   */
  listAll(): WorkflowManifest[] {
    return Array.from(this.modes.values()).sort((a, b) => {
      if (a.pipeline !== b.pipeline) return a.pipeline.localeCompare(b.pipeline);
      return a.priority - b.priority;
    });
  }

  /**
   * Persist a manifest's current state back to its JSON file on disk.
   * Only works for user workflows (has a known manifest directory).
   */
  private persistManifest(manifest: WorkflowManifest): void {
    const dir = manifestDirMap.get(manifest.id);
    if (!dir) return;
    try {
      const filePath = join(dir, `${manifest.id}.manifest.json`);
      if (existsSync(filePath)) {
        writeFileSync(filePath, JSON.stringify(manifest, null, 2));
      }
    } catch {
      console.warn(`[WorkflowModeRegistry] Failed to persist manifest for ${manifest.id}`);
    }
  }
}

// Singleton
let _registry: WorkflowModeRegistry | undefined;

export function getWorkflowModeRegistry(): WorkflowModeRegistry {
  if (!_registry) {
    _registry = new WorkflowModeRegistry();
    _registry.refresh();
    markRegistryInitialized();
  }
  return _registry;
}

/**
 * Test-only: clear the singleton so the next call constructs a fresh
 * registry against the current `workflowsRoot.ts` state. Production
 * code must not call this — the singleton's identity is load-bearing
 * for cache-coherence assumptions elsewhere.
 */
export function resetWorkflowModeRegistryForTesting(): void {
  _registry = undefined;
}
