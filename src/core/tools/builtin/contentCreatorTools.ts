/**
 * Canonical read_file and read_project tool definitions.
 *
 * These are the SINGLE source of truth for file/project reading tools.
 * Used by: orchestrator (via registries), content creator sub-agents, context-gathering.
 * Do NOT define read_file or read_project anywhere else.
 */
import type { ToolDefinition } from '../../llm/index.js';
import { getCurrentSession } from '../../fs/index.js';
import { loadProject } from '../../../tasks/video/workflow/ProjectManager.js';
import fs from 'fs';
import path from 'path';
import type { ProjectFile } from '../../../tasks/video/workflow/types.js';
import {
  getKnownProjectPaths,
  isWithinProjectRoot,
  projectRelativePath,
  readProjectText,
} from '../../../tasks/video/workflow/projectFileIO.js';

/**
 * Session-level tracking of known project file paths.
 * When list_project_files() is called, its results are registered here.
 * Subsequent read_file() calls for relative paths are validated against this set.
 */
let knownProjectFiles: Set<string> | null = null;

/**
 * Register known project file paths from a list_project_files() result.
 * Called by GenericAgent.executeContentCreatorTool when list_project_files runs.
 */
export function registerKnownProjectFiles(filePaths: string[]): void {
  knownProjectFiles = new Set(filePaths);
}

/**
 * Clear the known project files set. Call this when starting a new content session.
 */
export function clearKnownProjectFiles(): void {
  knownProjectFiles = null;
}

function inferFileType(filePath: string): string {
  if (filePath === 'original_input.md') return 'original_input';
  if (filePath === 'plans/plot.md') return 'plot';
  if (filePath === 'plans/story.md') return 'story';
  if (/^plans\/chapters\/chapter-\d+\.story\.md$/i.test(filePath)) return 'story_chapter';
  if (filePath.startsWith('characters/')) return 'character';
  if (filePath.startsWith('settings/')) return 'setting';
  if (filePath.startsWith('plans/scenes/') || filePath.startsWith('scenes/')) return 'scene';
  if (filePath.startsWith('assets/')) return 'asset';
  return 'other';
}

function buildLiveProjectFiles(project: ProjectFile): Array<NonNullable<ProjectFile['files']>[number]> {
  const filesByPath = new Map<string, NonNullable<ProjectFile['files']>[number]>();

  for (const file of project.files || []) {
    filesByPath.set(file.path, file);
  }

  for (const filePath of getKnownProjectPaths()) {
    if (filePath === 'project.json') {
      continue;
    }
    if (!filesByPath.has(filePath)) {
      filesByPath.set(filePath, {
        type: inferFileType(filePath),
        path: filePath,
      });
    }
  }

  return Array.from(filesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export function buildProjectReadSummary(project: ProjectFile): Record<string, unknown> {
  return {
    style: project.style,
    templateId: (project as unknown as Record<string, unknown>)['templateId'] ?? 'narrative',
    currentPhase: project.currentPhase,
    characters: (project.characters || []).map((char: { name: string }) => ({
      name: char.name,
      file: project.content?.characters?.itemFiles?.[char.name] ||
        `characters/${char.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.profile.md`,
    })),
    settings: (project.settings || []).map((setting: { name: string }) => ({
      name: setting.name,
      file: project.content?.settings?.itemFiles?.[setting.name] ||
        `settings/${setting.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.profile.md`,
    })),
    scenes: (project.scenes || []).map((scene: { sceneNumber: number; title?: string; imageArtifactId?: string }) => ({
      sceneNumber: scene.sceneNumber,
      title: scene.title,
      imageArtifactId: scene.imageArtifactId,
    })),
    files: buildLiveProjectFiles(project),
  };
}

/**
 * Read project structure tool - understand what content exists.
 */
export const readProjectTool: ToolDefinition = {
  name: 'read_project',
  description: 'Read the project structure to understand what content exists (story, characters, settings, etc.)',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const project = loadProject();
      if (!project) {
        return 'No project found. The project has not been initialized yet.';
      }
      return JSON.stringify(buildProjectReadSummary(project), null, 2);
    } catch (err) {
      return `Error reading project: ${String(err)}`;
    }
  },
};

/**
 * Normalize all quote-like characters to ASCII double quote for comparison.
 */
function normalizeQuotes(s: string): string {
  return s.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\u00AB\u00BB"]/g, '"');
}

function resolveProjectRelativePath(filePath: string): string | null {
  try {
    return projectRelativePath(filePath);
  } catch {
    return null;
  }
}

function resolveExactKnownPath(candidate: string): string | null {
  const normalizedCandidate = resolveProjectRelativePath(candidate);
  if (!normalizedCandidate) {
    return null;
  }

  const knownPaths = getKnownProjectPaths();
  return knownPaths.includes(normalizedCandidate) ? normalizedCandidate : null;
}

/**
 * Try multiple path variants to find a file that exists.
 * Handles shell escapes, smart quote ↔ ASCII quote differences,
 * and fuzzy directory segment matching.
 */
export function tryPathVariants(filePath: string): string | null {
  // 1. Try exact project path matches first
  const exactProjectPath = resolveExactKnownPath(filePath);
  if (exactProjectPath) return exactProjectPath;

  // 2. Try cleaning terminal shell escapes (e.g., \, → , and \ → space)
  const cleaned = filePath.replace(/\\(.)/g, '$1');
  const cleanedProjectPath = resolveExactKnownPath(cleaned);
  if (cleanedProjectPath) return cleanedProjectPath;

  // 3. Try replacing ASCII quotes with Unicode smart quotes (paired left/right).
  let isLeft = true;
  const smartQuoteVariant = cleaned.replace(/"/g, () => {
    const q = isLeft ? '\u201C' : '\u201D';
    isLeft = !isLeft;
    return q;
  });
  const smartProjectPath = resolveExactKnownPath(smartQuoteVariant);
  if (smartProjectPath) return smartProjectPath;

  // 4. Try the reverse: smart quotes → ASCII
  const asciiQuoteVariant = cleaned.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
  const asciiProjectPath = resolveExactKnownPath(asciiQuoteVariant);
  if (asciiProjectPath) return asciiProjectPath;

  // 5. Fuzzy match against known project paths.
  const resolved = resolvePathFuzzy(cleaned);
  if (resolved) return resolved;

  return null;
}

/**
 * Resolve a path segment-by-segment, fuzzy-matching each component
 * against actual directory entries (normalizing quotes for comparison).
 */
function resolvePathFuzzy(filePath: string): string | null {
  const normalizedCandidate = resolveProjectRelativePath(filePath);
  if (!normalizedCandidate) {
    return null;
  }

  const candidateSegments = normalizedCandidate.split('/').filter(Boolean);
  const knownPaths = getKnownProjectPaths();

  for (const knownPath of knownPaths) {
    const knownSegments = knownPath.split('/').filter(Boolean);
    if (knownSegments.length !== candidateSegments.length) {
      continue;
    }

    const matches = knownSegments.every(
      (segment, index) => normalizeQuotes(segment) === normalizeQuotes(candidateSegments[index] || ''),
    );
    if (matches) {
      return knownPath;
    }
  }

  return null;
}

/**
 * Read file tool - reads from project directory or any absolute path.
 *
 * This is the SINGLE read_file tool for the entire system.
 */
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: `Read a file from the project or from an absolute path on the filesystem.

For project files: use relative paths like "characters/alice.md" (resolved under the project directory).
For external files: use absolute paths like "/Users/alice/Documents/story.txt".

**IMPORTANT for project files**: ALWAYS call read_project or list_project_files FIRST to get actual file names.
NEVER guess file names like "0.md", "1.md" - files are named by content (e.g., "characters/alice.md").

If this returns "File not found", call read_project or list_project_files to see what files actually exist.`,
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'File path. Absolute paths (starting with /) read from the filesystem directly. Relative paths read from the project directory.',
      },
    },
    required: ['file_path'],
  },
  handler: async (args: Record<string, unknown>) => {
    // Accept both 'file_path' and 'path' for backward compatibility
    const filePath = (args['file_path'] ?? args['path']) as string;
    if (!filePath) {
      return { status: 'error', error: 'path is required' };
    }

    const isAbsolutePath = path.isAbsolute(filePath);
    const isProjectPath = !isAbsolutePath || isWithinProjectRoot(filePath);
    const currentSession = getCurrentSession();

    // For relative paths: reject numeric index guessing (common LLM mistake)
    if (!isAbsolutePath) {
      // Security: prevent path traversal
      if (filePath.includes('..')) {
        return {
          status: 'error',
          error: 'Invalid file path. Use relative paths within the project directory or absolute paths for external files.',
        };
      }

      const numericIndexPattern = /^(characters|settings|scenes)\/\d+\.md$/;
      if (numericIndexPattern.test(filePath)) {
        return {
          status: 'error',
          error: `FORBIDDEN: You used a numeric index "${filePath}".`,
          instruction: 'You MUST call list_project_files FIRST to discover actual file names.',
        };
      }

      const bareNumericPattern = /^\d+\.md$/;
      if (bareNumericPattern.test(filePath)) {
        return {
          status: 'error',
          error: `FORBIDDEN: You used "${filePath}" - this is NOT a valid file path.`,
          instruction: 'You MUST call list_project_files to get actual file names. Files are named by content, not by index.',
        };
      }

      // Validate against known project files if list_project_files has been called
      if (knownProjectFiles !== null) {
        // Normalize path for comparison (remove leading ./ or /)
        const normalizedPath = filePath.replace(/^\.\//, '');
        const isKnown = knownProjectFiles.has(normalizedPath) ||
          knownProjectFiles.has(`./${normalizedPath}`) ||
          knownProjectFiles.has(`/${normalizedPath}`) ||
          // Also check if any known path ends with this path (for partial matches)
          Array.from(knownProjectFiles).some(kp => kp.endsWith(normalizedPath));

        if (!isKnown) {
          return {
            status: 'error',
            error: `Path "${filePath}" not found in project files. Call list_project_files() first to discover available files.`,
            hint: 'Only paths returned by list_project_files() or read_project() are valid.',
          };
        }
      }
    }

    if (isAbsolutePath && !isProjectPath && currentSession?.mode === 'remote') {
      return {
        status: 'error',
        error: `Absolute path is outside the active project root: ${filePath}`,
        hint: 'In remote mode, read_file only supports project files under the active .dhee directory.',
      };
    }

    try {
      const resolvedPath = isProjectPath ? tryPathVariants(filePath) : filePath;

      if (!resolvedPath) {
        return {
          status: 'error',
          error: `File not found: ${filePath}`,
          hint: 'Use list_project_files to see available files and their exact paths.',
        };
      }

      // Guard: only allow reading text files to prevent binary blobs from blowing up context
      const ALLOWED_TEXT_EXTENSIONS = new Set([
        '.txt', '.md', '.json', '.jsonl',
        '.yaml', '.yml', '.toml', '.csv', '.tsv',
        '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
        '.py', '.sh', '.bash', '.zsh',
        '.html', '.htm', '.css', '.scss', '.less',
        '.xml', '.svg', '.env', '.ini', '.cfg', '.conf',
        '.log', '.prompt',
      ]);
      const ext = path.extname(resolvedPath).toLowerCase();
      if (ext && !ALLOWED_TEXT_EXTENSIONS.has(ext)) {
        return {
          status: 'error',
          error: `Cannot read binary file: ${filePath} (extension: ${ext}). Only text files are readable.`,
          hint: 'This file is a binary asset (image, video, etc). Use its artifact ID or path to reference it in tools — do not read its contents.',
        };
      }

      const content = isProjectPath
        ? readProjectText(resolvedPath)
        : fs.readFileSync(resolvedPath, 'utf-8');
      if (content == null) {
        return {
          status: 'error',
          error: `File not found: ${filePath}`,
          hint: 'Use list_project_files to see available files and their exact paths.',
        };
      }
      return {
        status: 'success',
        file_path: filePath,
        content,
        length: content.length,
      };
    } catch (err) {
      return { status: 'error', error: `Error reading file: ${String(err)}` };
    }
  },
};

/**
 * List project files tool definition for the content creator sub-agent.
 * This is a lightweight schema-only definition (handler is in GenericAgent.executeContentCreatorTool).
 * Avoids circular imports with FileTools.ts which imports readFileTool from this file.
 */
export const contentCreatorListProjectFilesTool: ToolDefinition = {
  name: 'list_project_files',
  description: `List all files in the project directory. Returns file paths organized by category (plans, characters, settings, scenes, assets).

Use this to discover what files actually exist on disk — especially asset files like reference images.
IMPORTANT: Only reference image paths that appear in this listing actually exist. Do NOT fabricate or guess paths.`,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * Get all content creator tools (read_project + read_file + list_project_files).
 */
export function getContentCreatorTools(): ToolDefinition[] {
  return [readProjectTool, readFileTool, contentCreatorListProjectFilesTool];
}
