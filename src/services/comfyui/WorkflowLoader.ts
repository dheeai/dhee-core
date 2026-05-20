/**
 * Workflow template loader and parameterization utilities.
 *
 * Handles loading ComfyUI workflow JSON templates and injecting
 * dynamic parameters like prompts, dimensions, and sampling settings.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

// Debug logging to file instead of console to avoid polluting Ink UI
const DEBUG_LOG_PATH = path.join(process.cwd(), 'logs', 'debug.log');
function debugLog(message: string): void {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(DEBUG_LOG_PATH, `[${timestamp}] ${message}\n`);
  } catch {
    // Ignore logging errors
  }
}

// Get __dirname equivalent for ES modules
const currentDir =
  typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

/**
 * Get the workflows directory path.
 * Priority:
 * 1. dhee_WORKFLOWS_DIR environment variable (set by desktop app)
 * 2. Check if dhee-desktop/workflows exists (sibling directory)
 * 3. Check if dhee-core/workflows exists (current package)
 * 4. Fall back to process.cwd()/workflows (for CLI usage)
 */
function getWorkflowsDir(): string {
  // 1. Check environment variable (set by desktop app)
  const workflowsDirEnv = process.env['dhee_WORKFLOWS_DIR'];
  if (workflowsDirEnv) {
    const envPath = String(workflowsDirEnv).trim();
    if (envPath && fs.existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Try to find dhee-desktop/workflows (sibling directory)
  // This works when dhee-core is a dependency of dhee-desktop
  try {
    // In node_modules, we might be at dhee-desktop/node_modules/dhee-core
    // or in a monorepo structure
    let searchDir = currentDir;
    for (let i = 0; i < 5; i++) {
      const desktopWorkflows = path.join(searchDir, '..', '..', 'workflows');
      if (fs.existsSync(desktopWorkflows)) {
        const resolved = path.resolve(desktopWorkflows);
        if (fs.existsSync(resolved)) {
          return resolved;
        }
      }
      // Also check if we're in dhee-desktop/node_modules/dhee-core
      const altDesktopWorkflows = path.join(searchDir, '..', '..', '..', 'workflows');
      if (fs.existsSync(altDesktopWorkflows)) {
        const resolved = path.resolve(altDesktopWorkflows);
        if (fs.existsSync(resolved)) {
          return resolved;
        }
      }
      searchDir = path.dirname(searchDir);
    }
  } catch {
    // Ignore errors during path resolution
  }

  // 3. Try dhee-core/workflows (current package)
  // When running from source: src/services/comfyui/WorkflowLoader.ts -> workflows/
  // When running from dist: dist/services/comfyui/WorkflowLoader.js -> workflows/
  const inkWorkflows = path.resolve(currentDir, '..', '..', 'workflows');
  if (fs.existsSync(inkWorkflows)) {
    return inkWorkflows;
  }

  // 4. Fall back to process.cwd()/workflows (for CLI usage in current directory)
  // This allows CLI users to have workflows in their project directory
  return path.resolve(process.cwd(), 'workflows');
}

/**
 * Load a workflow JSON template from the workflows directory.
 */
export function loadWorkflowTemplate(templateName: string): WorkflowTemplate {
  // Resolve at call time so updates to dhee_WORKFLOWS_DIR (via settings restart) are honored
  const templatePath = path.join(getWorkflowsDir(), templateName);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Workflow template not found: ${templatePath}`);
  }

  const content = fs.readFileSync(templatePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Convert aspect ratio string to width and height dimensions.
 */
export function aspectRatioToDimensions(aspectRatio: string): [number, number] {
  const ratioMap: Record<string, [number, number]> = {
    '16:9': [1536, 864],
    '9:16': [864, 1536],
    '1:1': [1024, 1024],
    '4:3': [1366, 1024],
    '3:4': [1024, 1366],
  };
  return ratioMap[aspectRatio] || [1024, 1024];
}

export interface WorkflowParams {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  filenamePrefix?: string;
  /** Primary input image filename (for single-image workflows) */
  inputImageFilename?: string;
  /** Additional reference image filenames (for qwen_edit - up to 3 total) */
  referenceImageFilenames?: string[];
}

export interface LtxWorkflowParams {
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  filenamePrefix?: string;
  width?: number;
  height?: number;
  frameCount?: number;
  inputImageFilename?: string;
  /** Duration in seconds for LTX-2.3 (1-20, default 10) */
  durationSeconds?: number;
  /** Text-to-video mode (true = T2V, false = I2V). Default false. */
  t2vMode?: boolean;
}

export interface Ltx23WorkflowBindings {
  durationNodeId: number;
  widthNodeId: number;
  heightNodeId: number;
  positivePromptNodeId: number;
  negativePromptNodeId: number | null;
  inputImageNodeId: number;
  t2vModeNodeId: number;
  outputNodeId: number;
}

function getNodeWidgetText(node: {
  widgets_values?: unknown[] | Record<string, unknown>;
}): string {
  const widgetValues = node.widgets_values;
  if (!Array.isArray(widgetValues) || widgetValues.length === 0) {
    return '';
  }
  const firstValue = widgetValues[0];
  return typeof firstValue === 'string' ? firstValue : String(firstValue ?? '');
}

function looksLikeNegativePrompt(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('blurry') ||
    normalized.includes('oversaturated') ||
    normalized.includes('watermark') ||
    normalized.includes('artifacts')
  );
}

function findUniqueNode(
  nodes: NonNullable<WorkflowTemplate['nodes']>,
  description: string,
  predicate: (node: NonNullable<WorkflowTemplate['nodes']>[number]) => boolean
): NonNullable<WorkflowTemplate['nodes']>[number] {
  const matches = nodes.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(
      `Invalid ltx23 workflow: expected exactly one ${description} node, found ${matches.length}`
    );
  }
  return matches[0]!;
}

export function validateLtx23WorkflowTemplate(
  template: WorkflowTemplate
): Ltx23WorkflowBindings {
  const nodes = template.nodes || [];
  if (nodes.length === 0) {
    throw new Error('Invalid ltx23 workflow: template has no nodes');
  }

  const durationNode = findUniqueNode(
    nodes,
    'duration',
    node => node.type === 'INTConstant' && node.title === 'LENGTH (in seconds)'
  );
  const widthNode = findUniqueNode(
    nodes,
    'width',
    node => node.type === 'INTConstant' && node.title === 'WIDTH'
  );
  const heightNode = findUniqueNode(
    nodes,
    'height',
    node => node.type === 'INTConstant' && node.title === 'HEIGHT'
  );
  const inputImageNode = findUniqueNode(
    nodes,
    'input image',
    node => node.type === 'LoadImage'
  );
  const t2vModeNode = findUniqueNode(
    nodes,
    'text-to-video toggle',
    node => node.type === 'PrimitiveBoolean' && (node.title || '').includes('Text To Video')
  );
  const outputNode = findUniqueNode(
    nodes,
    'video output',
    node => node.type === 'VHS_VideoCombine'
  );

  const promptNodes = nodes.filter(node => node.type === 'CLIPTextEncode');
  if (promptNodes.length < 2) {
    throw new Error(
      `Invalid ltx23 workflow: expected at least two CLIPTextEncode nodes, found ${promptNodes.length}`
    );
  }

  const negativePromptNode =
    promptNodes.find(node => looksLikeNegativePrompt(getNodeWidgetText(node))) || null;
  const positivePromptCandidates = promptNodes.filter(
    node => negativePromptNode == null || node.id !== negativePromptNode.id
  );

  if (positivePromptCandidates.length !== 1) {
    throw new Error(
      `Invalid ltx23 workflow: expected exactly one positive prompt node, found ${positivePromptCandidates.length}`
    );
  }

  return {
    durationNodeId: durationNode.id,
    widthNodeId: widthNode.id,
    heightNodeId: heightNode.id,
    positivePromptNodeId: positivePromptCandidates[0]!.id,
    negativePromptNodeId: negativePromptNode?.id ?? null,
    inputImageNodeId: inputImageNode.id,
    t2vModeNodeId: t2vModeNode.id,
    outputNodeId: outputNode.id,
  };
}

/**
 * Parameterize Z-Image workflow.
 */
export function parameterizeZImageWorkflow(
  template: WorkflowTemplate,
  params: WorkflowParams
): Record<string, unknown> {
  // Deep copy
  let workflow = JSON.parse(JSON.stringify(template));

  // Convert to API format if it's LiteGraph format
  if ('nodes' in workflow && 'links' in workflow) {
    workflow = workflowToPrompt(workflow);
  }

  // Remove Note nodes
  workflow = Object.fromEntries(
    Object.entries(workflow).filter(([, v]) => {
      const node = v as { class_type?: string };
      return node.class_type !== 'Note';
    })
  );

  // Randomize seed if not provided
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
  const negPrompt = params.negativePrompt || 'blurry ugly bad';

  // Find and update nodes by class_type
  for (const [, node] of Object.entries(workflow)) {
    const nodeData = node as { class_type?: string; inputs?: Record<string, unknown> };
    const classType = nodeData.class_type;
    const inputs = nodeData.inputs || {};

    if (classType === 'CLIPTextEncode') {
      const currentText = (inputs['text'] as string) || '';
      if (currentText.toLowerCase().includes('blurry') ||
          currentText.toLowerCase().includes('ugly') ||
          currentText.toLowerCase().includes('bad')) {
        inputs['text'] = negPrompt;
      } else {
        inputs['text'] = params.prompt;
      }
    } else if (classType === 'EmptySD3LatentImage') {
      inputs['width'] = params.width || 1024;
      inputs['height'] = params.height || 1024;
      inputs['batch_size'] = 1;
    } else if (classType === 'KSampler') {
      inputs['seed'] = seed;
      inputs['steps'] = params.steps || 9;
      inputs['cfg'] = params.cfg || 1.0;
      inputs['denoise'] = 1.0;
    } else if (classType === 'SaveImage') {
      inputs['filename_prefix'] = params.filenamePrefix || 'ZImage';
    }
  }

  // [ZIMAGE_PROMPT_TRACE] Dump final positive + negative texts post-
  // parameterization so we can diff what kshana actually submits against
  // what disk says. Surfaces caching / wrong-prompt-substitution bugs in
  // the character_image path (officer-as-Doraemon, 2026-05-19).
  try {
    let positiveText = '';
    let negativeText = '';
    for (const [nodeId, node] of Object.entries(workflow)) {
      const n = node as { class_type?: string; inputs?: Record<string, unknown> };
      if (n.class_type !== 'CLIPTextEncode') continue;
      const t = (n.inputs?.['text'] as string) || '';
      const tag = t.toLowerCase().includes('blurry') || t.toLowerCase().includes('ugly') || t.toLowerCase().includes('bad')
        ? 'NEG'
        : 'POS';
      if (tag === 'POS') positiveText = t;
      else negativeText = t;
      debugLog(`[ZIMAGE_PROMPT_TRACE] node=${nodeId} class=CLIPTextEncode tag=${tag} text_first_160="${t.slice(0, 160)}" text_len=${t.length}`);
    }
    const posMd5 = createHash('md5').update(positiveText).digest('hex').slice(0, 12);
    const negMd5 = createHash('md5').update(negativeText).digest('hex').slice(0, 12);
    debugLog(`[ZIMAGE_PROMPT_TRACE] seed=${seed} filename_prefix="${params.filenamePrefix ?? 'ZImage'}" pos_md5=${posMd5} neg_md5=${negMd5}`);
  } catch (err) {
    debugLog(`[ZIMAGE_PROMPT_TRACE] failed: ${(err as Error).message}`);
  }

  return workflow;
}

/**
 * Parameterize Chroma-Radiance workflow.
 */
export function parameterizeChromaRadianceWorkflow(
  template: WorkflowTemplate,
  params: WorkflowParams
): Record<string, unknown> {
  // Deep copy
  let workflow = JSON.parse(JSON.stringify(template));

  // Convert to API format if it's LiteGraph format
  if ('nodes' in workflow && 'links' in workflow) {
    workflow = workflowToPrompt(workflow);
  }

  // Remove Note nodes
  workflow = Object.fromEntries(
    Object.entries(workflow).filter(([, v]) => {
      const node = v as { class_type?: string };
      return !['Note', 'MarkdownNote'].includes(node.class_type || '');
    })
  );

  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);

  for (const [, node] of Object.entries(workflow)) {
    const nodeData = node as { class_type?: string; inputs?: Record<string, unknown> };
    const classType = nodeData.class_type;
    const inputs = nodeData.inputs || {};

    if (classType === 'CLIPTextEncode') {
      const currentText = (inputs['text'] as string) || '';
      const isNegative = currentText.toLowerCase().includes('blurry') ||
                        currentText.toLowerCase().includes('ugly') ||
                        currentText.toLowerCase().includes('bad') ||
                        currentText.toLowerCase().includes('worst');
      if (isNegative) {
        if (params.negativePrompt) {
          inputs['text'] = params.negativePrompt;
        }
      } else {
        inputs['text'] = params.prompt;
      }
    } else if (classType === 'EmptyChromaRadianceLatentImage') {
      inputs['width'] = params.width || 1024;
      inputs['height'] = params.height || 1024;
      inputs['batch_size'] = 1;
    } else if (classType === 'RandomNoise') {
      inputs['noise_seed'] = seed;
    } else if (classType === 'SaveImage') {
      inputs['filename_prefix'] = params.filenamePrefix || 'Chroma';
    }
  }

  return workflow;
}

/**
 * Parameterize Qwen Edit Simple workflow for image editing.
 * Takes a base image and up to 2 additional reference images.
 * Uses qwen_edit-simple.json which has no rgthree dependencies.
 *
 * Image slots:
 * - Node 4: Primary image (required) - the main image being edited
 * - Node 5: Optional 2nd reference image (e.g., character reference)
 * - Node 6: Optional 3rd reference image (e.g., setting reference)
 */
export function parameterizeQwenEditWorkflow(
  template: WorkflowTemplate,
  params: WorkflowParams
): Record<string, unknown> {
  // Deep copy
  const workflow: WorkflowTemplate = JSON.parse(JSON.stringify(template));
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);

  // Get all reference images (primary + additional)
  const allImages: string[] = [];
  if (params.inputImageFilename) {
    allImages.push(params.inputImageFilename);
  }
  if (params.referenceImageFilenames) {
    allImages.push(...params.referenceImageFilenames);
  }

  // Simple workflow node IDs: 4 = primary, 5 = ref2, 6 = ref3
  const loadImageNodeIds = [4, 5, 6];

  // Track which nodes to remove (bypassed LoadImage nodes break connections)
  const nodesToRemove = new Set<number>();

  // Modify the LiteGraph format
  for (const node of workflow.nodes || []) {
    const nodeId = node.id;
    const nodeType = node.type;

    // LoadImage nodes - assign images in order
    if (nodeType === 'LoadImage') {
      const nodeIndex = loadImageNodeIds.indexOf(nodeId);
      if (nodeIndex !== -1 && nodeIndex < allImages.length) {
        const imageName = allImages[nodeIndex];
        if (node.widgets_values && imageName) {
          node.widgets_values[0] = imageName;
          (node as { mode?: number }).mode = 0; // Enable
        }
      } else if (nodeIndex !== -1) {
        // No image for this slot - mark for removal
        nodesToRemove.add(nodeId);
      }
    }

    // Positive prompt (node 11)
    if (nodeType === 'TextEncodeQwenImageEditPlus' && nodeId === 11) {
      if (node.widgets_values) {
        node.widgets_values[0] = params.prompt;
      }
    }

    // Negative prompt (node 12)
    if (nodeType === 'TextEncodeQwenImageEditPlus' && nodeId === 12) {
      if (node.widgets_values && params.negativePrompt) {
        node.widgets_values[0] = params.negativePrompt;
      }
    }

    // KSampler (node 13) - set seed
    if (nodeType === 'KSampler' && nodeId === 13) {
      if (node.widgets_values) {
        node.widgets_values[0] = seed;
      }
    }

    // SaveImage (node 15) - set filename prefix
    if (nodeType === 'SaveImage' && nodeId === 15) {
      if (node.widgets_values) {
        node.widgets_values[0] = params.filenamePrefix || 'QwenEdit';
      }
    }
  }

  // Remove unused LoadImage nodes
  workflow.nodes = (workflow.nodes || []).filter(node => !nodesToRemove.has(node.id));

  // Remove links connected to removed nodes
  workflow.links = (workflow.links || []).filter(link => {
    const sourceNode = link[1];
    return !nodesToRemove.has(sourceNode);
  });

  // Convert to API format
  const apiWorkflow = workflowToPrompt(workflow);

  return apiWorkflow;
}

/**
 * Parameterize LTX-2.3 GGUF workflow.
 * Flat workflow using GetNode/SetNode pattern — no subgraph expansion needed.
 * Supports both I2V and T2V via a boolean toggle (node 290).
 * Duration is in seconds (node 291), frame count is calculated automatically.
 *
 * Key nodes:
 * - 291: INTConstant "LENGTH (in seconds)" — video duration
 * - 292: INTConstant "WIDTH"
 * - 293: INTConstant "HEIGHT"
 * - 121: CLIPTextEncode — positive prompt
 * - 110: CLIPTextEncode — negative prompt (left as-is, has good defaults)
 * - 167: LoadImage — input image
 * - 290: PrimitiveBoolean "Text To Video (no image ref)" — T2V toggle
 * - 140: VHS_VideoCombine — output video
 */
export function parameterizeLtx23Workflow(
  template: WorkflowTemplate,
  params: LtxWorkflowParams
): Record<string, unknown> {
  // Deep copy
  const workflow: WorkflowTemplate = JSON.parse(JSON.stringify(template));
  const bindings = validateLtx23WorkflowTemplate(workflow);

  const durationSeconds = Math.min(Math.max(params.durationSeconds ?? 10, 1), 20);
  const t2vMode = params.t2vMode ?? false;
  const width = params.width || 1280;
  const height = params.height || 720;

  for (const node of workflow.nodes || []) {
    const nodeId = node.id;

    if (nodeId === bindings.durationNodeId && node.widgets_values) {
      node.widgets_values[0] = durationSeconds;
      debugLog(`[Ltx23] Set duration (node ${bindings.durationNodeId}) to ${durationSeconds}s`);
    }
    else if (nodeId === bindings.widthNodeId && node.widgets_values) {
      node.widgets_values[0] = width;
      debugLog(`[Ltx23] Set width (node ${bindings.widthNodeId}) to ${width}`);
    }
    else if (nodeId === bindings.heightNodeId && node.widgets_values) {
      node.widgets_values[0] = height;
      debugLog(`[Ltx23] Set height (node ${bindings.heightNodeId}) to ${height}`);
    }
    else if (nodeId === bindings.positivePromptNodeId && node.widgets_values) {
      node.widgets_values[0] = params.prompt;
      debugLog(
        `[Ltx23] Set positive prompt (node ${bindings.positivePromptNodeId}): "${(params.prompt || '').substring(0, 50)}..."`
      );
    }
    // Node 110: Negative prompt — leave as-is (workflow has good built-in defaults)

    // Node 165: ImageResizeKJv2 — fix interpolation method for quality downscaling
    else if (nodeId === 165 && node.widgets_values) {
      // widgets_values: [width, height, upscale_method, keep_proportion, pad_color, crop_position, divisible_by, device]
      node.widgets_values[2] = 'lanczos';  // was 'nearest-exact' — lanczos is best for downscaling
      debugLog(`[Ltx23] Set resize method (node 165) to lanczos`);
    }
    // Node 167: Input image
    else if (nodeId === 167 && node.widgets_values && params.inputImageFilename) {
      node.widgets_values[0] = params.inputImageFilename;
      debugLog(
        `[Ltx23] Set input image (node ${bindings.inputImageNodeId}) to: ${params.inputImageFilename}`
      );
    }
    // Node 290: T2V mode toggle (controls start frame bypass via node 160)
    else if (nodeId === 290 && node.widgets_values) {
      node.widgets_values[0] = t2vMode;
      debugLog(`[Ltx23] Set T2V mode (node ${bindings.t2vModeNodeId}) to: ${t2vMode}`);
    }
    else if (nodeId === bindings.outputNodeId && node.widgets_values) {
      const prefix = params.filenamePrefix ? `video/${params.filenamePrefix}` : 'video/LTX23';
      if (typeof node.widgets_values === 'object' && !Array.isArray(node.widgets_values)) {
        (node.widgets_values as Record<string, unknown>)['filename_prefix'] = prefix;
      }
      debugLog(
        `[Ltx23] Set VHS_VideoCombine (node ${bindings.outputNodeId}) filename_prefix to: ${prefix}`
      );
    }
  }

  // Resolve SetNode/GetNode virtual nodes before API conversion
  const resolvedWorkflow = resolveSetGetNodes(workflow);

  // No subgraph expansion needed — this is a flat workflow
  const apiWorkflow = workflowToPrompt(resolvedWorkflow);

  const setApiInput = (nodeId: number, inputName: string, value: unknown): void => {
    const node = apiWorkflow[String(nodeId)] as { inputs?: Record<string, unknown> } | undefined;
    if (!node) {
      throw new Error(
        `Invalid ltx23 workflow: API prompt missing node ${nodeId} for input "${inputName}"`
      );
    }
    node.inputs = node.inputs || {};
    node.inputs[inputName] = value;
  };

  setApiInput(bindings.durationNodeId, 'value', durationSeconds);
  setApiInput(bindings.widthNodeId, 'value', width);
  setApiInput(bindings.heightNodeId, 'value', height);
  setApiInput(bindings.positivePromptNodeId, 'text', params.prompt);
  if (bindings.negativePromptNodeId != null && params.negativePrompt) {
    setApiInput(bindings.negativePromptNodeId, 'text', params.negativePrompt);
  }
  if (params.inputImageFilename) {
    const node167 = apiWorkflow['167'] as { inputs?: Record<string, unknown> } | undefined;
    if (node167) {
      node167.inputs = node167.inputs || {};
      node167.inputs['image'] = params.inputImageFilename;
    }
  }
  const node290 = apiWorkflow['290'] as { inputs?: Record<string, unknown> } | undefined;
  if (node290) {
    node290.inputs = node290.inputs || {};
    node290.inputs['value'] = t2vMode;
  }
  // In I2V mode, both node 160 and 161 must be active:
  // Node 161 injects the image into pass 1 (initial generation)
  // Node 160 injects the image into pass 2 (upscale/refine)
  // Both use the same source image as the start frame reference.
  // The t2v_mode boolean already controls bypass for both nodes.
  const node140 = apiWorkflow['140'] as { inputs?: Record<string, unknown> } | undefined;
  if (node140) {
    node140.inputs = node140.inputs || {};
    node140.inputs['filename_prefix'] = params.filenamePrefix ? `video/${params.filenamePrefix}` : 'video/LTX23';
  }
  setApiInput(bindings.t2vModeNodeId, 'value', t2vMode);
  setApiInput(
    bindings.outputNodeId,
    'filename_prefix',
    params.filenamePrefix ? `video/${params.filenamePrefix}` : 'video/LTX23'
  );

  // Explicitly set bypass on I2V nodes based on t2v mode.
  // The node-format links (GetNode → bypass) don't propagate in API format,
  // so we must set them directly.
  const node160api = apiWorkflow['160'] as { inputs?: Record<string, unknown> } | undefined;
  const node161api = apiWorkflow['161'] as { inputs?: Record<string, unknown> } | undefined;
  if (t2vMode) {
    if (node160api) { node160api.inputs = node160api.inputs || {}; node160api.inputs['bypass'] = true; }
    if (node161api) { node161api.inputs = node161api.inputs || {}; node161api.inputs['bypass'] = true; }
    debugLog(`[Ltx23] T2V mode — bypassing both I2V nodes (160, 161)`);
  }

  // Debug: log start/end frame node state
  debugLog(`[Ltx23] Node 160 (start frame): ${JSON.stringify(node160api?.inputs)}`);
  debugLog(`[Ltx23] Node 161 (end frame): ${JSON.stringify(node161api?.inputs)}`);

  // Remove non-essential nodes
  const nodesToRemove = ['Note', 'MarkdownNote'];
  for (const [nodeId, node] of Object.entries(apiWorkflow)) {
    const nodeData = node as { class_type?: string };
    if (nodesToRemove.includes(nodeData.class_type || '')) {
      delete apiWorkflow[nodeId];
      debugLog(`[Ltx23] Removed non-essential node ${nodeId} (${nodeData.class_type})`);
    }
  }

  // Remove ALL LoRA nodes — the base GGUF model is already distilled, no LoRAs needed.
  // Rewire: node 330 (UnetLoaderGGUF) → node 303 (SetNode 'model_with_lora')
  // Chain was: 330 → 134 (LoraLoaderModelOnly) → 301 (Power Lora Loader) → 303
  const node303 = apiWorkflow['303'] as { inputs?: Record<string, unknown> } | undefined;
  if (node303 && apiWorkflow['134']) {
    // Point SetNode directly to the base model loader
    node303.inputs = node303.inputs || {};
    node303.inputs['value'] = ['330', 0];
    // Remove LoRA nodes
    delete apiWorkflow['134'];
    delete apiWorkflow['301'];
    debugLog(`[Ltx23] Removed LoRA nodes 134, 301 — wired model 330 → 303 directly`);
  }

  // Bypass any remaining LoraLoaderModelOnly nodes with lora_name "None"
  bypassLoraLoaderNodesWithNone(apiWorkflow);

  return apiWorkflow;
}

/**
 * Apply a flat list of parameter mappings directly to an API-format workflow.
 * Lower-level helper than `parameterizeGeneric` (below): expects the workflow
 * to already be in API format and the mappings to be a plain array, with no
 * promptKeywords / template-format handling. Used by the cloud-format
 * fast paths (e.g. ltx23_fl2v_cloud) where the manifest is read inline.
 */
export function applyParameterMappings(
  apiWorkflow: Record<string, unknown>,
  mappings: Array<{ input: string; nodeId: string; field: string }>,
  params: Record<string, unknown>
): Record<string, unknown> {
  for (const mapping of mappings) {
    const value = params[mapping.input];
    if (value === undefined || value === null) continue;

    const node = apiWorkflow[mapping.nodeId] as { inputs?: Record<string, unknown> } | undefined;
    if (!node) {
      debugLog(`[applyParameterMappings] Warning: node ${mapping.nodeId} not found in workflow`);
      continue;
    }
    node.inputs = node.inputs || {};
    node.inputs[mapping.field] = value;
    debugLog(
      `[applyParameterMappings] Set node ${mapping.nodeId}.inputs.${mapping.field} = ${JSON.stringify(value)}`
    );
  }
  return apiWorkflow;
}

/**
 * Parameterize the qwen_edit_native workflow (qwen_edit_native.json).
 *
 * Layout:
 *   - Node 1: UNETLoader (Qwen-Image-Edit-2511 FP8)
 *   - Node 5: LoraLoaderModelOnly (Lightning 4-step LoRA, strength 1.0)
 *   - Node 4: LoadImage primary (base) — fed into ImageScale → image1 slot
 *   - Node 21: LoadImage ref 1 → image2 slot
 *   - Node 22: LoadImage ref 2 → image3 slot
 *   - Node 11: TextEncodeQwenImageEditPlus (positive)
 *   - Node 12: TextEncodeQwenImageEditPlus (negative)
 *   - Node 13: KSampler (cfg=1, steps=8, euler/simple)
 *   - Node 15: SaveImage
 *
 * 3 image slots only; caller must route to Klein when total > 3
 * (see `chooseImageEditWorkflow`).
 */
export function parameterizeQwenEditNativeWorkflow(
  template: WorkflowTemplate,
  params: WorkflowParams
): Record<string, unknown> {
  const workflow: WorkflowTemplate = JSON.parse(JSON.stringify(template));
  // Lightning LoRA is 4-step calibrated but performs well at 8 with cfg=1.
  // Cap seed at int32 — ComfyUI Cloud's Grok variant rejects larger values.
  const seed = params.seed ?? Math.floor(Math.random() * 0x7FFFFFFF);

  // Slot order: [base, ref1, ref2] mapped to LoadImage IDs [4, 21, 22].
  const allImages: string[] = [];
  if (params.inputImageFilename) allImages.push(params.inputImageFilename);
  if (params.referenceImageFilenames) {
    allImages.push(...params.referenceImageFilenames);
  }
  const loadImageNodeIds = [4, 21, 22];
  const nodesToRemove = new Set<number>();

  for (const node of workflow.nodes || []) {
    const nodeId = node.id;
    const nodeType = node.type;

    if (nodeType === 'LoadImage') {
      const slot = loadImageNodeIds.indexOf(nodeId);
      if (slot !== -1 && slot < allImages.length) {
        const imageName = allImages[slot];
        if (node.widgets_values && imageName) {
          node.widgets_values[0] = imageName;
          (node as { mode?: number }).mode = 0;
        }
      } else if (slot !== -1) {
        nodesToRemove.add(nodeId);
      }
    }

    if (nodeType === 'TextEncodeQwenImageEditPlus' && nodeId === 11) {
      if (node.widgets_values) node.widgets_values[0] = params.prompt;
    }
    if (nodeType === 'TextEncodeQwenImageEditPlus' && nodeId === 12) {
      if (node.widgets_values && params.negativePrompt) {
        node.widgets_values[0] = params.negativePrompt;
      }
    }

    if (nodeType === 'KSampler' && nodeId === 13) {
      if (node.widgets_values) node.widgets_values[0] = seed;
    }

    if (nodeType === 'SaveImage' && nodeId === 15) {
      if (node.widgets_values) {
        node.widgets_values[0] = params.filenamePrefix || 'QwenEditNative';
      }
    }
  }

  workflow.nodes = (workflow.nodes || []).filter((n) => !nodesToRemove.has(n.id));
  workflow.links = (workflow.links || []).filter((l) => !nodesToRemove.has(l[1]));

  return workflowToPrompt(workflow);
}

/**
 * Route to the correct parameterization function based on workflow name.
 */
export function parameterizeWorkflowByName(
  workflowName: string,
  template: WorkflowTemplate,
  params: {
    sceneNumber: number;
    prompt: string;
    negativePrompt?: string;
    aspectRatio?: string;
    /** Override width in pixels (takes precedence over aspectRatio) */
    width?: number;
    /** Override height in pixels (takes precedence over aspectRatio) */
    height?: number;
    style?: string;
    seed?: number;
    inputImageFilename?: string;
    /** Additional reference image filenames (for qwen_edit - up to 3 total including inputImageFilename) */
    referenceImageFilenames?: string[];
    startImageFilename?: string;
    endImageFilename?: string;
    filenamePrefix?: string;
  }
): Record<string, unknown> | WorkflowTemplate {
  const aspectRatio = params.aspectRatio || '16:9';
  const filenamePrefix = params.filenamePrefix || `Scene${params.sceneNumber}`;

  if (workflowName === 'chroma_radiance') {
    let [width, height] = params.width && params.height
      ? [params.width, params.height]
      : [1024, 1024];
    if (!params.width) {
      if (aspectRatio === '16:9') [width, height] = [1536, 864];
      else if (aspectRatio === '9:16') [width, height] = [864, 1536];
      else if (aspectRatio === '4:3') [width, height] = [1366, 1024];
      else if (aspectRatio === '3:4') [width, height] = [1024, 1366];
    }

    return parameterizeChromaRadianceWorkflow(template, {
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      width,
      height,
      seed: params.seed,
      filenamePrefix,
    });
  } else if (workflowName === 'zimage') {
    let [width, height] = params.width && params.height
      ? [params.width, params.height]
      : [1024, 1024];
    if (!params.width) {
      if (aspectRatio === '16:9') [width, height] = [1536, 864];
      else if (aspectRatio === '9:16') [width, height] = [864, 1536];
      else if (aspectRatio === '4:3') [width, height] = [1366, 1024];
      else if (aspectRatio === '3:4') [width, height] = [1024, 1366];
    }

    return parameterizeZImageWorkflow(template, {
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      width,
      height,
      seed: params.seed,
      steps: 9,
      cfg: 1.0,
      filenamePrefix,
    });
  } else if (workflowName === 'qwen_edit') {
    // Qwen Edit workflow for image-to-image editing (supports up to 3 images)
    if (!params.inputImageFilename) {
      throw new Error('qwen_edit workflow requires inputImageFilename');
    }
    return parameterizeQwenEditWorkflow(template, {
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      seed: params.seed,
      filenamePrefix,
      inputImageFilename: params.inputImageFilename,
      referenceImageFilenames: params.referenceImageFilenames,
    });
  } else if (workflowName === 'qwen_edit_native') {
    // Qwen Edit native — uses the stock TextEncodeQwenImageEditPlus
    // (3 image slots) + Lightning LoRA. Empirically cleaner identity
    // preservation than the lrzjason 5-slot variant; preferred for
    // ≤3 ref scenes per `chooseImageEditWorkflow`.
    if (!params.inputImageFilename) {
      throw new Error('qwen_edit_native workflow requires inputImageFilename');
    }
    return parameterizeQwenEditNativeWorkflow(template, {
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      seed: params.seed,
      filenamePrefix,
      inputImageFilename: params.inputImageFilename,
      referenceImageFilenames: params.referenceImageFilenames,
    });
  } else if (workflowName === 'ltx23') {
    // LTX-2.3 FL2V Cloud workflow — image + text prompt → video
    const extParams = params as {
      durationSeconds?: number;
      width?: number;
      height?: number;
    };
    const width = extParams.width || (params.aspectRatio === '9:16' ? 720 : 1280);
    const height = extParams.height || (params.aspectRatio === '9:16' ? 1280 : 720);

    // Load manifest to get parameterMappings
    const manifestPath = path.join(
      getWorkflowsDir(),
      'cloud',
      'ltx23_fl2v_cloud.manifest.json'
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      parameterMappings: Array<{ input: string; nodeId: string; field: string }>;
    };

    // Cloud workflow is already in API format — use template directly as the API workflow
    const apiWorkflow = template as unknown as Record<string, unknown>;

    return applyParameterMappings(apiWorkflow, manifest.parameterMappings, {
      prompt: params.prompt,
      negative_prompt: params.negativePrompt,
      first_frame: params.inputImageFilename,
      // When no last_frame is provided, mirror first_frame so the cloud node
      // always has a valid uploaded image (avoids "file doesn't exist" errors)
      last_frame: params.endImageFilename ?? params.inputImageFilename,
      durationSeconds: extParams.durationSeconds ?? 10,
      width,
      height,
      filenamePrefix: `video/${filenamePrefix}`,
    });
  }

  // Fallback: try generic manifest-driven parameterization
  try {
    const { getWorkflowModeRegistry } = require('../providers/WorkflowModeRegistry.js');
    const registry = getWorkflowModeRegistry();
    const mode = registry.getMode(workflowName);
    if (mode && mode.parameterMappings.length > 0) {
      return parameterizeGeneric(template, mode, params);
    }
  } catch { /* registry not available */ }

  // Last resort: return template as-is
  return template;
}

/**
 * Generic parameterizer: applies declarative parameter mappings from a manifest
 * to a workflow template. Works with both LiteGraph and API format workflows.
 *
 * Used for user-uploaded workflows that have no hardcoded parameterize function.
 */
/**
 * Resolve a manifest `nodeId` spec to an actual API-workflow node key.
 *
 * Manifests can name the target node three ways:
 *  - Literal key:                "16"                          → return "16" if present
 *  - Wildcard by class_type:     "*KSampler"                   → first node where class_type === KSampler
 *  - Wildcard with title tag:    "*CLIPTextEncode:positive"    → first CLIPTextEncode whose
 *                                                                _meta.title (or inputs.text fallback)
 *                                                                matches the tag
 *
 * Title tags recognized today: `positive`, `negative`.
 *
 * This was missing before 2026-05-19 — `parameterizeGeneric` did a literal lookup of
 * `"*CLIPTextEncode:positive"`, never matched any node, and silently applied zero
 * parameters. The Z-Image character_image path then ran every submission with the
 * template's defaults (fixed seed, empty positive prompt, default "blurry ugly bad"
 * negative) → byte-identical Doraemon output every time, regardless of officer.json.
 *
 * Returns null when no node matches. Callers should warn so future manifest typos
 * don't silently degrade to template defaults.
 */
function resolveManifestNodeId(
  spec: string,
  apiWorkflow: Record<string, unknown>,
): string | null {
  // Literal key path
  if (!spec.startsWith('*')) {
    return apiWorkflow[spec] ? spec : null;
  }

  // Wildcard parse: "*ClassName" or "*ClassName:tag"
  const rest = spec.slice(1);
  const colonIdx = rest.indexOf(':');
  const targetClass = colonIdx === -1 ? rest : rest.slice(0, colonIdx);
  const tag = colonIdx === -1 ? null : rest.slice(colonIdx + 1).toLowerCase();

  for (const [nodeId, raw] of Object.entries(apiWorkflow)) {
    const node = raw as {
      class_type?: string;
      _meta?: { title?: string };
      inputs?: Record<string, unknown>;
    };
    if (node.class_type !== targetClass) continue;
    if (!tag) return nodeId;

    const title = (node._meta?.title ?? '').toLowerCase();
    if (title.includes(tag)) return nodeId;

    // Fallback heuristic for CLIPTextEncode when titles aren't set:
    // a node whose current text mentions "blurry/ugly/bad" is the negative.
    if (targetClass === 'CLIPTextEncode') {
      const currentText = ((node.inputs?.['text'] as string) ?? '').toLowerCase();
      const looksNegative =
        currentText.includes('blurry') ||
        currentText.includes('ugly') ||
        currentText.includes('bad') ||
        currentText.includes('worst');
      if (tag === 'negative' && looksNegative) return nodeId;
      if (tag === 'positive' && !looksNegative) return nodeId;
    }
  }
  return null;
}

export function parameterizeGeneric(
  template: WorkflowTemplate | Record<string, unknown>,
  manifest: {
    parameterMappings: Array<{ input: string; nodeId: string; field: string; defaultValue?: unknown }>;
    promptKeywords?: { prepend?: string; append?: string; negativeAppend?: string };
  },
  params: Record<string, unknown>,
): Record<string, unknown> {
  // Deep copy
  const raw = JSON.parse(JSON.stringify(template));

  // Detect format: LiteGraph has 'nodes' array, API format is a flat node map
  const isLiteGraph = Array.isArray(raw.nodes);
  const apiWorkflow: Record<string, unknown> = isLiteGraph
    ? workflowToPrompt(raw as WorkflowTemplate)
    : raw;

  for (const mapping of manifest.parameterMappings) {
    // Use runtime value if provided, otherwise use default from manifest
    const value = params[mapping.input] ?? (mapping as { defaultValue?: unknown }).defaultValue;
    if (value === undefined) continue;

    const resolvedNodeId = resolveManifestNodeId(mapping.nodeId, apiWorkflow);
    if (!resolvedNodeId) {
      debugLog(`[parameterizeGeneric] WARN: nodeId "${mapping.nodeId}" did not match any node — input "${mapping.input}" SKIPPED`);
      continue;
    }
    const node = apiWorkflow[resolvedNodeId] as { inputs?: Record<string, unknown> } | undefined;
    if (node) {
      node.inputs = node.inputs || {};
      node.inputs[mapping.field] = value;
    }
  }

  // Inject LoRA trigger keywords into prompt nodes if configured
  if (manifest.promptKeywords) {
    const kw = manifest.promptKeywords;
    for (const mapping of manifest.parameterMappings) {
      const resolvedNodeId = resolveManifestNodeId(mapping.nodeId, apiWorkflow);
      if (!resolvedNodeId) continue;
      if (mapping.input === 'prompt' || mapping.input === 'edit_prompt') {
        const node = apiWorkflow[resolvedNodeId] as { inputs?: Record<string, unknown> } | undefined;
        if (node?.inputs?.[mapping.field] && typeof node.inputs[mapping.field] === 'string') {
          const original = node.inputs[mapping.field] as string;
          node.inputs[mapping.field] =
            (kw.prepend ? kw.prepend + ', ' : '') +
            original +
            (kw.append ? ', ' + kw.append : '');
        }
      }
      if (mapping.input === 'negative_prompt' && kw.negativeAppend) {
        const node = apiWorkflow[resolvedNodeId] as { inputs?: Record<string, unknown> } | undefined;
        if (node?.inputs?.[mapping.field] && typeof node.inputs[mapping.field] === 'string') {
          node.inputs[mapping.field] = (node.inputs[mapping.field] as string) + ', ' + kw.negativeAppend;
        }
      }
    }
  }

  // Resolve "Anything Everywhere" implicit connections.
  // These extension nodes broadcast an output to all nodes that need a matching input type.
  // In the API format, these connections are implicit — we must make them explicit.
  resolveAnythingEverywhere(apiWorkflow);

  // Remove non-essential nodes (notes, "Anything Everywhere" after resolution)
  for (const [nodeId, node] of Object.entries(apiWorkflow)) {
    const nodeData = node as { class_type?: string };
    if (nodeData.class_type === 'Note' || nodeData.class_type === 'MarkdownNote' ||
        nodeData.class_type === 'Anything Everywhere' || nodeData.class_type === 'Anything Everywhere3') {
      delete apiWorkflow[nodeId];
    }
  }

  return apiWorkflow;
}

/**
 * Resolve "Anything Everywhere" implicit connections in API-format workflows.
 *
 * The "Anything Everywhere" ComfyUI extension broadcasts a node's output to
 * all nodes that have a matching unconnected input type. In the UI this works
 * automatically, but in API format the connections must be explicit.
 *
 * Strategy: for each "Anything Everywhere" node, find which output it broadcasts.
 * Then find all nodes with unconnected inputs that match that output type and
 * wire them up.
 */
function resolveAnythingEverywhere(workflow: Record<string, unknown>): void {
  // Known input type → class_type mappings for auto-connection
  const INPUT_TYPE_MAP: Record<string, string[]> = {
    'CLIPTextEncode': ['clip'],
    'CLIPTextEncodeFlux': ['clip'],
    'TextEncodeQwenImageEditPlus': ['clip'],
    'KSampler': ['model'],
    'SamplerCustomAdvanced': ['model'],
    'VAEDecode': ['vae'],
    'VAEDecodeTiled': ['vae'],
    'VAEEncode': ['vae'],
    'LTXVImgToVideoInplace': ['vae'],
  };

  // Find all "Anything Everywhere" nodes and what they broadcast
  const broadcasts: Array<{ sourceNodeId: string; outputIndex: number }> = [];
  for (const [nodeId, nodeData] of Object.entries(workflow)) {
    const node = nodeData as { class_type?: string; inputs?: Record<string, unknown> };
    if (!node.class_type?.includes('Anything Everywhere')) continue;

    const inputs = node.inputs || {};
    for (const [, value] of Object.entries(inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
        broadcasts.push({ sourceNodeId: value[0], outputIndex: value[1] as number });
      }
    }
  }

  if (broadcasts.length === 0) return;

  // For each broadcast, find unconnected matching inputs and wire them
  for (const broadcast of broadcasts) {
    const sourceNode = workflow[broadcast.sourceNodeId] as { class_type?: string } | undefined;
    if (!sourceNode) continue;

    // Determine what type this node outputs based on class_type
    const sourceClass = sourceNode.class_type || '';

    for (const [nodeId, nodeData] of Object.entries(workflow)) {
      const node = nodeData as { class_type?: string; inputs?: Record<string, unknown> };
      if (!node.class_type || !node.inputs) continue;

      const requiredInputs = INPUT_TYPE_MAP[node.class_type];
      if (!requiredInputs) continue;

      for (const inputName of requiredInputs) {
        // Only connect if the input is not already connected
        const currentValue = node.inputs[inputName];
        if (currentValue !== undefined) continue; // already has a value or connection

        // Check if this broadcast source could provide this input type
        // CLIP loaders → clip inputs, model loaders → model inputs, VAE loaders → vae inputs
        const isClipSource = sourceClass.includes('CLIP') || sourceClass.includes('Clip');
        const isModelSource = sourceClass.includes('Model') || sourceClass.includes('UNET') || sourceClass.includes('Unet');
        const isVaeSource = sourceClass.includes('VAE') || sourceClass.includes('Vae');

        if ((inputName === 'clip' && isClipSource) ||
            (inputName === 'model' && isModelSource) ||
            (inputName === 'vae' && isVaeSource)) {
          node.inputs[inputName] = [broadcast.sourceNodeId, broadcast.outputIndex];
        }
      }
    }
  }
}

/**
 * Expand subgraphs in a workflow by replacing subgraph nodes with their internal nodes.
 * This is necessary because ComfyUI's API doesn't support subgraph nodes directly.
 */
export function expandSubgraphs(workflow: WorkflowTemplate): WorkflowTemplate {
  const definitions = workflow.definitions?.subgraphs || [];
  if (definitions.length === 0) {
    return workflow; // No subgraphs to expand
  }

  // Deep copy
  const expanded: WorkflowTemplate = JSON.parse(JSON.stringify(workflow));
  const mainNodes = expanded.nodes || [];
  const mainLinks = expanded.links || [];

  // Find the highest node ID in the main workflow to use as offset
  let maxNodeId = Math.max(...mainNodes.map(n => n.id), 0);
  let maxLinkId = Math.max(...mainLinks.map(l => l[0]), 0);

  // Process each subgraph node
  const subgraphNodes = mainNodes.filter(n =>
    n.type && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n.type)
  );

  for (const subgraphNode of subgraphNodes) {
    const subgraphDef = definitions.find(d => d.id === subgraphNode.type);
    if (!subgraphDef) {
      debugLog(`[expandSubgraphs] Warning: No definition found for subgraph ${subgraphNode.type}`);
      continue;
    }

    debugLog(`[expandSubgraphs] Expanding subgraph "${subgraphDef.name}" (node ${subgraphNode.id})`);

    // Get nodes and links from the subgraph definition
    const subNodes = (subgraphDef as { nodes?: Array<{ id: number; type: string; inputs?: Array<{ name: string; link?: number | null }>; widgets_values?: unknown[]; [key: string]: unknown }> }).nodes || [];
    const subInputs = (subgraphDef as { inputs?: Array<{ name: string; linkIds: number[] }> }).inputs || [];
    const subOutputs = (subgraphDef as { outputs?: Array<{ name: string; linkIds: number[] }> }).outputs || [];

    // Normalize subgraph links - they can be in object format or array format
    const rawSubLinks = (subgraphDef as { links?: unknown[] }).links || [];
    const subLinks: Array<[number, number, number, number, number, string]> = rawSubLinks.map(link => {
      if (Array.isArray(link)) {
        return link as [number, number, number, number, number, string];
      }
      // Object format: {id, origin_id, origin_slot, target_id, target_slot, type}
      const objLink = link as { id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number; type: string };
      return [objLink.id, objLink.origin_id, objLink.origin_slot, objLink.target_id, objLink.target_slot, objLink.type];
    });

    // Create ID mappings for remapping
    const nodeIdMap = new Map<number, number>();
    const linkIdMap = new Map<number, number>();

    // Remap node IDs (skip input/output virtual nodes -10, -20)
    for (const node of subNodes) {
      if (node.id < 0) continue; // Skip virtual I/O nodes
      const newId = ++maxNodeId;
      nodeIdMap.set(node.id, newId);
    }

    // Remap link IDs (only for non-virtual links)
    for (const link of subLinks) {
      const [, fromNode, , toNode] = link;
      if (fromNode >= 0 && toNode >= 0) {
        const newId = ++maxLinkId;
        linkIdMap.set(link[0], newId);
      }
    }

    // Build mapping: which proxy widget value goes to which internal node/input
    // proxyWidgets format: [[targetNode, inputName], ...] where targetNode === "-1" means external input
    const proxyWidgets = subgraphNode.properties?.proxyWidgets || [];
    const widgetValues = subgraphNode.widgets_values || [];

    // Map from (internal node id, input slot) -> value from proxy widget
    const inputValueMap = new Map<string, unknown>();

    for (let widgetIdx = 0; widgetIdx < proxyWidgets.length && widgetIdx < widgetValues.length; widgetIdx++) {
      const proxyWidget = proxyWidgets[widgetIdx];
      if (!proxyWidget || proxyWidget[0] !== '-1') continue;

      const inputName = proxyWidget[1];
      const value = widgetValues[widgetIdx];

      // Find the subgraph input with this name
      const subInput = subInputs.find(inp => inp.name === inputName);
      if (!subInput) continue;

      // Find links that carry this input value (from virtual node -10)
      for (const linkId of subInput.linkIds || []) {
        const link = subLinks.find(l => l[0] === linkId);
        if (link && link[1] === -10) {
          // This link goes from virtual input -10 to an internal node
          const [, , , targetNode, targetSlot] = link;
          if (targetNode > 0) {
            inputValueMap.set(`${targetNode}:${targetSlot}`, value);
            debugLog(`[expandSubgraphs] Mapped widget "${inputName}" -> node ${targetNode} slot ${targetSlot}: "${String(value).substring(0, 40)}..."`);
          }
        }
      }
    }

    // Add remapped nodes to main workflow
    for (const node of subNodes) {
      if (node.id < 0) continue; // Skip virtual I/O nodes

      // Deep copy the node
      const newNode = JSON.parse(JSON.stringify(node)) as typeof mainNodes[0];
      const oldId = node.id;
      newNode.id = nodeIdMap.get(oldId) || oldId;

      // Remap input links and update widget values
      if (newNode.inputs) {
        for (let inputIdx = 0; inputIdx < newNode.inputs.length; inputIdx++) {
          const input = newNode.inputs[inputIdx];
          if (!input) continue;
          
          const mapKey = `${oldId}:${inputIdx}`;
          const mappedValue = inputValueMap.get(mapKey);

          if (mappedValue !== undefined) {
            // This input receives a value from the proxy widget
            // Set the widget value at the appropriate position
            if (Array.isArray(newNode.widgets_values)) {
              updateNodeWidgetValue(newNode, input.name, mappedValue);
              debugLog(`[expandSubgraphs] Set node ${newNode.id} (${node.type}) input "${input.name}" = "${String(mappedValue).substring(0, 40)}..."`);
            }
            // Clear the link since we're providing the value via widget
            input.link = null;
          } else if (input.link != null) {
            // Remap the link ID if it's a valid internal link
            const newLinkId = linkIdMap.get(input.link);
            if (newLinkId !== undefined) {
              input.link = newLinkId;
            } else {
              // This link was from virtual node or not in subgraph, clear it
              input.link = null;
            }
          }
        }
      }

      // Update output links references
      const nodeOutputs = (newNode as { outputs?: Array<{ links?: number[] }> }).outputs;
      if (nodeOutputs) {
        for (const output of nodeOutputs) {
          if (output.links) {
            output.links = output.links
              .map(linkId => linkIdMap.get(linkId))
              .filter((id): id is number => id !== undefined);
          }
        }
      }

      mainNodes.push(newNode);
    }

    // Add remapped internal links to main workflow
    for (const link of subLinks) {
      const [linkId, fromNode, fromSlot, toNode, toSlot, type] = link;

      // Skip links involving virtual I/O nodes
      if (fromNode < 0 || toNode < 0) continue;

      const newLinkId = linkIdMap.get(linkId);
      if (newLinkId === undefined) continue;

      const newLink: [number, number, number, number, number, string] = [
        newLinkId,
        nodeIdMap.get(fromNode) || fromNode,
        fromSlot,
        nodeIdMap.get(toNode) || toNode,
        toSlot,
        type
      ];
      mainLinks.push(newLink);
    }

    // Connect subgraph outputs to external targets
    // Find links in the main workflow that connect FROM this subgraph node
    for (const mainLink of [...mainLinks]) {
      const [linkId, fromNode, fromSlot, toNode, toSlot, type] = mainLink;
      if (fromNode === subgraphNode.id) {
        // Find the corresponding output in the subgraph
        const subOutput = subOutputs[fromSlot];
        if (subOutput) {
          // Find the internal link that connects TO the virtual output node (-20)
          for (const subLink of subLinks) {
            const [subLinkId, subFromNode, subFromSlot, subToNode] = subLink;
            if (subToNode === -20) {
              const outputLinkIds = subOutput.linkIds || [];
              if (outputLinkIds.includes(subLinkId)) {
                // Reroute the main link to come from the internal source node
                const newFromNode = nodeIdMap.get(subFromNode);
                if (newFromNode) {
                  // Update the main link
                  const linkIndex = mainLinks.findIndex(l => l[0] === linkId);
                  if (linkIndex >= 0) {
                    mainLinks[linkIndex] = [linkId, newFromNode, subFromSlot, toNode, toSlot, type];
                    debugLog(`[expandSubgraphs] Output: Rerouted link ${linkId} from subgraph to internal node ${newFromNode}`);
                  }
                }
              }
            }
          }
        }
      }
    }

    // Connect external inputs TO the subgraph's internal nodes
    // Find links in the main workflow that connect TO this subgraph node
    const linksToRemove: number[] = [];
    for (const mainLink of [...mainLinks]) {
      const [linkId, fromNode, fromSlot, toNode, toSlot, type] = mainLink;
      if (toNode === subgraphNode.id) {
        // Find the corresponding input in the subgraph
        const subInput = subInputs[toSlot];
        if (subInput) {
          // Find internal links that carry this input (from virtual node -10)
          for (const linkIdFromInput of subInput.linkIds || []) {
            const internalLink = subLinks.find(l => l[0] === linkIdFromInput);
            if (internalLink && internalLink[1] === -10) {
              // This link goes from -10 to an internal node
              const [, , , internalToNode, internalToSlot, internalType] = internalLink;
              const newToNode = nodeIdMap.get(internalToNode);
              if (newToNode) {
                // Create a new link from the external source to the internal target
                const newLinkId = ++maxLinkId;
                const newLink: [number, number, number, number, number, string] = [
                  newLinkId,
                  fromNode,
                  fromSlot,
                  newToNode,
                  internalToSlot,
                  type
                ];
                mainLinks.push(newLink);

                // Update the internal node's input to reference this new link
                const targetNode = mainNodes.find(n => n.id === newToNode);
                if (targetNode?.inputs?.[internalToSlot]) {
                  targetNode.inputs[internalToSlot].link = newLinkId;
                }

                debugLog(`[expandSubgraphs] Input: Connected external node ${fromNode} to internal node ${newToNode}:${internalToSlot}`);
              }
            }
          }
        }
        // Mark original link to subgraph for removal
        linksToRemove.push(linkId);
      }
    }

    // Remove links that went to the subgraph node
    for (const linkId of linksToRemove) {
      const idx = mainLinks.findIndex(l => l[0] === linkId);
      if (idx >= 0) {
        mainLinks.splice(idx, 1);
      }
    }

    // Remove the subgraph node from the main workflow
    const nodeIndex = mainNodes.findIndex(n => n.id === subgraphNode.id);
    if (nodeIndex >= 0) {
      mainNodes.splice(nodeIndex, 1);
      debugLog(`[expandSubgraphs] Removed subgraph node ${subgraphNode.id}`);
    }
  }

  expanded.nodes = mainNodes;
  expanded.links = mainLinks;
  delete expanded.definitions; // Remove subgraph definitions after expansion

  // Collapse Reroute nodes within the expanded subgraph
  collapseRerouteNodesInternal(expanded);

  // Remove remaining UI-only nodes (PrimitiveNode, etc.)
  return removeUIOnlyNodes(expanded);
}

/**
 * Bypass LoraLoaderModelOnly nodes that have lora_name "None".
 * ComfyUI rejects "None" as it's not in the installed LoRAs list. When no LoRA is
 * selected, we remove the node and reroute the model input directly to consumers.
 */
function bypassLoraLoaderNodesWithNone(apiWorkflow: Record<string, unknown>): void {
  const nodesToBypass: Array<{ nodeId: string; modelSource: [string, number] }> = [];

  for (const [nodeId, node] of Object.entries(apiWorkflow)) {
    const nodeData = node as { class_type?: string; inputs?: Record<string, unknown> };
    if (nodeData.class_type !== 'LoraLoaderModelOnly') continue;

    const loraName = nodeData.inputs?.['lora_name'];
    const loraStr = typeof loraName === 'string' ? loraName : String(loraName ?? '');
    if (loraStr.toLowerCase() !== 'none') continue;

    const modelInput = nodeData.inputs?.['model'];
    if (!Array.isArray(modelInput) || modelInput.length < 2) continue;

    const [sourceNodeId, sourceSlot] = modelInput;
    nodesToBypass.push({ nodeId, modelSource: [String(sourceNodeId), Number(sourceSlot)] });
  }

  for (const { nodeId, modelSource } of nodesToBypass) {
    // Update all nodes that reference this LoraLoader's output
    for (const [consumerId, consumerNode] of Object.entries(apiWorkflow)) {
      if (consumerId === nodeId) continue;
      const consumer = consumerNode as { inputs?: Record<string, unknown> };
      const inputs = consumer.inputs;
      if (!inputs) continue;

      for (const [inputName, inputVal] of Object.entries(inputs)) {
        if (!Array.isArray(inputVal) || inputVal[0] !== nodeId) continue;
        (consumer.inputs as Record<string, unknown>)[inputName] = [...modelSource];
        debugLog(`[bypassLoraLoaderNodesWithNone] Rerouted ${consumerId}.${inputName} from [${nodeId},0] to [${modelSource[0]},${modelSource[1]}]`);
      }
    }
    delete apiWorkflow[nodeId];
    debugLog(`[bypassLoraLoaderNodesWithNone] Removed LoraLoaderModelOnly node ${nodeId} (lora_name="None")`);
  }
}

/**
 * Collapse Reroute nodes by directly connecting their sources to destinations.
 * This modifies the workflow in place.
 */
function collapseRerouteNodesInternal(workflow: WorkflowTemplate): void {
  const nodes = workflow.nodes || [];
  const links = workflow.links || [];

  // Find all Reroute nodes
  const rerouteNodes = nodes.filter(n => n.type === 'Reroute');
  if (rerouteNodes.length === 0) return;

  const rerouteIds = new Set(rerouteNodes.map(n => n.id));
  debugLog(`[collapseRerouteNodesInternal] Found ${rerouteNodes.length} Reroute nodes`);

  // Build link lookup: linkId -> link tuple
  const linkById = new Map<number, [number, number, number, number, number, string]>();
  for (const link of links) {
    linkById.set(link[0], link);
  }

  // For each Reroute, trace through to find the original source
  // (handling chains of Reroutes)
  function findOriginalSource(nodeId: number): [number, number] | null {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return null;

    if (node.type !== 'Reroute') {
      return null; // Not used for non-Reroutes
    }

    const inputLink = node.inputs?.[0]?.link;
    if (inputLink == null) return null;

    const linkData = linkById.get(inputLink);
    if (!linkData) return null;

    const [, sourceNodeId, sourceSlot] = linkData;

    // If source is also a Reroute, follow the chain
    if (rerouteIds.has(sourceNodeId)) {
      return findOriginalSource(sourceNodeId);
    }

    return [sourceNodeId, sourceSlot];
  }

  // Update all links that come FROM Reroute nodes to come from the original source
  for (const rerouteNode of rerouteNodes) {
    const originalSource = findOriginalSource(rerouteNode.id);
    if (!originalSource) {
      debugLog(`[collapseRerouteNodesInternal] Could not find source for Reroute ${rerouteNode.id}`);
      continue;
    }

    const [sourceNode, sourceSlot] = originalSource;

    // Find all links that come FROM this Reroute and update them
    for (const link of links) {
      if (link[1] === rerouteNode.id) {
        const oldFrom = link[1];
        link[1] = sourceNode;
        link[2] = sourceSlot;
        debugLog(`[collapseRerouteNodesInternal] Reroute ${oldFrom}: rerouted link ${link[0]} to source ${sourceNode}:${sourceSlot}`);
      }
    }
  }

  // Remove Reroute nodes from the nodes array
  workflow.nodes = nodes.filter(n => !rerouteIds.has(n.id));

  // Remove links that go INTO Reroute nodes
  workflow.links = links.filter(link => !rerouteIds.has(link[3]));

  debugLog(`[collapseRerouteNodesInternal] Removed ${rerouteIds.size} Reroute nodes`);
}

/**
 * Remove UI-only nodes that don't exist in ComfyUI's API.
 * Note: Reroute nodes are handled by collapseRerouteNodesInternal before this.
 */
function removeUIOnlyNodes(workflow: WorkflowTemplate): WorkflowTemplate {
  let nodes = workflow.nodes || [];
  let links = workflow.links || [];

  // Types of UI-only nodes to handle (these are frontend-only nodes)
  // Note: PrimitiveInt and PrimitiveFloat ARE valid API nodes
  // Note: Reroute is handled by collapseRerouteNodesInternal
  const uiOnlyTypes = new Set(['PrimitiveNode']);

  // Handle PrimitiveNode - propagate values to target nodes
  const primitiveNodes = nodes.filter(n => n.type === 'PrimitiveNode');
  for (const primNode of primitiveNodes) {
    const value = (primNode.widgets_values as unknown[])?.[0];
    if (value === undefined) continue;

    // Find output links from this primitive
    const outputs = (primNode as { outputs?: Array<{ links?: number[] }> }).outputs;
    const outputLinks = outputs?.[0]?.links || [];

    for (const linkId of outputLinks) {
      const link = links.find(l => l[0] === linkId);
      if (!link) continue;

      const [, , , targetNodeId, targetSlot] = link;
      const targetNode = nodes.find(n => n.id === targetNodeId);
      if (!targetNode) continue;

      // Find which input corresponds to this slot
      const targetInputs = targetNode.inputs || [];
      const targetInput = targetInputs[targetSlot];
      if (targetInput) {
        // Clear the link and the value will come from widgets_values
        targetInput.link = null;
        // For certain node types, we can set the widget value directly
        updateNodeWidgetValue(targetNode, targetInput.name, value);
        debugLog(`[removeUIOnlyNodes] PrimitiveNode ${primNode.id}: propagated "${String(value).substring(0, 30)}" to node ${targetNodeId}`);
      }
    }
  }

  // Collect all UI-only node IDs
  const uiOnlyNodeIds = new Set(
    nodes.filter(n => uiOnlyTypes.has(n.type)).map(n => n.id)
  );

  if (uiOnlyNodeIds.size > 0) {
    // Remove UI-only nodes
    nodes = nodes.filter(n => !uiOnlyNodeIds.has(n.id));

    // Remove links involving UI-only nodes
    links = links.filter(link => !uiOnlyNodeIds.has(link[1]) && !uiOnlyNodeIds.has(link[3]));

    debugLog(`[removeUIOnlyNodes] Removed ${uiOnlyNodeIds.size} UI-only nodes`);
  }

  workflow.nodes = nodes;
  workflow.links = links;

  return workflow;
}

/**
 * Helper to update a node's widget value by input name.
 * Different node types have different widget value layouts.
 */
function updateNodeWidgetValue(
  node: { type: string; widgets_values?: unknown[] },
  inputName: string,
  value: unknown
): void {
  if (!node.widgets_values) {
    node.widgets_values = [];
  }

  // Map input names to widget indices for known node types
  const nodeType = node.type;

  if (nodeType === 'CLIPTextEncode') {
    if (inputName === 'text') node.widgets_values[0] = value;
  } else if (nodeType === 'RandomNoise') {
    if (inputName === 'noise_seed') node.widgets_values[0] = value;
  } else if (nodeType === 'PrimitiveInt') {
    if (inputName === 'value') node.widgets_values[0] = value;
  } else if (nodeType === 'PrimitiveFloat') {
    if (inputName === 'value') node.widgets_values[0] = value;
  } else if (nodeType === 'EmptyImage') {
    if (inputName === 'width') node.widgets_values[0] = value;
    else if (inputName === 'height') node.widgets_values[1] = value;
    else if (inputName === 'batch_size') node.widgets_values[2] = value;
  } else if (nodeType === 'EmptyLTXVLatentVideo') {
    if (inputName === 'width') node.widgets_values[0] = value;
    else if (inputName === 'height') node.widgets_values[1] = value;
    else if (inputName === 'length') node.widgets_values[2] = value;
    else if (inputName === 'batch_size') node.widgets_values[3] = value;
  } else if (nodeType === 'LTXVEmptyLatentAudio') {
    if (inputName === 'frames_number') node.widgets_values[0] = value;
    else if (inputName === 'frame_rate') node.widgets_values[1] = value;
    else if (inputName === 'batch_size') node.widgets_values[2] = value;
  } else if (nodeType === 'LTXVConditioning') {
    if (inputName === 'frame_rate') node.widgets_values[0] = value;
  } else if (nodeType === 'LoadImage') {
    if (inputName === 'image') node.widgets_values[0] = value;
  } else if (nodeType === 'CreateVideo') {
    if (inputName === 'fps') node.widgets_values[0] = value;
  } else if (nodeType === 'CheckpointLoaderSimple') {
    if (inputName === 'ckpt_name') node.widgets_values[0] = value;
  } else if (nodeType === 'LTXVAudioVAELoader') {
    if (inputName === 'ckpt_name') node.widgets_values[0] = value;
  } else if (nodeType === 'LTXAVTextEncoderLoader') {
    if (inputName === 'text_encoder') node.widgets_values[0] = value;
    else if (inputName === 'ckpt_name') node.widgets_values[1] = value;
  } else if (nodeType === 'LoraLoaderModelOnly') {
    if (inputName === 'lora_name') node.widgets_values[0] = value;
    else if (inputName === 'strength_model') node.widgets_values[1] = value;
  } else {
    // Generic fallback: try to find the widget index from input position
    debugLog(`[updateNodeWidgetValue] Unknown node type ${nodeType}, skipping widget update for "${inputName}"`);
  }
}

/**
 * Convert ComfyUI workflow (UI format) into the API prompt format.
 */
/**
 * Resolve SetNode/GetNode virtual nodes in a LiteGraph workflow.
 * These are client-side-only nodes that act as named variable pass-throughs.
 * SetNode stores a value under a name, GetNode retrieves it.
 * We rewire links so that consumers of GetNodes point directly to the source
 * that feeds the corresponding SetNode, then remove all Set/GetNodes.
 */
export function resolveSetGetNodes(workflow: WorkflowTemplate): WorkflowTemplate {
  const nodes = workflow.nodes || [];
  const links = workflow.links || [];

  const setNodeIds = new Set<number>();
  const getNodeIds = new Set<number>();
  const setNodeNameMap = new Map<number, string>(); // setNodeId -> variable name
  const getNodeNameMap = new Map<number, string>(); // getNodeId -> variable name

  for (const node of nodes) {
    if (node.type === 'SetNode') {
      setNodeIds.add(node.id);
      const name = Array.isArray(node.widgets_values) ? String(node.widgets_values[0]) : (node.title || '');
      setNodeNameMap.set(node.id, name);
    } else if (node.type === 'GetNode') {
      getNodeIds.add(node.id);
      const name = Array.isArray(node.widgets_values) ? String(node.widgets_values[0]) : (node.title || '');
      getNodeNameMap.set(node.id, name);
    }
  }

  if (setNodeIds.size === 0 && getNodeIds.size === 0) {
    return workflow;
  }

  // Build: variable name -> [source_node_id, source_slot, link_type]
  // by finding links that feed INTO SetNodes
  const varSource = new Map<string, [number, number, string]>();
  for (const link of links) {
    if (!Array.isArray(link) || link.length < 6) continue;
    const [, fromNode, fromSlot, toNode, , linkType] = link;
    if (setNodeIds.has(toNode)) {
      const name = setNodeNameMap.get(toNode);
      if (name) {
        varSource.set(name, [fromNode, fromSlot, linkType]);
      }
    }
  }

  // Rewire: for each link FROM a GetNode, replace the source with the SetNode's source
  const newLinks: typeof links = [];
  let nextLinkId = Math.max(...links.map(l => l[0]), 0) + 1;

  for (const link of links) {
    if (!Array.isArray(link) || link.length < 6) continue;
    const [linkId, fromNode, fromSlot, toNode, toSlot, linkType] = link;

    // Skip links TO SetNodes (they'll be removed)
    if (setNodeIds.has(toNode)) continue;
    // Skip links FROM SetNodes (pass-through output, not needed)
    if (setNodeIds.has(fromNode)) continue;

    if (getNodeIds.has(fromNode)) {
      // This link comes from a GetNode — rewire to the actual source
      const name = getNodeNameMap.get(fromNode);
      if (name && varSource.has(name)) {
        const [srcNode, srcSlot] = varSource.get(name)!;
        newLinks.push([nextLinkId++, srcNode, srcSlot, toNode, toSlot, linkType]);
        debugLog(`[resolveSetGetNodes] Rewired: GetNode ${fromNode} (${name}) -> [${srcNode}, ${srcSlot}] -> Node ${toNode} slot ${toSlot}`);
      } else {
        debugLog(`[resolveSetGetNodes] WARNING: GetNode ${fromNode} references unknown variable "${name}"`);
      }
    } else if (!getNodeIds.has(toNode)) {
      // Regular link — keep as-is
      newLinks.push([linkId, fromNode, fromSlot, toNode, toSlot, linkType]);
    }
  }

  // Also update node input link references
  const filteredNodes = nodes
    .filter(n => !setNodeIds.has(n.id) && !getNodeIds.has(n.id))
    .map(n => {
      // Update input link IDs to match the new rewired links
      if (n.inputs) {
        const updatedInputs = n.inputs.map(input => {
          if (input.link === null || input.link === undefined) return input;
          // Find matching new link that targets this node and slot
          const matchingLink = newLinks.find(l => l[3] === n.id && l[4] === (n.inputs!.indexOf(input)));
          if (matchingLink) {
            return { ...input, link: matchingLink[0] };
          }
          // Keep original if it exists in newLinks
          const originalExists = newLinks.find(l => l[0] === input.link);
          if (originalExists) return input;
          // Link was removed (pointed to/from Set/GetNode)
          return { ...input, link: null };
        });
        return { ...n, inputs: updatedInputs };
      }
      return n;
    });

  debugLog(`[resolveSetGetNodes] Resolved ${setNodeIds.size} SetNodes and ${getNodeIds.size} GetNodes, ${links.length} -> ${newLinks.length} links`);

  return {
    ...workflow,
    nodes: filteredNodes,
    links: newLinks,
  };
}

export function workflowToPrompt(workflow: WorkflowTemplate): Record<string, unknown> {
  const prompt: Record<string, unknown> = {};
  const nodes = workflow.nodes || [];
  const links = workflow.links || [];

  // Map link id -> (source_node_id, source_output_index)
  const linkLookup: Map<number, [number, number]> = new Map();
  for (const link of links) {
    if (Array.isArray(link) && link.length >= 6) {
      const [linkId, fromNode, fromSlot] = link;
      linkLookup.set(linkId, [fromNode, fromSlot]);
    }
  }

  for (const node of nodes) {
    const nodeId = String(node.id);
    if (nodeId === 'None') continue;

    const nodeType = node.type;
    const inputsSpec = node.inputs || [];
    const widgetValues = node.widgets_values || [];

    const convertedInputs: Record<string, unknown> = {};

    // First, add all linked inputs
    for (const inputSpec of inputsSpec) {
      const name = inputSpec.name;
      const linkId = inputSpec.link;
      if (linkId !== null && linkId !== undefined && name) {
        const source = linkLookup.get(linkId);
        if (source) {
          const [fromNode, fromSlot] = source;
          convertedInputs[name] = [String(fromNode), fromSlot];
        }
      }
    }

    // Special handling for KSampler (standard version)
    if (nodeType === 'KSampler' && Array.isArray(widgetValues) && widgetValues.length === 7) {
      convertedInputs['seed'] = widgetValues[0];
      convertedInputs['steps'] = widgetValues[2];
      convertedInputs['cfg'] = widgetValues[3];
      convertedInputs['sampler_name'] = widgetValues[4];
      convertedInputs['scheduler'] = widgetValues[5];
      convertedInputs['denoise'] = widgetValues[6];
    }
    // Special handling for KSamplerAdvanced
    else if (nodeType === 'KSamplerAdvanced' && Array.isArray(widgetValues)) {
      // KSamplerAdvanced widget order: add_noise, noise_seed, control_after_generate, steps, cfg, sampler_name, scheduler, start_at_step, end_at_step, return_with_leftover_noise
      convertedInputs['add_noise'] = widgetValues[0];
      convertedInputs['noise_seed'] = widgetValues[1];
      // widgetValues[2] is control_after_generate (not needed in API)
      convertedInputs['steps'] = widgetValues[3];
      convertedInputs['cfg'] = widgetValues[4];
      convertedInputs['sampler_name'] = widgetValues[5];
      convertedInputs['scheduler'] = widgetValues[6];
      convertedInputs['start_at_step'] = widgetValues[7];
      convertedInputs['end_at_step'] = widgetValues[8];
      convertedInputs['return_with_leftover_noise'] = widgetValues[9];
    }
    // Special handling for LoadImage - only needs 'image' input
    else if (nodeType === 'LoadImage') {
      if (Array.isArray(widgetValues) && widgetValues.length > 0) {
        convertedInputs['image'] = widgetValues[0];
      }
    }
    // Special handling for Seed (rgthree)
    else if (nodeType === 'Seed (rgthree)' && Array.isArray(widgetValues)) {
      convertedInputs['seed'] = widgetValues[0];
    }
    // Special handling for VHS_VideoCombine - uses object-based widgets_values
    else if (nodeType === 'VHS_VideoCombine') {
      if (typeof widgetValues === 'object' && !Array.isArray(widgetValues)) {
        // Object-based widget values - copy directly
        const wv = widgetValues as Record<string, unknown>;
        convertedInputs['frame_rate'] = wv['frame_rate'];
        convertedInputs['loop_count'] = wv['loop_count'];
        convertedInputs['filename_prefix'] = wv['filename_prefix'];
        convertedInputs['format'] = wv['format'];
        convertedInputs['pingpong'] = wv['pingpong'];
        convertedInputs['save_output'] = wv['save_output'];
        if (wv['pix_fmt'] !== undefined) convertedInputs['pix_fmt'] = wv['pix_fmt'];
        if (wv['crf'] !== undefined) convertedInputs['crf'] = wv['crf'];
        if (wv['save_metadata'] !== undefined) convertedInputs['save_metadata'] = wv['save_metadata'];
        if (wv['trim_to_audio'] !== undefined) convertedInputs['trim_to_audio'] = wv['trim_to_audio'];
      }
    }
    // Special handling for INTConstant and easy float
    else if ((nodeType === 'INTConstant' || nodeType === 'easy float') && Array.isArray(widgetValues)) {
      convertedInputs['value'] = widgetValues[0];
    }
    // Special handling for CLIPTextEncode
    else if (nodeType === 'CLIPTextEncode' && Array.isArray(widgetValues)) {
      convertedInputs['text'] = widgetValues[0];
    }
    // Special handling for ModelSamplingSD3
    else if (nodeType === 'ModelSamplingSD3' && Array.isArray(widgetValues)) {
      convertedInputs['shift'] = widgetValues[0];
    }
    // Special handling for FastUnsharpSharpen
    else if (nodeType === 'FastUnsharpSharpen' && Array.isArray(widgetValues)) {
      convertedInputs['strength'] = widgetValues[0];
      if (widgetValues.length > 1) {
        convertedInputs['use_gpu'] = widgetValues[1];
      }
    }
    // Special handling for ImageScale
    else if (nodeType === 'ImageScale' && Array.isArray(widgetValues)) {
      convertedInputs['upscale_method'] = widgetValues[0];
      convertedInputs['width'] = widgetValues[1];
      convertedInputs['height'] = widgetValues[2];
      convertedInputs['crop'] = widgetValues[3] ?? 'disabled';
    }
    // Special handling for UNETLoader
    else if (nodeType === 'UNETLoader' && Array.isArray(widgetValues)) {
      convertedInputs['unet_name'] = widgetValues[0];
      convertedInputs['weight_dtype'] = widgetValues[1];
    }
    // Special handling for CLIPLoader
    else if (nodeType === 'CLIPLoader' && Array.isArray(widgetValues)) {
      convertedInputs['clip_name'] = widgetValues[0];
      convertedInputs['type'] = widgetValues[1];
      if (widgetValues[2] !== undefined) convertedInputs['device'] = widgetValues[2];
    }
    // Special handling for VAELoader
    else if (nodeType === 'VAELoader' && Array.isArray(widgetValues)) {
      convertedInputs['vae_name'] = widgetValues[0];
    }
    // Special handling for CreateVideo
    else if (nodeType === 'CreateVideo' && Array.isArray(widgetValues)) {
      convertedInputs['fps'] = widgetValues[0];
    }
    // Special handling for SaveVideo
    else if (nodeType === 'SaveVideo' && Array.isArray(widgetValues)) {
      convertedInputs['filename_prefix'] = widgetValues[0];
      convertedInputs['format'] = widgetValues[1];
      convertedInputs['codec'] = widgetValues[2];
    }
    // Special handling for subgraph nodes (UUID-like type names)
    // These are collapsed ComfyUI subgraphs with proxy widgets
    else if (nodeType && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeType)) {
      // Map widgets using proxyWidgets mapping if available
      const proxyWidgets = (node as { properties?: { proxyWidgets?: Array<[string, string]> } }).properties?.proxyWidgets;
      if (proxyWidgets && Array.isArray(widgetValues)) {
        for (let i = 0; i < proxyWidgets.length && i < widgetValues.length; i++) {
          const proxyWidget = proxyWidgets[i];
          if (proxyWidget) {
            const [targetNode, inputName] = proxyWidget;
            // "-1" means it's an external input that should be exposed
            if (targetNode === '-1' && inputName) {
              convertedInputs[inputName] = widgetValues[i];
            }
          }
        }
      }
      debugLog(`[workflowToPrompt] Handled subgraph node ${nodeId} (${nodeType.substring(0, 8)}...) with ${Object.keys(convertedInputs).length} inputs`);
    }
    // Special handling for LoraLoaderModelOnly
    else if (nodeType === 'LoraLoaderModelOnly' && Array.isArray(widgetValues)) {
      convertedInputs['lora_name'] = widgetValues[0];
      convertedInputs['strength_model'] = widgetValues[1];
    }
    // Special handling for LoraLoader (full version with clip)
    else if (nodeType === 'LoraLoader' && Array.isArray(widgetValues)) {
      convertedInputs['lora_name'] = widgetValues[0];
      convertedInputs['strength_model'] = widgetValues[1];
      convertedInputs['strength_clip'] = widgetValues[2];
    }
    // Special handling for ModelSamplingAuraFlow
    else if (nodeType === 'ModelSamplingAuraFlow' && Array.isArray(widgetValues)) {
      convertedInputs['shift'] = widgetValues[0];
    }
    // Special handling for CFGNorm
    else if (nodeType === 'CFGNorm' && Array.isArray(widgetValues)) {
      convertedInputs['strength'] = widgetValues[0];
    }
    // Special handling for ImageScaleToTotalPixels
    else if (nodeType === 'ImageScaleToTotalPixels' && Array.isArray(widgetValues)) {
      convertedInputs['upscale_method'] = widgetValues[0];
      convertedInputs['megapixels'] = widgetValues[1];
    }
    // Special handling for TextEncodeQwenImageEditPlus
    else if (nodeType === 'TextEncodeQwenImageEditPlus' && Array.isArray(widgetValues)) {
      convertedInputs['prompt'] = widgetValues[0];
    }
    // Special handling for SaveImage
    else if (nodeType === 'SaveImage' && Array.isArray(widgetValues)) {
      convertedInputs['filename_prefix'] = widgetValues[0];
    }
    // Special handling for LTXVEmptyLatentAudio - widget values are positional regardless of links
    else if (nodeType === 'LTXVEmptyLatentAudio' && Array.isArray(widgetValues)) {
      // widgets_values: [frames_number, frame_rate, batch_size]
      // Only set if not already linked
      if (!convertedInputs['frames_number']) convertedInputs['frames_number'] = widgetValues[0];
      if (!convertedInputs['frame_rate']) convertedInputs['frame_rate'] = widgetValues[1];
      if (!convertedInputs['batch_size']) convertedInputs['batch_size'] = widgetValues[2];
    }
    // Special handling for EmptyLTXVLatentVideo
    else if (nodeType === 'EmptyLTXVLatentVideo' && Array.isArray(widgetValues)) {
      // widgets_values: [width, height, length, batch_size]
      if (!convertedInputs['width']) convertedInputs['width'] = widgetValues[0];
      if (!convertedInputs['height']) convertedInputs['height'] = widgetValues[1];
      if (!convertedInputs['length']) convertedInputs['length'] = widgetValues[2];
      if (!convertedInputs['batch_size']) convertedInputs['batch_size'] = widgetValues[3];
    }
    // Special handling for PrimitiveInt
    else if (nodeType === 'PrimitiveInt' && Array.isArray(widgetValues)) {
      convertedInputs['value'] = widgetValues[0];
      convertedInputs['control_after_generate'] = widgetValues[1] || 'fixed';
    }
    // Special handling for PrimitiveFloat
    else if (nodeType === 'PrimitiveFloat' && Array.isArray(widgetValues)) {
      convertedInputs['value'] = widgetValues[0];
      convertedInputs['control_after_generate'] = widgetValues[1] || 'fixed';
    }
    // Special handling for RandomNoise
    else if (nodeType === 'RandomNoise' && Array.isArray(widgetValues)) {
      convertedInputs['noise_seed'] = widgetValues[0];
      if (widgetValues[1] !== undefined) convertedInputs['control_after_generate'] = widgetValues[1];
    }
    // Special handling for KSamplerSelect
    else if (nodeType === 'KSamplerSelect' && Array.isArray(widgetValues)) {
      convertedInputs['sampler_name'] = widgetValues[0];
    }
    // Special handling for LTXVScheduler
    else if (nodeType === 'LTXVScheduler' && Array.isArray(widgetValues)) {
      // widgets_values: [steps, max_shift, base_shift, stretch, terminal]
      if (!convertedInputs['steps']) convertedInputs['steps'] = widgetValues[0];
      if (!convertedInputs['max_shift']) convertedInputs['max_shift'] = widgetValues[1];
      if (!convertedInputs['base_shift']) convertedInputs['base_shift'] = widgetValues[2];
      if (!convertedInputs['stretch']) convertedInputs['stretch'] = widgetValues[3];
      if (!convertedInputs['terminal']) convertedInputs['terminal'] = widgetValues[4];
    }
    // Special handling for LTXVConditioning
    else if (nodeType === 'LTXVConditioning' && Array.isArray(widgetValues)) {
      if (!convertedInputs['frame_rate']) convertedInputs['frame_rate'] = widgetValues[0];
    }
    // Special handling for CFGGuider
    else if (nodeType === 'CFGGuider' && Array.isArray(widgetValues)) {
      if (!convertedInputs['cfg']) convertedInputs['cfg'] = widgetValues[0];
    }
    // Special handling for ManualSigmas
    else if (nodeType === 'ManualSigmas' && Array.isArray(widgetValues)) {
      convertedInputs['sigmas'] = widgetValues[0];
    }
    // Special handling for LatentUpscaleModelLoader
    else if (nodeType === 'LatentUpscaleModelLoader' && Array.isArray(widgetValues)) {
      convertedInputs['model_name'] = widgetValues[0];
    }
    // Special handling for CheckpointLoaderSimple
    else if (nodeType === 'CheckpointLoaderSimple' && Array.isArray(widgetValues)) {
      convertedInputs['ckpt_name'] = widgetValues[0];
    }
    // Special handling for LTXVAudioVAELoader
    else if (nodeType === 'LTXVAudioVAELoader' && Array.isArray(widgetValues)) {
      convertedInputs['ckpt_name'] = widgetValues[0];
    }
    // Special handling for LTXAVTextEncoderLoader
    else if (nodeType === 'LTXAVTextEncoderLoader') {
      if (Array.isArray(widgetValues)) {
        convertedInputs['text_encoder'] = widgetValues[0];
        convertedInputs['ckpt_name'] = widgetValues[1];
      }
      // device is REQUIRED - always set it to ensure it's present
      // Use widget value if available, otherwise default to "default"
      // Only set if not already linked (linked inputs are handled above)
      if (!('device' in convertedInputs) || convertedInputs['device'] === undefined || convertedInputs['device'] === null) {
        const deviceValue = Array.isArray(widgetValues) && widgetValues[2] !== undefined 
          ? widgetValues[2] 
          : 'default';
        convertedInputs['device'] = deviceValue;
      }
    }
    // Special handling for EmptyImage
    else if (nodeType === 'EmptyImage' && Array.isArray(widgetValues)) {
      if (!convertedInputs['width']) convertedInputs['width'] = widgetValues[0];
      if (!convertedInputs['height']) convertedInputs['height'] = widgetValues[1];
      if (!convertedInputs['batch_size']) convertedInputs['batch_size'] = widgetValues[2];
      if (!convertedInputs['color']) convertedInputs['color'] = widgetValues[3];
    }
    // Special handling for ImageScaleBy
    else if (nodeType === 'ImageScaleBy' && Array.isArray(widgetValues)) {
      convertedInputs['upscale_method'] = widgetValues[0];
      convertedInputs['scale_by'] = widgetValues[1];
    }
    // Special handling for LTXVImgToVideoInplace
    else if (nodeType === 'LTXVImgToVideoInplace' && Array.isArray(widgetValues)) {
      convertedInputs['strength'] = widgetValues[0];
      convertedInputs['bypass'] = widgetValues[1];
    }
    // Special handling for LTXVPreprocess
    else if (nodeType === 'LTXVPreprocess' && Array.isArray(widgetValues)) {
      convertedInputs['img_compression'] = widgetValues[0];
    }
    // Special handling for ResizeImagesByLongerEdge
    else if (nodeType === 'ResizeImagesByLongerEdge' && Array.isArray(widgetValues)) {
      convertedInputs['longer_edge'] = widgetValues[0];
    }
    // Special handling for ResizeImageMaskNode
    // widgets_values can be either:
    //   [resize_type, multiplier, scale_method] for "scale by multiplier" mode
    //   [resize_type, width, height, crop, scale_method] for other modes
    else if (nodeType === 'ResizeImageMaskNode' && Array.isArray(widgetValues)) {
      convertedInputs['resize_type'] = widgetValues[0];
      if (widgetValues[0] === 'scale by multiplier') {
        convertedInputs['resize_type.multiplier'] = widgetValues[1];
        convertedInputs['scale_method'] = widgetValues[2];
      } else {
        convertedInputs['resize_type.width'] = widgetValues[1];
        convertedInputs['resize_type.height'] = widgetValues[2];
        convertedInputs['resize_type.crop'] = widgetValues[3];
        convertedInputs['scale_method'] = widgetValues[4];
      }
    }
    // Special handling for PrimitiveBoolean
    else if (nodeType === 'PrimitiveBoolean' && Array.isArray(widgetValues)) {
      convertedInputs['value'] = widgetValues[0];
    }
    // Special handling for DualCLIPLoader
    else if (nodeType === 'DualCLIPLoader' && Array.isArray(widgetValues)) {
      convertedInputs['clip_name1'] = widgetValues[0];
      convertedInputs['clip_name2'] = widgetValues[1];
      convertedInputs['type'] = widgetValues[2];
      if (widgetValues[3] !== undefined) convertedInputs['device'] = widgetValues[3];
    }
    // Special handling for UnetLoaderGGUF
    else if (nodeType === 'UnetLoaderGGUF' && Array.isArray(widgetValues)) {
      convertedInputs['unet_name'] = widgetValues[0];
    }
    // Special handling for VAELoaderKJ
    else if (nodeType === 'VAELoaderKJ' && Array.isArray(widgetValues)) {
      convertedInputs['vae_name'] = widgetValues[0];
      if (widgetValues[1] !== undefined) convertedInputs['device'] = widgetValues[1];
      if (widgetValues[2] !== undefined) convertedInputs['weight_dtype'] = widgetValues[2];
    }
    // Special handling for SimpleCalculatorKJ
    else if (nodeType === 'SimpleCalculatorKJ' && Array.isArray(widgetValues)) {
      convertedInputs['expression'] = widgetValues[0];
    }
    // Special handling for ImageResizeKJv2
    else if (nodeType === 'ImageResizeKJv2' && Array.isArray(widgetValues)) {
      if (!convertedInputs['width']) convertedInputs['width'] = widgetValues[0];
      if (!convertedInputs['height']) convertedInputs['height'] = widgetValues[1];
      convertedInputs['upscale_method'] = widgetValues[2];
      convertedInputs['keep_proportion'] = widgetValues[3];
      if (widgetValues[4] !== undefined) convertedInputs['pad_color'] = widgetValues[4];
      if (widgetValues[5] !== undefined) convertedInputs['crop_position'] = widgetValues[5];
      if (widgetValues[6] !== undefined) convertedInputs['divisible_by'] = widgetValues[6];
      if (widgetValues[7] !== undefined) convertedInputs['device'] = widgetValues[7];
    }
    // Special handling for VAEDecodeTiled
    else if (nodeType === 'VAEDecodeTiled' && Array.isArray(widgetValues)) {
      if (!convertedInputs['tile_size']) convertedInputs['tile_size'] = widgetValues[0];
      if (!convertedInputs['overlap']) convertedInputs['overlap'] = widgetValues[1];
      if (widgetValues[2] !== undefined && !convertedInputs['temporal_size']) convertedInputs['temporal_size'] = widgetValues[2];
      if (widgetValues[3] !== undefined && !convertedInputs['temporal_overlap']) convertedInputs['temporal_overlap'] = widgetValues[3];
    }
    // Special handling for Power Lora Loader (rgthree) - complex widget structure
    else if (nodeType === 'Power Lora Loader (rgthree)') {
      // This node uses object-based widgets; the API handles it via linked inputs
      // Lora configs are embedded in the widget values as objects
      if (Array.isArray(widgetValues)) {
        for (const wv of widgetValues) {
          if (typeof wv === 'object' && wv !== null && 'on' in wv) {
            const loraConfig = wv as { on: boolean; lora: string; strength: number; strengthTwo?: number | null };
            if (loraConfig.on) {
              convertedInputs['lora_01'] = loraConfig;
            }
          }
        }
      }
    }
    // Default handling for other nodes
    else if (Array.isArray(widgetValues)) {
      let widgetIndex = 0;
      for (const inputSpec of inputsSpec) {
        const name = inputSpec.name;
        if (!name) continue;

        // Skip if already set via link
        if (convertedInputs[name] !== undefined) continue;

        const linkId = inputSpec.link;
        if (linkId === null || linkId === undefined) {
          let value: unknown = undefined;
          if (widgetIndex < widgetValues.length) {
            value = widgetValues[widgetIndex];
            widgetIndex++;
          } else if ('default' in inputSpec) {
            value = inputSpec.default;
          } else if ('value' in inputSpec) {
            value = inputSpec.value;
          }
          convertedInputs[name] = value;
        }
      }
    }

    prompt[nodeId] = {
      class_type: nodeType,
      inputs: convertedInputs,
    };
  }

  return prompt;
}

// Type definitions

export interface WorkflowTemplate {
  nodes?: Array<{
    id: number;
    type: string;
    title?: string;
    mode?: number;
    inputs?: Array<{
      name: string;
      link?: number | null;
      default?: unknown;
      value?: unknown;
    }>;
    widgets_values?: unknown[];
    properties?: {
      proxyWidgets?: Array<[string, string]>;
      [key: string]: unknown;
    };
  }>;
  links?: Array<[number, number, number, number, number, string]>;
  definitions?: {
    subgraphs?: Array<{
      id: string;
      name: string;
      [key: string]: unknown;
    }>;
  };
  [key: string]: unknown;
}
