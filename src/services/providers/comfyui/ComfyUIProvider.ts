/**
 * ComfyUI provider — wraps the existing ComfyUI service to implement GenerationProvider.
 *
 * Delegates to ComfyUIClient, WorkflowRegistry, and WorkflowLoader.
 * Does NOT modify any existing ComfyUI service code.
 */
import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import {
  ComfyUIClient,
  loadWorkflowTemplate,
  parameterizeWorkflowByName,
  getRegistry,
  isComfyCloudUrl,
} from '../../comfyui/index.js';
import type { ImageInfo } from '../../comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../../comfyui/WorkflowLoader.js';
import { buildGrokEditWorkflow, type GrokResolution, type GrokAspectRatio } from './grokWorkflowBuilder.js';
import {
  ensureProjectPathDir,
  writeProjectBufferAtPath,
} from '../../../tasks/video/workflow/projectFileIO.js';
import type {
  GenerationProvider,
  GenerationCapability,
  GenerationResult,
  ImageGenerationInput,
  ImageEditInput,
  VideoGenerationInput,
  ProviderProgressCallback,
} from '../types.js';
import { finddheeCoreRoot } from '../../../agent/pi/paths.js';

// Anchor on dhee-core's own root so embedded hosts (dhee-desktop)
// don't lose log entries when their cwd has no `logs/` dir.
const DEBUG_LOG_DIR = (() => {
  try {
    return path.join(finddheeCoreRoot(import.meta.url), 'logs');
  } catch {
    return path.join(process.cwd(), 'logs');
  }
})();
const DEBUG_LOG_PATH = path.join(DEBUG_LOG_DIR, 'debug.log');
let debugDirEnsured = false;
function debugLog(message: string): void {
  try {
    if (!debugDirEnsured) {
      try { fs.mkdirSync(DEBUG_LOG_DIR, { recursive: true }); } catch { /* ignore */ }
      debugDirEnsured = true;
    }
    const timestamp = new Date().toISOString();
    fs.appendFileSync(DEBUG_LOG_PATH, `[${timestamp}] [ComfyUIProvider] ${message}\n`);
  } catch {
    // Ignore logging errors
  }
}

export function replaceUnresolvedLoadImages(
  workflow: Record<string, unknown>,
  uploadedNames: Set<string>,
  fallbackImage: string | undefined,
  log: (message: string) => void = debugLog,
): void {
  for (const [nid, n] of Object.entries(workflow)) {
    const node = n as { class_type?: string; inputs?: Record<string, unknown> };
    if (node.class_type === 'LoadImage' && typeof node.inputs?.['image'] === 'string') {
      const img = node.inputs['image'];
      const isKnownUpload = uploadedNames.has(img);
      log(`[video workflow] LoadImage node ${nid}: image=${img}  known_upload=${isKnownUpload}`);
      if (!isKnownUpload) {
        if (fallbackImage) {
          node.inputs['image'] = fallbackImage;
          log(`[video workflow] Replaced unresolved LoadImage node ${nid}: ${img} → ${fallbackImage}`);
        } else {
          log(`[video workflow] WARNING: LoadImage node ${nid} still references ${img} — likely a stale template placeholder. ComfyUI Cloud may reject the submission.`);
        }
      }
    }
  }
}

export class ComfyUIProvider implements GenerationProvider {
  readonly id = 'comfyui';
  readonly displayName = 'ComfyUI (Local)';
  readonly capabilities: GenerationCapability[] = [
    'image_generation',
    'image_editing',
    'video_generation',
  ];

  isAvailable(): boolean {
    // ComfyUI is available if the server URL is set (defaults to localhost:8188)
    const url = process.env['COMFYUI_BASE_URL'] || 'http://localhost:8188';
    return !!url;
  }

  async generateImage(
    input: ImageGenerationInput,
    onProgress?: ProviderProgressCallback,
  ): Promise<GenerationResult> {
    const {
      prompt,
      negativePrompt = '',
      aspectRatio = '16:9',
      width: overrideWidth,
      height: overrideHeight,
      seed: inputSeed,
      outputDir,
      filenamePrefix = 'image',
      referenceImages = [],
    } = input;
    // Randomize seed if not provided — prevents user workflows from reusing the template's fixed seed
    const seed = inputSeed ?? Math.floor(Math.random() * 0x7FFFFFFF);

    const registry = getRegistry();
    const client = new ComfyUIClient({ outputDir });

    // Determine workflow: check registry for user override, fall back to built-in defaults
    const useQwenEdit = referenceImages.length > 0;
    let workflowName = useQwenEdit ? 'qwen_edit' : 'zimage';
    let modeManifest: any = null;

    try {
      const { getWorkflowModeRegistry } = await import('../WorkflowModeRegistry.js');
      const modeRegistry = getWorkflowModeRegistry();
      const pipeline = useQwenEdit ? 'image_editing' as const : 'image_generation' as const;
      let activeMode = modeRegistry.getActiveForPipeline(pipeline, 'comfyui');

      // Composition-vs-delta split: this method (`generateImage`) handles
      // first-frame `image_text_to_image` calls. When Grok is the active
      // image_editing workflow, empirical probes showed Grok recomposes
      // instead of honoring prompt-level composition directives (OTS
      // collapses to two-shot; turbans and other secondary-subject details
      // drop). Klein is the composition workhorse. Fall back to Klein
      // for first-frame gen; keep Grok only for `editImage` (deltas).
      if (pipeline === 'image_editing' && activeMode?.id === 'grok_image_edit') {
        // Composition workhorse for first-frame gen is the plain (no-LoRA)
        // FLUX 2 Klein workflow — that's the default for image_editing now.
        // The consistency-LoRA variant (flux2_klein_edit_consistency_cloud)
        // and the detail-LoRA variant (flux2_klein_edit_detail_cloud) are
        // kept in the registry but inactive; flip their `active` flags to
        // route through them again for A/B comparisons.
        const kleinMode = modeRegistry.getMode('flux2_klein_edit_cloud');
        if (kleinMode?.active) {
          activeMode = kleinMode;
          debugLog('generateImage: Grok active for edits, but routing composition to Klein (grok_image_edit reserved for editImage deltas)');
        }
      }

      if (activeMode) {
        modeManifest = activeMode;
        workflowName = activeMode.id;
        debugLog(`Using ${pipeline} workflow: ${activeMode.displayName} (${activeMode.id})${activeMode.isOverride ? ' [user override]' : ''}`);
      }
    } catch { /* registry not available, use defaults */ }

    const hasManifestWorkflow = modeManifest && modeManifest.workflowFile && modeManifest.parameterMappings?.length > 0;

    let inputImageFilename: string | undefined;
    const referenceImageFilenames: string[] = [];

    // Upload reference images if using editing workflow.
    // Klein's edit workflow has 4 LoadImage nodes (manifest: base_image +
    // reference_image_1..3), so we can take up to 4 refs here. Before
    // 2026-04-22 this was slice(0, 3) and silently dropped the 4th ref —
    // specifically hurting shot prompts that listed 3 characters + 1
    // setting, where the setting got cut and the 4th Klein slot was
    // filled with a duplicate of the first ref via the safety fallback
    // at the bottom of this branch.
    if (useQwenEdit) {
      // Upload in caller's order. Any reordering (e.g. "setting first so
      // it becomes Klein's base") MUST happen upstream at the
      // shot_image_prompt layer, because the prompt text says "from
      // image N" and the N's must match the final upload order. We do
      // that normalization in `normalizeShotImagePrompt` before we ever
      // hit this provider.
      const imagesToUpload = referenceImages.slice(0, 4);
      for (let i = 0; i < imagesToUpload.length; i++) {
        const refImage = imagesToUpload[i]!;
        if (!fs.existsSync(refImage.filePath)) {
          console.warn(`[ComfyUIProvider] Reference image not found: ${refImage.filePath}`);
          continue;
        }
        const uploadResult = await client.uploadImage(refImage.filePath);
        if (i === 0) {
          inputImageFilename = uploadResult.name;
        } else {
          referenceImageFilenames.push(uploadResult.name);
        }
      }

      if (!inputImageFilename) {
        throw new Error('No reference images could be uploaded for image+text generation mode.');
      }
    }

    // Load and parameterize workflow
    onProgress?.({ percentage: 0, message: `Loading workflow: ${modeManifest?.displayName ?? workflowName}...`, done: false });

    let workflow: Record<string, unknown>;

    if (hasManifestWorkflow) {
      // User workflow: load from manifest path, use generic parameterizer
      const { getWorkflowModeRegistry } = await import('../WorkflowModeRegistry.js');
      const modeRegistry = getWorkflowModeRegistry();
      const manifestDir = modeRegistry.getManifestDir(modeManifest.id);
      const workflowPath = manifestDir
        ? path.join(manifestDir, modeManifest.workflowFile)
        : path.join(process.cwd(), 'workflows', 'user', modeManifest.workflowFile);

      if (!fs.existsSync(workflowPath)) {
        throw new Error(`User workflow file not found: ${workflowPath}`);
      }

      debugLog(`Loading user image workflow from: ${workflowPath}`);
      const template = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
      const genParams: Record<string, unknown> = {
        prompt,
        negative_prompt: negativePrompt,
        seed,
        base_image: inputImageFilename ?? '',
        filenamePrefix,
        width: overrideWidth,
        height: overrideHeight,
      };
      // Fill all reference slots — unused ones get the base image
      for (let i = 0; i < 4; i++) {
        genParams[`reference_image_${i + 1}`] = referenceImageFilenames[i] ?? inputImageFilename ?? '';
      }
      workflow = parameterizeGeneric(template, modeManifest, genParams);

      // Safety: replace any remaining LoadImage placeholders
      for (const [, wfNode] of Object.entries(workflow)) {
        const n = wfNode as { class_type?: string; inputs?: Record<string, unknown> };
        if (n.class_type === 'LoadImage' && typeof n.inputs?.['image'] === 'string') {
          if ((n.inputs['image']).startsWith('ref_image_')) {
            n.inputs['image'] = inputImageFilename ?? '';
          }
        }
      }
    } else {
      // Built-in workflow: use old registry + named parameterizer
      const workflowMetadata = registry.get(workflowName);
      if (!workflowMetadata) {
        throw new Error(`Workflow '${workflowName}' not found`);
      }
      const template = loadWorkflowTemplate(workflowMetadata.filename);
      workflow = parameterizeWorkflowByName(workflowName, template, {
        sceneNumber: 0,
        prompt,
        negativePrompt,
        aspectRatio,
        width: overrideWidth,
        height: overrideHeight,
        seed,
        filenamePrefix,
        inputImageFilename,
        referenceImageFilenames: referenceImageFilenames.length > 0 ? referenceImageFilenames : undefined,
      }) as Record<string, unknown>;
    }

    // Queue and wait (WS connects first, then submits — prevents missing cloud events)
    onProgress?.({ percentage: 0, message: 'Queueing prompt...', done: false });
    const workflowId = modeManifest?.id ?? workflowName;
    const { promptId, outputs: wsOutputs } = await this.queueAndWait(client, workflow, onProgress, workflowId);

    // Download result (use WS-collected outputs for cloud, /history for local)
    return this.downloadFirstOutput(client, promptId, outputDir, 'image/png', wsOutputs, filenamePrefix, workflowId);
  }

  async editImage(
    input: ImageEditInput,
    onProgress?: ProviderProgressCallback,
  ): Promise<GenerationResult> {
    const {
      editPrompt,
      baseImagePath,
      referenceImages = [],
      negativePrompt,
      aspectRatio,
      seed: inputSeed,
      outputDir,
      filenamePrefix = 'edit',
    } = input;
    const seed = inputSeed ?? Math.floor(Math.random() * 0x7FFFFFFF);

    const registry = getRegistry();

    // Determine workflow: explicit user override (mode registry) wins,
    // otherwise default to the built-in FLUX 2 Klein edit workflow
    // shipped with dhee-core. The exact ID resolves via
    // chooseImageEditWorkflow (mode-aware: local vs cloud).
    let workflowName = process.env['COMFY_MODE'] === 'cloud'
      ? 'flux2_klein_edit_cloud'
      : 'flux2_klein_edit_local';
    let modeManifest: any = null;
    let modeOverrideActive = false;
    try {
      const { getWorkflowModeRegistry } = await import('../WorkflowModeRegistry.js');
      const modeRegistry = getWorkflowModeRegistry();
      modeRegistry.refresh();
      const activeMode = modeRegistry.getActiveForPipeline('image_editing', 'comfyui');
      if (activeMode?.isOverride) {
        // User explicitly pinned a workflow — respect that.
        modeManifest = activeMode;
        workflowName = activeMode.id;
        modeOverrideActive = true;
        debugLog(`Using image_editing workflow (user override): ${activeMode.displayName} (${activeMode.id})`);
      } else if (activeMode) {
        modeManifest = activeMode;
        workflowName = activeMode.id;
        debugLog(`Default image_editing workflow from registry: ${activeMode.displayName} (${activeMode.id})`);
      }
    } catch (err) {
      debugLog(`WorkflowModeRegistry error: ${(err as Error).message}`);
    }

    if (!modeOverrideActive) {
      // Default: qwen_snofs_edit for every image edit (no Klein
      // fallback). chooseImageEditWorkflow encapsulates the policy.
      const { chooseImageEditWorkflow } = await import('../../comfyui/chooseImageEditWorkflow.js');
      const chosen = chooseImageEditWorkflow({
        totalImages: 1 + referenceImages.length,
        modeOverride: null,
      });
      if (chosen !== workflowName) {
        debugLog(`Routing image_editing → ${chosen}`);
        workflowName = chosen;
        // Re-look up the manifest for the chosen workflow so the
        // manifest-driven parameterizeGeneric path picks it up.
        try {
          const { getWorkflowModeRegistry } = await import('../WorkflowModeRegistry.js');
          const modeRegistry = getWorkflowModeRegistry();
          const chosenManifest = modeRegistry.getMode(chosen);
          modeManifest = chosenManifest ?? null;
          if (!chosenManifest) {
            debugLog(`Chosen workflow '${chosen}' has no manifest registered — will fall back to built-in registry path`);
          }
        } catch (err) {
          debugLog(`Manifest lookup for '${chosen}' failed: ${(err as Error).message}`);
          modeManifest = null;
        }
      }
    }

    const hasManifestWorkflow = modeManifest && modeManifest.workflowFile && modeManifest.parameterMappings?.length > 0;

    if (!fs.existsSync(baseImagePath)) {
      throw new Error(`Base image not found: ${baseImagePath}`);
    }

    const client = new ComfyUIClient({ outputDir });

    // Grok caps at 1 base + 2 refs (GrokImageEditNode rejects >3 images).
    // Klein's static template is wired for 1 base + 3 refs.
    const isGrok = modeManifest?.id === 'grok_image_edit';
    const maxRefs = isGrok ? 2 : 4;

    // Upload base image
    onProgress?.({ percentage: 0, message: 'Uploading base image...', done: false });
    const uploadResult = await client.uploadImage(baseImagePath, 'input', true);

    const referenceImageFilenames: string[] = [];
    for (const refPath of referenceImages.slice(0, maxRefs)) {
      if (!fs.existsSync(refPath)) {
        throw new Error(`Reference image not found: ${refPath}`);
      }
      onProgress?.({ percentage: 0, message: 'Uploading reference image...', done: false });
      const refUpload = await client.uploadImage(refPath, 'input', true);
      referenceImageFilenames.push(refUpload.name);
    }

    // Load and parameterize workflow
    onProgress?.({ percentage: 0, message: `Loading workflow: ${modeManifest?.displayName ?? workflowName}...`, done: false });

    let workflow: Record<string, unknown>;

    if (isGrok) {
      // Grok edit: builder emits exactly-N-slot workflows because
      // AILab_ImageToList's image_N inputs are mandatory in API format.
      // parameterizeGeneric can't delete nodes, so we bypass it.
      const grokResolution = (modeManifest?.defaultValues?.resolution as GrokResolution | undefined) ?? '1K';
      const grokAspect = (modeManifest?.defaultValues?.aspect_ratio as GrokAspectRatio | undefined) ?? 'auto';
      workflow = buildGrokEditWorkflow({
        baseImage: uploadResult.name,
        refs: referenceImageFilenames,
        prompt: editPrompt,
        seed,
        filenamePrefix,
        resolution: grokResolution,
        aspectRatio: grokAspect,
      });
      debugLog(`[Grok] built workflow: base=${uploadResult.name}, refs=${referenceImageFilenames.length}, nodes=${Object.keys(workflow).length}`);
    } else if (hasManifestWorkflow) {
      const { getWorkflowModeRegistry } = await import('../WorkflowModeRegistry.js');
      const modeRegistry = getWorkflowModeRegistry();
      const manifestDir = modeRegistry.getManifestDir(modeManifest.id);
      const workflowPath = manifestDir
        ? path.join(manifestDir, modeManifest.workflowFile)
        : path.join(process.cwd(), 'workflows', 'user', modeManifest.workflowFile);

      if (!fs.existsSync(workflowPath)) {
        throw new Error(`User workflow file not found: ${workflowPath}`);
      }

      debugLog(`Loading user edit workflow from: ${workflowPath}`);
      const template = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));

      // Build params — unused reference slots fall back to base image
      const editParams: Record<string, unknown> = {
        prompt: editPrompt,
        edit_prompt: editPrompt,
        negative_prompt: negativePrompt ?? '',
        base_image: uploadResult.name,
        seed,
        filenamePrefix,
      };
      // Fill reference slots — unused ones get the base image so ComfyUI doesn't reject
      for (let i = 0; i < 4; i++) {
        editParams[`reference_image_${i + 1}`] = referenceImageFilenames[i] ?? uploadResult.name;
      }

      workflow = parameterizeGeneric(template, modeManifest, editParams);

      // Safety: set any remaining LoadImage nodes that still have placeholder filenames
      let placeholderCount = 0;
      for (const [nid, node] of Object.entries(workflow)) {
        const n = node as { class_type?: string; inputs?: Record<string, unknown> };
        if (n.class_type === 'LoadImage' && typeof n.inputs?.['image'] === 'string') {
          if ((n.inputs['image']).startsWith('ref_image_')) {
            console.log(`[FLUX Klein] Replacing placeholder on node ${nid}: ${n.inputs['image']} → ${uploadResult.name}`);
            n.inputs['image'] = uploadResult.name;
            placeholderCount++;
          }
        }
      }
      console.log(`[FLUX Klein] hasManifestWorkflow=true, refs=${referenceImageFilenames.length}, placeholders_fixed=${placeholderCount}, nodes=${Object.keys(workflow).length}`);
    } else {
      console.log(`[FLUX Klein] hasManifestWorkflow=FALSE, falling back to old registry: ${workflowName}`);
      const workflowMetadata = registry.get(workflowName);
      if (!workflowMetadata) {
        throw new Error(`Workflow '${workflowName}' not found`);
      }
      const template = loadWorkflowTemplate(workflowMetadata.filename);
      workflow = parameterizeWorkflowByName(workflowName, template, {
        sceneNumber: 0,
        prompt: editPrompt,
        negativePrompt,
        aspectRatio,
        seed,
        inputImageFilename: uploadResult.name,
        referenceImageFilenames: referenceImageFilenames.length > 0 ? referenceImageFilenames : undefined,
        filenamePrefix,
      }) as Record<string, unknown>;
    }

    // Queue and wait
    onProgress?.({ percentage: 0, message: 'Queueing prompt...', done: false });
    const workflowId = modeManifest?.id ?? workflowName;
    const { promptId, outputs: wsOutputs } = await this.queueAndWait(client, workflow, onProgress, workflowId);

    return this.downloadFirstOutput(client, promptId, outputDir, 'image/png', wsOutputs, filenamePrefix, workflowId);
  }

  async generateVideo(
    input: VideoGenerationInput,
    onProgress?: ProviderProgressCallback,
  ): Promise<GenerationResult> {
    const {
      sourceImagePath,
      prompt,
      durationSeconds,
      width,
      height,
      seed: inputSeed,
      outputDir,
      filenamePrefix = 'video',
    } = input;
    const seed = inputSeed ?? Math.floor(Math.random() * 0x7FFFFFFF);

    const isT2V = !sourceImagePath || !fs.existsSync(sourceImagePath);

    if (!isT2V && !fs.existsSync(sourceImagePath)) {
      throw new Error(`Source image not found: ${sourceImagePath}`);
    }

    const registry = getRegistry();

    // Strategy-aware workflow routing:
    // 1. The executor passes modeId = generation strategy (i2v, t2v, flfv, fmlfv)
    // 2. Find the best workflow that supports this strategy (user override > built-in)
    // 3. If no strategy specified, fall back to pipeline default
    const workflowName = 'ltx23';
    let modeManifest = null as any;
    const strategy = input.modeId || 'i2v';
    try {
      const { getWorkflowModeRegistry } = await import('../WorkflowModeRegistry.js');
      const modeRegistry = getWorkflowModeRegistry();

      modeManifest = modeRegistry.getWorkflowForStrategy(strategy, 'comfyui');
      if (modeManifest) {
        const isOverride = modeManifest.isOverride && !modeManifest.builtIn;
        debugLog(`Strategy "${strategy}" → workflow: ${modeManifest.displayName} (${modeManifest.id})${isOverride ? ' [user override]' : ' [built-in]'}`);

        // Strategy compatibility guard. Strategy registries can resolve a
        // workflow even when the requested strategy isn't in the workflow's
        // own `strategies` list (priority/pipeline-based fallback). For v2v
        // specifically, picking a non-v2v workflow silently uploads the
        // source video as input then fails midway through generation.
        // Detect mismatches early.
        const strategies: string[] | undefined = modeManifest.strategies;
        const inputs: Array<{ id: string }> | undefined = modeManifest.inputRequirements;
        const supportsStrategy = !strategies || strategies.includes(strategy);
        const acceptsSourceVideo = !inputs || inputs.some(i => i.id === 'source_video');
        if (strategy === 'v2v_extend' && !supportsStrategy) {
          throw new Error(
            `Workflow ${modeManifest.id} does not support requested video strategy '${strategy}'`,
          );
        }
        if (strategy === 'v2v_extend' && !acceptsSourceVideo) {
          throw new Error(
            `Workflow ${modeManifest.id} missing inputs: source_video`,
          );
        }
      }
    } catch (err) {
      // Re-raise strategy guard errors; swallow registry-not-available errors.
      if (err instanceof Error && (
        /does not support requested video strategy/.test(err.message) ||
        /missing inputs:/.test(err.message)
      )) {
        throw err;
      }
      /* registry not available, use default */
    }

    // Determine if this is a user-uploaded workflow or a built-in
    const hasManifestWorkflow = modeManifest && modeManifest.workflowFile && modeManifest.parameterMappings?.length > 0;

    // Ensure output dir exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const client = new ComfyUIClient({ outputDir });

    // Upload source image or video
    let uploadResult: { name: string } | null = null;
    const isV2VExtend = strategy === 'v2v_extend' && input.sourceVideoPath && fs.existsSync(input.sourceVideoPath);
    if (isV2VExtend) {
      onProgress?.({ percentage: 0, message: 'Uploading source video for V2V extend...', done: false });
      uploadResult = await client.uploadImage(input.sourceVideoPath!, 'input', true);
      debugLog(`V2V Extend: uploaded source video ${input.sourceVideoPath} → ${uploadResult.name}`);
    } else if (!isT2V) {
      onProgress?.({ percentage: 0, message: 'Uploading source image...', done: false });
      uploadResult = await client.uploadImage(sourceImagePath, 'input', true);
      debugLog(`Uploaded source_image: ${sourceImagePath} → ${uploadResult.name}`);
    } else {
      onProgress?.({ percentage: 0, message: 'Text-to-video mode...', done: false });
    }

    // Upload additional frame images (last_frame, mid_frame, etc.) for FLFV workflows
    const uploadedFrames: Record<string, string> = {};
    if (input.frameImages) {
      for (const [frameId, framePath] of Object.entries(input.frameImages)) {
        if (fs.existsSync(framePath)) {
          onProgress?.({ percentage: 0, message: `Uploading ${frameId}...`, done: false });
          const frameUpload = await client.uploadImage(framePath, 'input', true);
          uploadedFrames[frameId] = frameUpload.name;
          debugLog(`Uploaded ${frameId}: ${framePath} → ${frameUpload.name}`);
        } else {
          debugLog(`Frame image not found, skipping: ${frameId} → ${framePath}`);
        }
      }
    }

    // Load and parameterize workflow
    onProgress?.({ percentage: 0, message: `Loading workflow: ${modeManifest?.displayName ?? 'ltx23'}...`, done: false });

    let workflow: Record<string, unknown>;

    if (hasManifestWorkflow) {
      // User-uploaded workflow: load from manifest path, use generic parameterizer
      const { getWorkflowModeRegistry } = await import('../WorkflowModeRegistry.js');
      const modeRegistry = getWorkflowModeRegistry();
      const manifestDir = modeRegistry.getManifestDir(modeManifest.id);

      let workflowPath: string;
      if (manifestDir) {
        workflowPath = path.join(manifestDir, modeManifest.workflowFile);
      } else {
        workflowPath = path.join(process.cwd(), 'workflows', 'user', modeManifest.workflowFile);
      }

      if (!fs.existsSync(workflowPath)) {
        throw new Error(`User workflow file not found: ${workflowPath}`);
      }

      debugLog(`Loading user workflow from: ${workflowPath} (isT2V=${isT2V}, frames=${Object.keys(uploadedFrames).join(',') || 'none'})`);
      const template = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
      const genericParams: Record<string, unknown> = {
        prompt,
        negative_prompt: '',
        seed,
        filenamePrefix,
        width,
        height,
        durationSeconds,
      };
      // Set first_frame (uploaded source image) or source_video (V2V extend)
      if (isV2VExtend && uploadResult?.name) {
        genericParams['source_video'] = uploadResult.name;
      } else if (!isT2V && uploadResult?.name) {
        genericParams['first_frame'] = uploadResult.name;
      }
      // Set additional frame images (last_frame, mid_frame, etc.)
      for (const [frameId, uploadedName] of Object.entries(uploadedFrames)) {
        genericParams[frameId] = uploadedName;
      }

      workflow = parameterizeGeneric(template, modeManifest, genericParams);

      // Boolean toggle nodes (PrimitiveBoolean) for i2v/t2v switching:
      // These are handled by parameterizeGeneric via defaultValue from the manifest.
      // The manifest's defaultValue defines the correct state (e.g., false = i2v mode).
      // When no image is provided (t2v), the default kicks in via parameterizeGeneric.
      // We do NOT override booleans here — the manifest defines the semantics.

      // Audit every LoadImage node's resolved `image` input after
      // parameterization. If any still points at a workflow placeholder
      // (filename like `c4HD71Fv_Scene3_00001_.png` or anything with a
      // nanoid+scene prefix that doesn't match a file we just uploaded),
      // ComfyUI Cloud will hit its content-hash cache and return a
      // STALE cached result from some prior submission that used the
      // same placeholder — silently substituting unrelated video content.
      // This is the noir S1.1 "potter" bug surfaced on 2026-04-22.
      const uploadedNames = new Set<string>([
        uploadResult?.name,
        ...Object.values(uploadedFrames),
      ].filter((v): v is string => typeof v === 'string'));
      replaceUnresolvedLoadImages(
        workflow,
        uploadedNames,
        uploadResult?.name ?? Object.values(uploadedFrames)[0],
      );
    } else {
      // Built-in workflow: use the old registry + named parameterizer
      const workflowMetadata = registry.get(workflowName);
      if (!workflowMetadata) {
        throw new Error(`Workflow '${workflowName}' not found`);
      }
      const template = loadWorkflowTemplate(workflowMetadata.filename);
      workflow = parameterizeWorkflowByName(workflowName, template, {
        sceneNumber: 0,
        prompt,
        seed,
        inputImageFilename: uploadResult?.name,
        filenamePrefix,
        durationSeconds,
        width,
        height,
      } as Parameters<typeof parameterizeWorkflowByName>[2]) as Record<string, unknown>;
    }

    // Queue and wait
    onProgress?.({ percentage: 0, message: 'Queueing prompt...', done: false });
    const workflowId = modeManifest?.id ?? workflowName;
    const { promptId, outputs: wsOutputs } = await this.queueAndWait(client, workflow, onProgress, workflowId);

    const result = await this.downloadFirstOutput(client, promptId, outputDir, 'video/mp4', wsOutputs, filenamePrefix, workflowId);
    // Inject workflow name into metadata for upstream logging
    const workflowDisplayName = modeManifest?.displayName ?? 'LTX-2.3 (built-in)';
    result.metadata = { ...result.metadata, workflowName: workflowDisplayName, workflowId: modeManifest?.id ?? 'ltx23' };
    return result;
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  private async queueAndWait(
    client: ComfyUIClient,
    workflow: Record<string, unknown>,
    onProgress?: ProviderProgressCallback,
    workflowId?: string,
  ): Promise<{ promptId: string; clientId: string; outputs: ImageInfo[] }> {
    const progressHandler = (info: { percentage: number; message: string; step?: number; maxSteps?: number; currentNode?: string }) => {
      onProgress?.({
        percentage: info.percentage,
        message: info.message,
        done: info.percentage >= 100,
        step: info.step,
        maxSteps: info.maxSteps,
      });
    };

    // Use queueAndWaitWS: connects WS first, submits prompt inside onOpen,
    // prevents missing fast execution events on cloud
    const { result, promptId, clientId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, (info) => {
      progressHandler({
        percentage: info.percentage,
        message: info.message,
        step: info.step,
        maxSteps: info.maxSteps,
        currentNode: info.currentNode,
      });
    }, { workflowId });

    if (result.status !== 'completed' && result.status !== 'completed_with_timeout') {
      const detail = result.errorMessage ? `: ${result.errorMessage}` : '';
      throw new Error(`ComfyUI job did not complete (status: ${result.status})${detail}`);
    }

    return { promptId, clientId, outputs: wsOutputs };
  }

  private async downloadFirstOutput(
    client: ComfyUIClient,
    promptId: string,
    outputDir: string,
    mimeType: string,
    preCollectedOutputs?: ImageInfo[],
    filenamePrefix?: string,
    workflowId?: string,
  ): Promise<GenerationResult> {
    // Use pre-collected outputs from WS (needed for cloud where /history is blocked)
    // Fall back to HTTP history for local mode
    const images = preCollectedOutputs?.length ? preCollectedOutputs : await client.getOutputImages(promptId);
    if (!images.length) {
      throw new Error('No output files from ComfyUI');
    }

    const first = images[0]!;
    // Human-readable filename: caller's prefix (e.g. "scene_1_shot_3_last_frame")
    // shortened (sNshotM) + short model name (klein / grok / zimage / ltx23)
    // + nanoid to disambiguate regenerations of the same shot with the same
    // model. Fall back to the cloud's filename if no prefix was supplied.
    const ext = first.filename.includes('.') ? first.filename.slice(first.filename.lastIndexOf('.')) : '.png';
    const humanPrefix = shortenPrefix(filenamePrefix);
    const modelTag = shortModelName(workflowId);
    const parts = [humanPrefix, modelTag].filter(Boolean);
    const outputFilename = parts.length > 0
      ? `${parts.join('_')}_${nanoid(6)}${ext}`
      : `${nanoid(8)}_${first.filename}`;
    debugLog(`Downloading ${first.filename} → ${outputDir}/${outputFilename}`);

    const downloaded = await client.downloadOutput(
      first.filename,
      first.subfolder,
      first.type,
    );
    const savedPath = this.persistOutput(downloaded.buffer, outputDir, outputFilename);

    return {
      filePath: savedPath,
      mimeType,
      metadata: { provider: 'comfy', promptId, comfyuiFilename: first.filename, workflowId },
    };
  }

  private buildOutputFilename(
    remoteFilename: string,
    mimeType: string,
    filenamePrefix?: string,
  ): string {
    const comfyBaseUrl = process.env['COMFYUI_BASE_URL'] || 'http://localhost:8188';
    const isCloud = isComfyCloudUrl(comfyBaseUrl);
    if (!isCloud || !filenamePrefix?.trim()) {
      return `${nanoid(8)}_${remoteFilename}`;
    }

    const extension = path.extname(remoteFilename) || this.extensionFromMimeType(mimeType);
    const sanitizedPrefix = filenamePrefix.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
    return `${sanitizedPrefix}_${nanoid(8)}${extension}`;
  }

  private extensionFromMimeType(mimeType: string): string {
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/jpeg') return '.jpg';
    if (mimeType === 'video/mp4') return '.mp4';
    return '';
  }

  private persistOutput(
    buffer: Buffer,
    outputDir: string,
    outputFilename: string,
  ): string {
    const outputPath = path.join(outputDir, outputFilename);

    if (!ensureProjectPathDir(outputDir) && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    if (!writeProjectBufferAtPath(outputPath, buffer)) {
      fs.writeFileSync(outputPath, buffer);
    }

    return outputPath;
  }
}

/**
 * Compact a filename prefix so saved images are legible in Finder.
 *   scene_1_shot_3_last_frame  → s1shot3_last_frame
 *   scene_12_shot_7_first_frame → s12shot7_first_frame
 *   CharRef_vikram → CharRef_vikram  (unchanged; non-shot prefixes pass through)
 * Returns the trimmed original if the shot pattern doesn't match.
 * Exported for testing.
 */
export function shortenPrefix(prefix: string | undefined): string {
  if (!prefix) return '';
  return prefix
    .replace(/scene_(\d+)_shot_(\d+)/g, 's$1shot$2')
    // Filesystem-safe: collapse runs of whitespace/separators, strip anything weird
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Short, filesystem-friendly model tag derived from a workflow manifest ID.
 *   flux2_klein_edit_cloud → klein
 *   grok_image_edit → grok
 *   zimage_standard_cloud / zimage_cloud / zimage → zimage
 *   ltx23_fl2v_cloud / ltx23_fml2v_cloud → ltx23
 * Unknown workflow IDs fall through as the first segment before an underscore,
 * e.g. `custom_model_v2` → `custom`. Empty/undefined → empty string.
 * Exported for testing.
 */
export function shortModelName(workflowId: string | undefined): string {
  if (!workflowId) return '';
  const id = workflowId.toLowerCase();
  if (id.includes('klein')) return 'klein';
  if (id.includes('grok')) return 'grok';
  if (id.includes('zimage')) return 'zimage';
  if (id.startsWith('ltx')) return 'ltx23';
  if (id.includes('qwen')) return 'qwen';
  if (id.includes('flux')) return 'flux';
  // Fallback: first token before underscore
  return id.split('_')[0] ?? '';
}
