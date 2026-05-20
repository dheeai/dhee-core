import { CONTENT_TYPE_OUTPUT_FILES } from '../tools/builtin/generateContentTool.js';

export interface GenerateContentPathArgs {
  contentType: string;
  instruction: string;
  name?: string;
  sceneNumber?: number;
  shotNumber?: number;
  chapterNumber?: number;
  outputFile?: string;
}

function extractOutputPathFromInstruction(instruction: string): string | undefined {
  const normalized = instruction.replace(/[`'"]/g, '');
  const match = normalized.match(
    /(?:save|write|store|output(?:_file)?)(?:\s+\w+){0,4}\s+(?:to|as|in)?\s*((?:plans|characters|settings|scenes|prompts|assets)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/i
  );
  return match?.[1];
}

function inferSceneNumberFromInstruction(instruction: string): number | undefined {
  const match = instruction.match(/\bscene\s*#?\s*(\d+)\b/i);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferShotNumberFromInstruction(instruction: string): number | undefined {
  const match = instruction.match(/\bshot\s*#?\s*(\d+)\b/i);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferChapterNumberFromInstruction(instruction: string): number | undefined {
  const match = instruction.match(/\bchapter\s*#?\s*(\d+)\b/i);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveStructuredContentOutputFile(
  contentType: string,
  resolved: string,
  {
    name,
    sceneNumber,
    shotNumber,
    chapterNumber,
  }: Pick<GenerateContentPathArgs, 'name' | 'sceneNumber' | 'shotNumber' | 'chapterNumber'>
): string | undefined {
  if ((contentType === 'character' || contentType === 'setting') && name) {
    const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return `${resolved.replace(/\/$/, '')}/${safeName}.profile.md`;
  }

  if (contentType === 'story') {
    const chapter = chapterNumber ?? 1;
    return `${resolved.replace(/\/$/, '')}/chapter-${chapter}.story.md`;
  }

  if (
    (contentType === 'character_image_prompt' || contentType === 'setting_image_prompt') &&
    name
  ) {
    const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return `${resolved.replace(/\/$/, '')}/${safeName}.prompt.md`;
  }

  if (contentType === 'scene' && sceneNumber !== undefined) {
    return `${resolved.replace(/\/$/, '')}/scene-${sceneNumber}.md`;
  }

  if (contentType === 'scene_image_prompt' && sceneNumber !== undefined) {
    return `${resolved.replace(/\/$/, '')}/scene-${sceneNumber}.prompt.md`;
  }

  if (contentType === 'scene_video_prompt' && sceneNumber !== undefined) {
    return `${resolved.replace(/\/$/, '')}/scene-${sceneNumber}.motion.json`;
  }

  if (
    contentType === 'shot_image_prompt' &&
    sceneNumber !== undefined &&
    shotNumber !== undefined
  ) {
    return `${resolved.replace(/\/$/, '')}/scene-${sceneNumber}-shot-${shotNumber}.prompt.md`;
  }

  return undefined;
}

export function resolveGenerateContentOutputFile({
  contentType,
  instruction,
  name,
  sceneNumber,
  shotNumber,
  chapterNumber,
  outputFile,
}: GenerateContentPathArgs): string {
  if (outputFile) {
    return outputFile;
  }

  const resolved = CONTENT_TYPE_OUTPUT_FILES[contentType] || `plans/${contentType}.md`;
  const structuredPath = resolveStructuredContentOutputFile(contentType, resolved, {
    name,
    sceneNumber: sceneNumber ?? inferSceneNumberFromInstruction(instruction),
    shotNumber: shotNumber ?? inferShotNumberFromInstruction(instruction),
    chapterNumber: chapterNumber ?? inferChapterNumberFromInstruction(instruction),
  });
  if (structuredPath) {
    return structuredPath;
  }

  const instructionPath = extractOutputPathFromInstruction(instruction);
  if (instructionPath) {
    return instructionPath;
  }

  return resolved;
}
