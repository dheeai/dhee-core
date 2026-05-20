/**
 * Fake tool handlers for generation tools.
 * When dhee_FAKE_MODE=1, these replace the real ComfyUI-based handlers.
 * Each creates a placeholder PNG with sharp showing all parameters passed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import { createTool } from '../../core/tools/index.js';
import type { ToolDefinition, ToolParameterSchema } from '../../core/llm/index.js';
import {
  jobs,
  getAssetsDir,
  generateImageTool,
  generateVideoFromImageTool,
  editImageTool,
} from './tools.js';
import type { GenerationJob } from './tools.js';
import { getProjectDir, addAsset } from './workflow/index.js';
import { readProjectText } from './workflow/projectFileIO.js';
import {
  buildShotSegmentId,
  loadTimeline,
  saveTimeline,
  updateSegmentLayers,
} from '../../core/timeline/index.js';

// ─── Placeholder image generation ────────────────────────────────────────────

const ASPECT_DIMENSIONS: Record<string, [number, number]> = {
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '1:1': [1024, 1024],
  '4:3': [1024, 768],
  '3:4': [768, 1024],
};

// Uniform dark background for all fake images
const FAKE_BG_COLOR = '#1a1a2e';

function buildPlacementMetadata(
  sceneNumber: number | undefined,
  shotNumber: number | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...extra };
  if (sceneNumber !== undefined) metadata['placementNumber'] = sceneNumber;
  if (shotNumber !== undefined) metadata['shot_number'] = shotNumber;
  return metadata;
}

function readPromptSourceFile(filePath: string): string | null {
  if (path.isAbsolute(filePath)) {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return fs.readFileSync(filePath, 'utf-8');
  }

  return readProjectText(filePath);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function buildSvgOverlay(
  width: number,
  height: number,
  toolName: string,
  params: Array<[string, string]>,
): string {
  const lineHeight = 22;
  const margin = 30;
  const maxCharsPerLine = Math.floor((width - margin * 2) / 9);
  const lines: string[] = [];

  lines.push(`[FAKE] ${toolName}`);
  lines.push('─'.repeat(Math.min(40, maxCharsPerLine)));

  for (const [key, value] of params) {
    if (!value && value !== '0') continue;
    const prefix = `${key}: `;
    const wrapped = wrapText(String(value), maxCharsPerLine - prefix.length);
    if (wrapped.length === 0) continue;
    lines.push(`${prefix}${wrapped[0]}`);
    for (let i = 1; i < wrapped.length && lines.length < Math.floor((height - margin * 2) / lineHeight); i++) {
      lines.push(`  ${wrapped[i]}`);
    }
  }

  // Truncate if too many lines
  const maxLines = Math.floor((height - margin * 2) / lineHeight);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = '...';
  }

  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${margin}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('\n      ');

  return `<svg width="${width}" height="${height}">
    <text
      x="${margin}" y="${margin + lineHeight}"
      font-family="monospace"
      font-size="16"
      fill="white"
      opacity="0.95">
      ${tspans}
    </text>
  </svg>`;
}

async function createPlaceholderImage(
  width: number,
  height: number,
  bgColor: string,
  toolName: string,
  params: Array<[string, string]>,
  outputPath: string,
): Promise<void> {
  const svg = buildSvgOverlay(width, height, toolName, params);
  const svgBuffer = Buffer.from(svg);

  const sharp = (await import('sharp')).default;
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: bgColor,
    },
  })
    .composite([{ input: svgBuffer, top: 0, left: 0 }])
    .png()
    .toFile(outputPath);
}

// ─── Fake handlers ───────────────────────────────────────────────────────────

async function fakeGenerateImageHandler(
  args: Record<string, unknown>,
): Promise<unknown> {
  const sceneNumber = args['scene_number'] as number;
  const promptInline = (args['prompt'] as string) || '';
  const promptFile = (args['prompt_file'] as string) || '';
  const negativePrompt = (args['negative_prompt'] as string) || '';
  const aspectRatio = (args['aspect_ratio'] as string) || '16:9';
  const seed = args['seed'] as number | undefined;
  const imageType = (args['image_type'] as string) || 'scene';
  const characterName = args['character_name'] as string | undefined;
  const settingName = args['setting_name'] as string | undefined;
  const generationMode = (args['generation_mode'] as string) || 'text_to_image';
  const shotNumber = args['shot_number'] as number | undefined;
  const segmentId = (args['segment_id'] as string | undefined) ??
    (imageType === 'scene' && shotNumber !== undefined
      ? buildShotSegmentId(sceneNumber, shotNumber)
      : undefined);
  const referenceImages = args['reference_images'] as Array<{
    image_id: string;
    type: string;
    name: string;
  }> | undefined;

  // Resolve prompt text: read from file if prompt_file is provided, else use inline prompt
  let promptText = promptInline;
  if (!promptText && promptFile) {
    try {
      const promptContent = readPromptSourceFile(promptFile);
      if (promptContent != null) {
        promptText = promptContent.trim();
      }
    } catch {
      // Fall back to showing the file path
    }
  }
  if (!promptText) promptText = '(none)';

  const [width, height] = ASPECT_DIMENSIONS[aspectRatio] || [1280, 720];

  const params: Array<[string, string]> = [
    ['scene_number', String(sceneNumber)],
    ['image_type', imageType],
    ['generation_mode', generationMode],
    ['aspect_ratio', aspectRatio],
    ['seed', seed !== undefined ? String(seed) : ''],
    ['character_name', characterName || ''],
    ['setting_name', settingName || ''],
  ];

  if (promptFile) {
    params.push(['prompt_file', promptFile]);
  }

  params.push(
    ['', ''],
    ['PROMPT', ''],
    ['', promptText],
    ['', ''],
    ['NEGATIVE PROMPT', ''],
    ['', negativePrompt || '(none)'],
  );

  if (referenceImages && referenceImages.length > 0) {
    params.push(['', '']);
    params.push(['REFERENCE IMAGES', '']);
    for (const ref of referenceImages) {
      params.push(['', `- ${ref.type}: ${ref.name} (${ref.image_id})`]);
    }
  }

  // Create job
  const jobId = `fake-img-${Date.now()}-${nanoid(6)}`;
  const artifactId = `img_${nanoid(8)}`;
  const filename = `Scene${sceneNumber}_${imageType}_fake_${nanoid(4)}.png`;
  const assetsDir = getAssetsDir();
  const outputPath = path.join(assetsDir, filename);

  await createPlaceholderImage(width, height, FAKE_BG_COLOR, 'generate_image', params, outputPath);

  // Compute relative path for artifact
  const projectDir = getProjectDir();
  const relativePath = path.relative(projectDir, outputPath);

  // Register job as immediately completed
  const entityType = imageType === 'character_ref' ? 'character' as const : imageType === 'setting_ref' ? 'setting' as const : 'scene' as const;
  const job: GenerationJob = {
    id: jobId,
    type: 'image',
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: {
      artifactId,
      path: outputPath,
    },
    context: {
      entityType,
      sceneNumber,
      characterName,
      settingName,
      artifactType: 'image',
    },
  };
  jobs.set(jobId, job);

  // Register in manifest
  const assetType = imageType === 'character_ref' ? 'character_ref' as const : imageType === 'setting_ref' ? 'setting_ref' as const : 'scene_image' as const;
  try {
    addAsset({
      id: artifactId,
      type: assetType,
      path: relativePath,
      scene_number: assetType === 'scene_image' ? sceneNumber : undefined,
      version: 1,
      createdAt: Date.now(),
      metadata: buildPlacementMetadata(
        assetType === 'scene_image' ? sceneNumber : undefined,
        assetType === 'scene_image' ? shotNumber : undefined,
        { jobId, fake: true },
      ),
    });
  } catch {
    // Project may not exist yet
  }

  if (assetType === 'scene_image' && segmentId) {
    try {
      const timeline = loadTimeline(projectDir);
      if (timeline) {
        const updated = updateSegmentLayers(
          timeline,
          segmentId,
          [
            {
              type: 'visual',
              artifactId,
              filePath: relativePath,
              label: `Scene ${sceneNumber} Shot ${shotNumber} image`,
              source: 'generated',
            },
          ],
          undefined,
          promptText,
        );
        saveTimeline(projectDir, updated);
      }
    } catch {
      // Ignore timeline update failures in fake mode
    }
  }

  return {
    status: 'submitted',
    job_id: jobId,
    generation_mode: generationMode,
    message: `[FAKE] Image generation job completed instantly. Use wait_for_job("${jobId}") to get result.`,
    params: {
      scene_number: sceneNumber,
      shot_number: shotNumber,
      image_type: imageType,
      prompt: promptText,
      prompt_file: promptFile || undefined,
      generation_mode: generationMode,
      reference_count: referenceImages?.length ?? 0,
      references: referenceImages?.map(r => `${r.type}:${r.name}`) ?? [],
    },
    segment_id: segmentId,
    timeline_updated: Boolean(segmentId && assetType === 'scene_image'),
  };
}

async function fakeGenerateVideoHandler(
  args: Record<string, unknown>,
): Promise<unknown> {
  const shotImageArtifactId = args['shot_image_artifact_id'] as string;
  const sceneNumber = args['scene_number'] as number;
  const shotNumber = args['shot_number'] as number;
  const motionPromptInline = (args['motion_prompt'] as string) || '';
  const motionPromptFile = (args['motion_prompt_file'] as string) || '';
  const seed = args['seed'] as number | undefined;
  const duration = (args['duration'] as number) || 10;
  const segmentId = (args['segment_id'] as string | undefined) ?? buildShotSegmentId(sceneNumber, shotNumber);
  const videoWidth = (args['width'] as number) || 1280;
  const videoHeight = (args['height'] as number) || 720;

  // Resolve motion prompt text: read from file if motion_prompt_file is provided
  let motionPromptText = motionPromptInline;
  if (!motionPromptText && motionPromptFile) {
    try {
      const motionPromptContent = readPromptSourceFile(motionPromptFile);
      if (motionPromptContent != null) {
        motionPromptText = motionPromptContent.trim();
      }
    } catch {
      // Fall back
    }
  }
  if (!motionPromptText) motionPromptText = '(none)';

  const [width, height] = [videoWidth, videoHeight];
  const bgColor = FAKE_BG_COLOR;

  const params: Array<[string, string]> = [
    ['scene_number', String(sceneNumber)],
    ['shot_number', String(shotNumber)],
    ['shot_image_artifact_id', shotImageArtifactId || '(none)'],
    ['duration', `${duration}s`],
    ['size', `${videoWidth}x${videoHeight}`],
    ['seed', seed !== undefined ? String(seed) : ''],
  ];

  if (motionPromptFile) {
    params.push(['motion_prompt_file', motionPromptFile]);
  }

  params.push(
    ['', ''],
    ['MOTION PROMPT', ''],
    ['', motionPromptText],
  );

  const jobId = `fake-vid-${Date.now()}-${nanoid(6)}`;
  const artifactId = `vid_${nanoid(8)}`;
  const filename = `Scene${sceneNumber}_shot${shotNumber}_video_fake_${nanoid(4)}.png`;

  const videosDir = path.join(getProjectDir(), 'assets', 'videos');
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }
  const outputPath = path.join(videosDir, filename);

  await createPlaceholderImage(width, height, bgColor, 'generate_video_from_image', params, outputPath);

  const projectDir = getProjectDir();
  const relativePath = path.relative(projectDir, outputPath);

  const job: GenerationJob = {
    id: jobId,
    type: 'video',
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: {
      artifactId,
      path: outputPath,
    },
    context: {
      entityType: 'scene',
      sceneNumber,
      shotNumber,
      artifactType: 'video',
    },
  };
  jobs.set(jobId, job);

  try {
    addAsset({
      id: artifactId,
      type: 'scene_video',
      path: relativePath,
      scene_number: sceneNumber,
      version: 1,
      createdAt: Date.now(),
      metadata: buildPlacementMetadata(sceneNumber, shotNumber, { jobId, fake: true }),
    });
  } catch {
    // Project may not exist yet
  }

  try {
    const timeline = loadTimeline(projectDir);
    if (timeline) {
      const updated = updateSegmentLayers(
        timeline,
        segmentId,
        [
          {
            type: 'visual',
            artifactId,
            filePath: relativePath,
            label: `Scene ${sceneNumber} Shot ${shotNumber} video`,
            source: 'generated',
          },
        ],
        undefined,
        motionPromptText,
      );
      saveTimeline(projectDir, updated);
    }
  } catch {
    // Ignore timeline update failures in fake mode
  }

  return {
    status: 'submitted',
    job_id: jobId,
    workflow: 'fake_ltx23',
    message: `[FAKE] Video generation job completed instantly. Use wait_for_job("${jobId}") to get result.`,
    params: {
      scene_number: sceneNumber,
      shot_number: shotNumber,
      image_artifact: shotImageArtifactId,
      motion_prompt: motionPromptText,
      motion_prompt_file: motionPromptFile || undefined,
    },
    segment_id: segmentId,
    timeline_updated: true,
  };
}

async function fakeEditImageHandler(
  args: Record<string, unknown>,
): Promise<unknown> {
  const sceneNumber = args['scene_number'] as number;
  const editPrompt = (args['edit_prompt'] as string) || '(none)';
  const baseImagePath = (args['base_image_path'] as string) || '(none)';
  const referenceImages = args['reference_images'] as string[] | undefined;
  const negativePrompt = (args['negative_prompt'] as string) || '';
  const aspectRatio = (args['aspect_ratio'] as string) || '16:9';
  const seed = args['seed'] as number | undefined;

  const [width, height] = ASPECT_DIMENSIONS[aspectRatio] || [1280, 720];
  const bgColor = FAKE_BG_COLOR;

  const params: Array<[string, string]> = [
    ['scene_number', String(sceneNumber)],
    ['aspect_ratio', aspectRatio],
    ['seed', seed !== undefined ? String(seed) : ''],
    ['base_image_path', baseImagePath],
    ['', ''],
    ['EDIT PROMPT', ''],
    ['', editPrompt],
    ['', ''],
    ['NEGATIVE PROMPT', ''],
    ['', negativePrompt || '(none)'],
  ];

  if (referenceImages && referenceImages.length > 0) {
    params.push(['', '']);
    params.push(['REFERENCE IMAGES', '']);
    for (const ref of referenceImages) {
      params.push(['', `- ${ref}`]);
    }
  }

  const jobId = `fake-edit-${Date.now()}-${nanoid(6)}`;
  const artifactId = `img_${nanoid(8)}`;
  const filename = `Scene${sceneNumber}_edit_fake_${nanoid(4)}.png`;
  const assetsDir = getAssetsDir();
  const outputPath = path.join(assetsDir, filename);

  await createPlaceholderImage(width, height, bgColor, 'edit_image', params, outputPath);

  const projectDir = getProjectDir();
  const relativePath = path.relative(projectDir, outputPath);

  const editJob: GenerationJob = {
    id: jobId,
    type: 'image',
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: {
      artifactId,
      path: outputPath,
    },
    context: {
      entityType: 'scene',
      sceneNumber,
      artifactType: 'image',
    },
  };
  jobs.set(jobId, editJob);

  try {
    addAsset({
      id: artifactId,
      type: 'scene_image',
      path: relativePath,
      createdAt: Date.now(),
      metadata: { jobId, fake: true },
    });
  } catch {
    // Project may not exist yet
  }

  return {
    status: 'submitted',
    job_id: jobId,
    message: `[FAKE] Image edit job completed instantly. Use wait_for_job("${jobId}") to get result.`,
    params: {
      scene_number: sceneNumber,
      base_image: baseImagePath,
      edit_prompt: editPrompt,
    },
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get fake video generation tools that replace real ComfyUI tools.
 * Same tool names, descriptions, and schemas — different handlers.
 */
export function getFakeVideoGenerationTools(): ToolDefinition[] {
  const fakeGenerateImage = createTool(
    generateImageTool.name,
    generateImageTool.description,
    generateImageTool.parameters,
    fakeGenerateImageHandler,
  );

  const fakeGenerateVideo = createTool(
    generateVideoFromImageTool.name,
    generateVideoFromImageTool.description,
    generateVideoFromImageTool.parameters,
    fakeGenerateVideoHandler,
  );

  const fakeEditImage = createTool(
    editImageTool.name,
    editImageTool.description,
    editImageTool.parameters,
    fakeEditImageHandler,
  );

  return [fakeGenerateImage, fakeGenerateVideo, fakeEditImage];
}
