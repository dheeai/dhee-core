/**
 * Content Resolver for the Dependency Graph Executor
 *
 * Resolves all inputs for a given execution node by reading the outputs
 * of its completed dependencies. This replaces the agent's need to read
 * files — all I/O happens here in deterministic code.
 *
 * Based on the pattern from src/core/agent/contentContext.ts but generalized
 * to work with graph nodes rather than hardcoded content types.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExecutionNode, ResolvedInputs } from './types.js';
import type { DependencyGraphExecutor } from './DependencyGraphExecutor.js';
import { atomicWriteFileSync } from '../../utils/atomicWrite.js';

/**
 * Safely read a file from a project directory.
 * Returns content or null if not found/readable.
 */
function readFile(projectDir: string, relativePath: string): string | null {
  try {
    const fullPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(projectDir, relativePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
  } catch {
    // File not readable
  }
  return null;
}

/**
 * Check if a file exists in the project directory.
 */
function fileExists(projectDir: string, relativePath: string): boolean {
  const fullPath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(projectDir, relativePath);
  return fs.existsSync(fullPath);
}

/**
 * Resolve all inputs for a node by reading its completed dependencies' outputs.
 *
 * This is the core function that makes the agent's file reading unnecessary.
 * The code reads everything the node needs and packages it into a context block.
 */
export function resolveInputs(
  node: ExecutionNode,
  executor: DependencyGraphExecutor,
  projectDir: string,
): ResolvedInputs {
  const filesRead: string[] = [];
  const dependencies: Record<string, string> = {};
  const referenceImages: ResolvedInputs['referenceImages'] = [];
  const sections: string[] = [];

  // Add node metadata header
  sections.push(`### Task
**Creating:** ${node.displayName}
**Type:** ${node.typeId}${node.itemId ? `\n**Item:** ${node.itemId}` : ''}`);

  // For root nodes (no dependencies, e.g., plot): inject original_input.md as context
  if (node.dependencies.length === 0) {
    const originalInput = readFile(projectDir, 'original_input.md');
    if (originalInput) {
      filesRead.push('original_input.md');
      dependencies['original_input'] = originalInput;
      sections.push(`### Original User Input\n**File:** original_input.md\n\n${originalInput}`);
    }
  }

  // Read each dependency's output
  for (const depId of node.dependencies) {
    const depNode = executor.getNode(depId);
    if (!depNode) continue;
    if (depNode.status !== 'completed' && depNode.status !== 'skipped') continue;

    // Read the dependency's output file (skip binary files like images/videos)
    if (depNode.outputPath) {
      const ext = depNode.outputPath.split('.').pop()?.toLowerCase() ?? '';
      const isBinary = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov'].includes(ext);
      if (!isBinary) {
        const content = readFile(projectDir, depNode.outputPath);
        if (content) {
          filesRead.push(depNode.outputPath);
          dependencies[depId] = content;
          sections.push(`### ${depNode.displayName}\n**File:** ${depNode.outputPath}\n\n${content}`);
        }
      } else {
        // Binary files are tracked as reference images, not text context
        filesRead.push(depNode.outputPath);
      }
    }

    // Collect reference images from visual_ref dependencies
    const depTypeDef = executor.getTemplate().artifactTypes[depNode.typeId];
    if (depTypeDef?.category === 'visual_ref' && depNode.outputPath) {
      // For image artifacts, outputPath is the image file
      if (fileExists(projectDir, depNode.outputPath)) {
        const refType = depNode.typeId.includes('character') ? 'character' as const : 'setting' as const;
        referenceImages.push({
          name: depNode.itemId ?? depNode.displayName,
          path: depNode.outputPath,
          type: refType,
        });
      }
    }
  }

  // Build the context block
  const contextBlock = sections.length > 1
    ? `<context>
All required inputs for this generation have been pre-loaded below.
Generate content using ONLY the provided context.

${sections.join('\n\n---\n\n')}
</context>`
    : '';

  return {
    contextBlock,
    dependencies,
    referenceImages,
    filesRead,
  };
}

/**
 * Determine the output file path for a node based on its type and template.
 *
 * Uses the filePattern from the ArtifactTypeDefinition with placeholder substitution.
 */
export function getOutputPath(
  node: ExecutionNode,
  _projectDir: string,
  template: ReturnType<DependencyGraphExecutor['getTemplate']>,
): string {
  const typeDef = template.artifactTypes[node.typeId];
  if (!typeDef) {
    // Fallback: generic path
    return node.itemId
      ? `plans/${node.typeId}/${node.itemId}.md`
      : `plans/${node.typeId}.md`;
  }

  let filePath = typeDef.filePattern;

  // Override file patterns for nodes that produce prompts (not actual media).
  // Image prompts → .json, motion prompts → .json
  const isMediaCategory = typeDef.category === 'visual_ref' || typeDef.category === 'clip';

  if (isMediaCategory) {
    const safeName = node.itemId
      ? node.itemId.toLowerCase().replace(/[^a-z0-9]+/g, '_')
      : node.typeId;

    if (typeDef.category === 'visual_ref') {
      // Character/setting image prompts as JSON
      const subdir = node.typeId.includes('character') ? 'characters'
        : node.typeId.includes('setting') ? 'settings'
        : node.typeId.includes('scene') ? 'scenes'
        : 'other';
      filePath = `prompts/images/${subdir}/${safeName}.json`;
    } else if (typeDef.category === 'clip') {
      // Clip nodes don't generate files (deterministic)
      filePath = `prompts/videos/scenes/${safeName}.json`;
    }
  }

  // scene_video_prompt: uses template filePattern (already .motion.json) but with safe name
  if (node.typeId === 'scene_video_prompt' || node.typeId.includes('video_prompt')) {
    const safeName = node.itemId
      ? node.itemId.toLowerCase().replace(/[^a-z0-9]+/g, '_')
      : node.typeId;
    filePath = `prompts/videos/scenes/${safeName}.json`;
  }

  // scene_shot_plan (Stage A of hierarchical breakdown): lightweight plan
  // JSON, sits next to the assembled scene_video_prompt output.
  if (node.typeId === 'scene_shot_plan' && node.itemId) {
    const safeName = node.itemId.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    filePath = `prompts/videos/scenes/${safeName}.plan.json`;
  }

  // shot_breakdown (Stage B): per-shot JSON, grouped under a per-scene
  // subdirectory so the project tree groups intermediates per scene
  // (e.g. prompts/videos/scenes/scene_1.shots/3.json).
  if (node.typeId === 'shot_breakdown' && node.itemId) {
    // itemId is `scene_N_shot_M`. Compute the per-scene subdir from the
    // scene portion and the shot number for the filename.
    const sceneMatch = node.itemId.match(/^(scene_\d+)_shot_(\d+)$/);
    if (sceneMatch) {
      const sceneSafe = sceneMatch[1]!.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const shotNum = sceneMatch[2]!;
      filePath = `prompts/videos/scenes/${sceneSafe}.shots/${shotNum}.json`;
    } else {
      const safeName = node.itemId.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      filePath = `prompts/videos/scenes/${safeName}.shot.json`;
    }
  }

  // shot_motion_directive: structured JSON alongside other prompts
  if (node.typeId === 'shot_motion_directive') {
    const safeName = node.itemId
      ? node.itemId.toLowerCase().replace(/[^a-z0-9]+/g, '_')
      : node.typeId;
    filePath = `prompts/motion/${safeName}.json`;
  }

  // Substitute placeholders
  filePath = filePath.replace('{{chapter}}', 'chapter_1');

  if (node.itemId) {
    const safeName = node.itemId.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    filePath = filePath.replace('{{name}}', safeName);
    filePath = filePath.replace('{{id}}', node.itemId);

    // Extract scene index (first number) and shot/sub index (second number)
    // e.g., "scene_1" → index=1, "scene_1_shot_3" → index=1, subindex=3
    const allNumbers = node.itemId.match(/\d+/g);
    if (allNumbers && allNumbers[0]) {
      filePath = filePath.replace('{{index}}', allNumbers[0]);
    }
    if (allNumbers && allNumbers[1]) {
      filePath = filePath.replace('{{subindex}}', allNumbers[1]);
    }
  }

  // Remove any remaining unresolved placeholders
  filePath = filePath.replace(/\{\{[^}]+\}\}/g, '');

  return filePath;
}

/**
 * Write content to the output path for a node.
 * Creates parent directories as needed.
 * Returns the relative path where the file was written.
 */
export function writeOutput(
  node: ExecutionNode,
  content: string,
  projectDir: string,
  template: ReturnType<DependencyGraphExecutor['getTemplate']>,
): string {
  const relativePath = getOutputPath(node, projectDir, template);
  const fullPath = path.join(projectDir, relativePath);

  // Ensure parent directory exists
  const parentDir = path.dirname(fullPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  atomicWriteFileSync(fullPath, content, 'utf-8');
  return relativePath;
}
