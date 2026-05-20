/**
 * File tools for the workflow - read_file, import_file, read_project, update_project.
 * These tools allow agents to read/write project files and manage project state.
 */

import { createTool } from '../../../core/tools/index.js';
import type { ToolDefinition } from '../../../core/llm/index.js';
import { getPhaseLogger } from '../../../utils/phaseLogger.js';
import {
  loadProject,
  writeProjectFile,
  getProjectSummary,
  projectExists,
  updateContentStatus,
  generateFileSummary,
  getProjectDir,
} from './ProjectManager.js';
import type {
  ProjectFile,
  ContentTypeName,
} from './types.js';
// read_file is imported from the canonical source — single definition for the entire system
import { readFileTool } from '../../../core/tools/builtin/contentCreatorTools.js';
import { listProjectTree, projectDirExists, readProjectText } from './projectFileIO.js';
export { readFileTool };

/**
 * Directories to exclude from project file listing.
 * These are internal/debug directories that agents shouldn't see or access.
 */
const EXCLUDED_DIRECTORIES = ['flows', 'logs', '.git'];

function normalizeProjectFilePath(filePath: string): string | null {
  const normalized = filePath.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
}

function collectTrackedAssetPaths(project: ProjectFile | null): string[] {
  const paths = new Set<string>();

  const addPath = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }
    const normalized = normalizeProjectFilePath(value);
    if (normalized) {
      paths.add(normalized);
    }
  };

  const registry = project?.content ?? {};
  for (const entry of Object.values(registry)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const itemFiles = (entry as { itemFiles?: Record<string, string> }).itemFiles;
    if (!itemFiles) {
      continue;
    }

    for (const filePath of Object.values(itemFiles)) {
      addPath(filePath);
    }
  }

  const manifestContent = readProjectText('assets/manifest.json');
  if (manifestContent) {
    try {
      const manifest = JSON.parse(manifestContent) as {
        assets?: Array<{ path?: string }>;
      };
      for (const asset of manifest.assets ?? []) {
        addPath(asset.path);
      }
    } catch {
      // Ignore malformed manifest content and fall back to tracked project paths.
    }
  }

  return Array.from(paths).sort((a, b) => a.localeCompare(b));
}

/**
 * List project files tool - returns the directory structure of the .dhee project.
 */
export const listProjectFilesTool: ToolDefinition = createTool(
  'list_project_files',
  `List all files in the project directory.

Returns the directory structure with file information:
- plans/ - Plot, story, scenes, and other planning documents
- characters/ - Character description files
- settings/ - Setting description files
- scenes/ - Individual scene files
- assets/ - Generated images and videos
- original_input.md - User's original input
- project.json - Project state and metadata

Use this to discover what content exists, then use read_file to access specific files.
This is the primary way to find available project content.`,
  {
    type: 'object',
    properties: {
      include_sizes: {
        type: 'boolean',
        description: 'Include file sizes in the output (default: false)',
      },
    },
    required: [],
  },
  async args => {
    const includeSizes = args['include_sizes'] === true;
    const projectDir = getProjectDir();

    if (!projectDirExists()) {
      return {
        status: 'no_project',
        content:
          '📁 No project directory found.\n\nCreate a project first using update_project with action "create".',
        message:
          'No project directory found. Create a project first using update_project with action "create".',
        files: [],
      };
    }

    // Get all files recursively
    const allFiles = listProjectTree({
      maxDepth: 3,
      excludeDirectories: EXCLUDED_DIRECTORIES,
    });
    const trackedAssetPaths = collectTrackedAssetPaths(loadProject());
    const knownPaths = new Set(allFiles.map(file => file.path));

    for (const assetPath of trackedAssetPaths) {
      if (knownPaths.has(assetPath)) {
        continue;
      }
      allFiles.push({
        path: assetPath,
        type: 'file',
      });
      knownPaths.add(assetPath);
    }

    allFiles.sort((a, b) => a.path.localeCompare(b.path));

    // Categorize files by type
    const categorized: Record<string, string[]> = {
      plans: [],
      characters: [],
      settings: [],
      scenes: [],
      assets: [],
      other: [],
    };

    const fileList: Array<{ path: string; type: string; size?: number }> = [];

    for (const file of allFiles) {
      if (file.type === 'directory') {
        continue; // Skip directory entries in output
      }

      // Skip internal files that agents shouldn't access directly
      if (file.path === 'project.json') {
        continue; // Use read_project tool instead
      }

      // Determine category
      let category = 'other';
      if (file.path.startsWith('plans/')) {
        category = 'plans';
      } else if (file.path.startsWith('characters/')) {
        category = 'characters';
      } else if (file.path.startsWith('settings/')) {
        category = 'settings';
      } else if (file.path.startsWith('scenes/')) {
        category = 'scenes';
      } else if (file.path.startsWith('assets/')) {
        category = 'assets';
      }

      categorized[category]?.push(file.path);

      const fileEntry: { path: string; type: string; size?: number } = {
        path: file.path,
        type: category,
      };
      if (includeSizes && file.size !== undefined) {
        fileEntry.size = file.size;
      }
      fileList.push(fileEntry);
    }

    // Build summary sections
    const summaryLines: string[] = [];
    summaryLines.push(`📁 Project Files - ${fileList.length} files total`);
    summaryLines.push('');

    if (categorized['plans'] && categorized['plans'].length > 0) {
      summaryLines.push(`**Plans** (${categorized['plans'].length}):`);
      for (const file of categorized['plans']) {
        summaryLines.push(`  - ${file}`);
      }
      summaryLines.push('');
    }
    if (categorized['characters'] && categorized['characters'].length > 0) {
      summaryLines.push(`**Characters** (${categorized['characters'].length}):`);
      for (const file of categorized['characters']) {
        summaryLines.push(`  - ${file}`);
      }
      summaryLines.push('');
    }
    if (categorized['settings'] && categorized['settings'].length > 0) {
      summaryLines.push(`**Settings** (${categorized['settings'].length}):`);
      for (const file of categorized['settings']) {
        summaryLines.push(`  - ${file}`);
      }
      summaryLines.push('');
    }
    if (categorized['scenes'] && categorized['scenes'].length > 0) {
      summaryLines.push(`**Scenes** (${categorized['scenes'].length}):`);
      for (const file of categorized['scenes']) {
        summaryLines.push(`  - ${file}`);
      }
      summaryLines.push('');
    }
    if (categorized['assets'] && categorized['assets'].length > 0) {
      summaryLines.push(`**Assets** (${categorized['assets'].length}):`);
      for (const file of categorized['assets']) {
        summaryLines.push(`  - ${file}`);
      }
      summaryLines.push('');
    }
    if (categorized['other'] && categorized['other'].length > 0) {
      summaryLines.push(`**Other** (${categorized['other'].length}):`);
      for (const file of categorized['other']) {
        summaryLines.push(`  - ${file}`);
      }
      summaryLines.push('');
    }

    // Build content string for UI display
    const content = summaryLines.join('\n');

    return {
      status: 'success',
      content, // This field is displayed in the UI
      project_directory: projectDir,
      total_files: fileList.length,
      files: fileList,
      usage_hint:
        'IMPORTANT: Use the EXACT file paths shown above with read_file(). For example: read_file(path="characters/mr_patel.md"). Do NOT use array indices like 0.md or 1.md - use the actual file names.',
    };
  }
);

/**
 * Import file tool - imports/copies content into a project file.
 */
export const importFileTool: ToolDefinition = createTool(
  'import_file',
  `Import external files into the project. RESTRICTED to non-creative content only.

ALLOWED uses:
- Copying a user-provided file (story, transcript, reference material) into the project
- Saving plan/outline metadata (plans/plot.md, plans/outline.md)

BLOCKED (will return error):
- prompts/images/* — use generate_content with content_type "scene_image_prompt", "character_image_prompt", "setting_image_prompt", or "shot_image_prompt"
- prompts/videos/* — use generate_content with content_type "scene_video_prompt"
- characters/* — use generate_content with content_type "character"
- settings/* — use generate_content with content_type "setting"
- plans/scenes/* — use generate_content with content_type "scene"
- plans/chapters/* — use generate_content with content_type "story"

generate_content provides user approval workflow and fetches proper context. import_file does not.`,
  {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Relative path within the project directory (e.g., "plans/outline.md")',
      },
      content: {
        type: 'string',
        description: 'Content to import into the project file',
      },
      summary: {
        type: 'string',
        description:
          'Optional brief summary of the content (1-2 sentences). Auto-generated if not provided.',
      },
    },
    required: ['file_path', 'content'],
  },
  async args => {
    const filePath = args['file_path'] as string;
    const content = args['content'] as string;
    const summary = args['summary'] as string | undefined;

    // Security: prevent path traversal
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return {
        status: 'error',
        error: 'Invalid file path. Use relative paths within the project directory.',
      };
    }

    // Block creative content paths — these MUST go through generate_content
    const creativePathPatterns = [
      /^prompts\/images\//,      // image prompts (character, setting, scene, shot)
      /^prompts\/videos\//,      // video/motion prompts
      /^characters\//,           // character profiles
      /^settings\//,             // setting profiles
      /^plans\/scenes\//,        // scene breakdowns
      /^plans\/chapters\//,      // story chapters
    ];
    if (creativePathPatterns.some(p => p.test(filePath))) {
      return {
        status: 'error',
        error: `Cannot use import_file for creative content path "${filePath}". Use generate_content instead — it provides user approval workflow and proper context. For image prompts use content_type "scene_image_prompt", "character_image_prompt", "setting_image_prompt", or "shot_image_prompt". For video prompts use content_type "scene_video_prompt".`,
      };
    }

    try {
      writeProjectFile(filePath, content);

      // Determine file type from path
      const fileTypeMap: Record<string, string> = {
        'plans/plot.md': 'plot',
        'plans/story.md': 'story',
        'plans/scenes.md': 'scenes_plan',
        'plans/images.md': 'images_plan',
        'plans/video.md': 'video_plan',
        'original_input.md': 'original_input',
      };

      let fileType = fileTypeMap[filePath];
      if (!fileType) {
        // Infer from path
        if (filePath.startsWith('characters/')) fileType = 'character';
        else if (filePath.startsWith('settings/')) fileType = 'setting';
        else if (filePath.startsWith('scenes/')) fileType = 'scene';
        else fileType = 'other';
      }

      // Generate summary if not provided
      const fileSummary = summary || generateFileSummary(content, fileType);

      // Extract name from path for character/setting/scene files
      let name: string | undefined;
      if (fileType === 'character' || fileType === 'setting') {
        const match = filePath.match(/\/([\w-]+)\.md$/);
        name = match?.[1] ? match[1].replace(/-/g, ' ') : undefined;
      } else if (fileType === 'scene') {
        const match = filePath.match(/scene[_-]?(\d+)/i);
        name = match?.[1] ? `Scene ${match[1]}` : undefined;
      }

      // Legacy `registerFile` (project.files[]) and `updateContentStatus`
      // (project.content[<type>].status) writes removed — the dependency
      // graph executor tracks file ownership via each node's `outputPath`.
      // `name` and `fileSummary` remain available locally if a future
      // need surfaces; they're not surfaced into project.json.
      void name; void fileSummary; void fileType;
      const project = loadProject();
      if (project) {
        // Plot / story content used to be flagged as "available" in
        // project.content here. The graph's `plot` / `story` per-node
        // status (`completed` once outputPath is written) is the
        // canonical signal now.
        void project;
        const contentType: ContentTypeName | undefined = undefined;
        if (contentType) {
          updateContentStatus(project, contentType, 'available');
        }
      }

      return {
        status: 'success',
        message: `File written and registered: ${filePath}`,
        file_path: filePath,
        bytes_written: content.length,
        summary: fileSummary,
        content,
      };
    } catch (error) {
      return {
        status: 'error',
        error: `Failed to write file: ${String(error)}`,
      };
    }
  }
);

/**
 * Read project tool - reads the project.json index file.
 */
export const readProjectTool: ToolDefinition = createTool(
  'read_project',
  `Read the project.json index file to check phase statuses, planner stages, and project metadata.

Returns:
- Project ID and title
- Original user input
- Current phase and planner stage
- Phase statuses (pending, in_progress, completed)
- List of characters, settings, scenes, and assets
- State transition instructions (what to do next)

Use this at the start of each turn to understand the project state and what action to take.`,
  {
    type: 'object',
    properties: {
      include_summary: {
        type: 'boolean',
        description: 'If true, include a human-readable summary (default: true)',
      },
      include_transition_prompt: {
        type: 'boolean',
        description: 'If true, include instructions for what to do next (default: true)',
      },
    },
    required: [],
  },
  async args => {
    const includeSummary = args['include_summary'] !== false;
    const includeTransitionPrompt = args['include_transition_prompt'] !== false;

    if (!projectExists()) {
      return {
        status: 'no_project',
        message: 'No project found. Use update_project with action "create" to create one.',
      };
    }

    const project = loadProject();

    if (!project) {
      return {
        status: 'error',
        error: 'Failed to load project file.',
      };
    }

    // Set phase context in phaseLogger for all subsequent logs
    const phaseLogger = getPhaseLogger();
    const currentPhaseInfo = project.phases[project.currentPhase];
    phaseLogger.setContext({
      phase: project.currentPhase,
      stage: currentPhaseInfo?.plannerStage,
      projectId: project.id,
    });

    const result: Record<string, unknown> = {
      status: 'success',
      project: project,
    };

    if (includeSummary) {
      result['summary'] = getProjectSummary();
    }

    // Legacy `getStateTransitionPrompt` removed — phase transitions
    // are now driven by the dependency graph executor's deps[], not
    // by a string prompt threaded into the agent's system message.
    void includeTransitionPrompt;

    return result;
  }
);


/**
 * Get workflow file tools for the orchestrator.
 * Only includes project state tools - content files are handled by subagents via Task.
 */
export function getWorkflowFileTools(): ToolDefinition[] {
  return [listProjectFilesTool, readProjectTool];
}

/**
 * Get all file tools including read_file/import_file (for subagents that need direct file access).
 */
export function getAllFileTools(): ToolDefinition[] {
  return [listProjectFilesTool, readFileTool, importFileTool, readProjectTool];
}

