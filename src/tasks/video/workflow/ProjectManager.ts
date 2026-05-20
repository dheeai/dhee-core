/**
 * ProjectManager - Handles project file creation, reading, and updating.
 * Manages the *.dhee directory structure and project.json index file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { isAbsolute, join } from 'path';
import {
  extractHeadingName,
  extractSceneTitle as extractSceneTitleFromContent,
  isLikelyToolChatter,
  isValidSceneContent,
  normalizeProfileName,
} from '../../../core/contentValidation.js';
import {
  type ProjectFile,
  type PhaseInfo,
  type PhaseStatus,
  type CharacterData,
  type SettingData,
  type SceneRef,
  type AssetInfo,
  type ContentRegistry,
  type ContentEntry,
  type ContentTypeName,
  type ContentStatus,
  type ItemApprovalStatus,
  type ItemApprovalEntry,
  type PhaseConfig,
  type ProjectStyle,
  type StyleConfig,
  type InputType,
  WorkflowPhase,
  PlannerStage,
  PHASE_CONFIGS,
  PHASE_ORDER,
  STYLE_CONFIGS,
  INPUT_TYPE_CONFIGS,
  PROJECT_FILE,
  PROJECT_VERSION,
  createDefaultCharacterData,
  createDefaultSettingData,
  createDefaultSceneRef,
} from './types.js';
import { setShotFrame, setShotVideo, setFinalVideo } from '../../../core/project/projectSchema.js';
import { generateProjectTitle, contextStore } from '../../../core/context/index.js';
// Legacy `initializeArtifactsFromFiles` / `createArtifactFromFile`
// removed with the artifact tools layer. Project state is now the
// dependency-graph executor's `executorState`.
import { TemplateRegistry } from '../../../core/templates/TemplateRegistry.js';
import type { PhaseDefinition } from '../../../core/templates/types.js';
import { getActiveProjectDir, setActiveProjectDir } from './activeProject.js';
import {
  defaultBasePath,
  ensureProjectDir,
  listProjectEntries,
  projectExists as projectFileExists,
  readProjectText,
  writeProjectText,
} from './projectFileIO.js';

/**
 * Get the project directory path for the current working directory.
 */
export function getProjectDir(basePath: string = defaultBasePath()): string {
  const activeProjectDir = getActiveProjectDir();
  if (isAbsolute(activeProjectDir)) {
    return activeProjectDir;
  }
  return join(basePath, activeProjectDir);
}

/**
 * Summary info returned by scanProjects().
 */
export interface ProjectInfo {
  /** Directory name (e.g., "story.dhee") */
  dirName: string;
  /** Project title from project.json */
  title: string;
  /** Template ID (e.g., "narrative", "documentary") */
  templateId: string;
  /** Current workflow phase */
  currentPhase: string;
  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * Scan for all *.dhee project directories under basePath.
 * Returns an array of project summaries sorted by most recently updated.
 */
export function scanProjects(basePath: string = defaultBasePath()): ProjectInfo[] {
  if (!existsSync(basePath)) return [];

  const entries = readdirSync(basePath, { withFileTypes: true });
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dhee')) continue;

    const projectJsonPath = join(basePath, entry.name, PROJECT_FILE);
    if (!existsSync(projectJsonPath)) continue;

    try {
      const raw = readFileSync(projectJsonPath, 'utf-8');
      const data = JSON.parse(raw);
      projects.push({
        dirName: entry.name,
        title: entry.name.replace(/\.dhee$/, ''),
        templateId: data.templateId ?? 'narrative',
        currentPhase: data.currentPhase ?? 'unknown',
        updatedAt: data.updatedAt ?? 0,
      });
    } catch {
      // Skip malformed project files
    }
  }

  // Sort by most recently updated first
  projects.sort((a, b) => b.updatedAt - a.updatedAt);
  return projects;
}

/**
 * Infer a project directory name from the user's input content.
 * Uses generateProjectTitle() to create a slug, appends ".dhee",
 * and handles collisions by appending a number suffix.
 */
export function inferProjectDirName(content: string, basePath: string = defaultBasePath()): string {
  const slug = generateProjectTitle(content);
  const base = `${slug}.dhee`;

  if (!existsSync(join(basePath, base))) {
    return base;
  }

  // Handle collision
  let counter = 2;
  while (existsSync(join(basePath, `${slug}-${counter}.dhee`))) {
    counter++;
  }
  return `${slug}-${counter}.dhee`;
}

/**
 * Get the project file path.
 */
export function getProjectFilePath(basePath: string = defaultBasePath()): string {
  return join(getProjectDir(basePath), PROJECT_FILE);
}

/**
 * Check if a project exists in the current directory.
 */
export function projectExists(basePath: string = defaultBasePath()): boolean {
  return projectFileExists(PROJECT_FILE, basePath);
}

/**
 * Delete an existing project and all its files.
 * Use with caution - this permanently removes all project data.
 * Also clears the context store to ensure a clean slate.
 */
export function deleteProject(basePath: string = defaultBasePath()): boolean {
  const projectDir = getProjectDir(basePath);

  // Always clear the context store to remove old context variables
  contextStore.clear();

  if (!existsSync(projectDir)) {
    return false;
  }

  try {
    rmSync(projectDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the initial project directory structure.
 * Only creates directories - plan files are created on first write.
 */
export function createProjectStructure(basePath: string = defaultBasePath()): void {
  const projectDir = getProjectDir(basePath);

  // Create main directories only - no empty files
  const dirs = [
    projectDir,
    join(projectDir, 'plans'),
    join(projectDir, 'plans', 'chapters'), // For chapter-based story files
    join(projectDir, 'characters'),
    join(projectDir, 'settings'),
    join(projectDir, 'assets'),
    // Prompt directories for image/video prompt files
    join(projectDir, 'prompts'),
    join(projectDir, 'prompts', 'images'),
    join(projectDir, 'prompts', 'images', 'characters'),
    join(projectDir, 'prompts', 'images', 'settings'),
    join(projectDir, 'prompts', 'images', 'scenes'),
    join(projectDir, 'prompts', 'videos'),
    join(projectDir, 'prompts', 'videos', 'scenes'),
  ];

  for (const dir of dirs) {
    ensureProjectDir(dir, basePath);
  }

  // Create empty assets manifest (needed for asset tracking)
  if (!projectFileExists('assets/manifest.json', basePath)) {
    writeProjectText('assets/manifest.json', JSON.stringify({ assets: [] }, null, 2), basePath);
  }

  // NOTE: Plan files (plot.md, story.md, etc.) are created on first write
  // via writeProjectFile(), not here. This avoids empty files cluttering the project.
}

/**
 * Create a minimal content registry with status tracking only.
 * File paths are NOT included - they are set when content is actually created.
 * This avoids confusion about files that don't exist yet.
 */
export function createDefaultContentRegistry(): ContentRegistry {
  return {
    plot: { status: 'missing' },
    story: { status: 'missing' },
    characters: { status: 'missing', items: [] },
    settings: { status: 'missing', items: [] },
    scenes: { status: 'missing', items: [] },
    images: { status: 'missing', items: [] },
    videos: { status: 'missing', items: [] },
  };
}

/**
 * Strip XML-like tags from content (e.g., <user_task>, [STORED CONTENT:], etc.)
 */
function stripWrapperTags(content: string): string {
  return (
    content
      // Remove <user_task>...</user_task> tags
      .replace(/<user_task>\s*/gi, '')
      .replace(/\s*<\/user_task>/gi, '')
      // Remove [user_task]... prefix
      .replace(/^\[user_task\]\s*/i, '')
      // Remove [STORED CONTENT: ...] blocks
      .replace(
        /\[STORED CONTENT:[^\]]*\]\s*context_ref:[^\n]*\n[^\n]*\n\nPreview:[^\n]*\n\n[^\n]*\n[^\n]*/gi,
        ''
      )
      .trim()
  );
}

/**
 * Build the fixed 8-phase structure for narrative projects.
 */
function buildNarrativePhases(): Record<string, import('./types.js').PhaseInfo> {
  return {
    plot: { status: 'pending', completedAt: null },
    story: { status: 'pending', completedAt: null },
    characters_settings: { status: 'pending', completedAt: null },
    scenes: { status: 'pending', completedAt: null },
    character_setting_images: { status: 'pending', completedAt: null },
    scene_images: { status: 'pending', completedAt: null },
    video: { status: 'pending', completedAt: null },
    video_combine: { status: 'pending', completedAt: null },
  };
}

/**
 * Create a new project file with the given input.
 * Stores originalInput in a separate file, only reference in project.json.
 * @param originalInput - The original story/prompt input
 * @param style - The visual style for the project (cinematic_realism or anime)
 * @param basePath - Base path for the project
 * @param targetDuration - Target video duration in seconds
 * @param templateId - Template to use for phase structure (default: narrative)
 */
export function createProject(
  originalInput: string,
  styleOrBasePath: ProjectStyle | string = 'cinematic_realism',
  basePathMaybe: string = process.cwd(),
  targetDuration?: number,
  templateId?: string
): ProjectFile {
  // Determine style and basePath.
  // If styleOrBasePath looks like a filesystem path, treat it as basePath (old signature).
  // Otherwise treat it as a style name.
  const looksLikePath =
    styleOrBasePath.startsWith('/') ||
    styleOrBasePath.startsWith('./') ||
    styleOrBasePath.startsWith('~');
  const style: ProjectStyle = looksLikePath
    ? 'cinematic_realism'
    : (styleOrBasePath as ProjectStyle);
  const basePath: string = looksLikePath
    ? String(styleOrBasePath)
    : basePathMaybe;

  // In desktop/remote mode the active project dir may already be an absolute
  // workspace path. Preserve it instead of inferring and switching roots.
  const activeProjectDir = getActiveProjectDir();
  const inferredDir = isAbsolute(activeProjectDir)
    ? activeProjectDir
    : inferProjectDirName(originalInput, basePath);
  setActiveProjectDir(inferredDir);

  // Ensure directory structure exists
  createProjectStructure(basePath);

  // If input looks like a file path and the file exists, read its contents
  let resolvedInput = originalInput;
  const trimmedInput = originalInput.trim();
  if (!trimmedInput.includes('\n') && (trimmedInput.startsWith('/') || trimmedInput.startsWith('~') || trimmedInput.startsWith('./'))) {
    const expandedPath = trimmedInput.startsWith('~')
      ? join(process.env['HOME'] || '', trimmedInput.slice(1))
      : trimmedInput;
    if (existsSync(expandedPath)) {
      resolvedInput = readFileSync(expandedPath, 'utf-8');
    }
  }

  // Clean the input - remove any XML tags or wrapper formats
  const cleanInput = stripWrapperTags(resolvedInput);

  const now = Date.now();
  const projectId = `proj-${now}-${Math.random().toString(36).slice(2, 8)}`;

  // Save original input to a separate file
  const inputFilePath = 'original_input.md';
  writeProjectText(inputFilePath, cleanInput, basePath);

  // Build phases based on template
  const isNonNarrativeTemplate = templateId && templateId !== 'narrative';
  let phases: Record<string, import('./types.js').PhaseInfo>;
  let initialPhase: string;

  if (isNonNarrativeTemplate) {
    const template = TemplateRegistry.getInstance().get(templateId);
    if (template?.phases && template.phases.length > 0) {
      // Sort template phases by order, build dynamic phases
      const sortedPhases = [...template.phases].sort((a, b) => a.order - b.order);
      phases = {};
      for (const phase of sortedPhases) {
        phases[phase.id] = { status: 'pending', completedAt: null };
      }
      initialPhase = sortedPhases[0]!.id;
    } else {
      // Template exists but has no phases — fall back to narrative defaults
      phases = buildNarrativePhases();
      initialPhase = WorkflowPhase.PLOT;
    }
  } else {
    phases = buildNarrativePhases();
    initialPhase = WorkflowPhase.PLOT;
  }

  // Detect input type from content — full stories skip plot/story generation
  let detectedInputType: string = 'idea';
  try {
    const effTemplateId = templateId || 'narrative';
    const template = TemplateRegistry.getInstance().get(effTemplateId);
    if (template) {
      detectedInputType = TemplateRegistry.getInstance().detectInputType(template, cleanInput) || 'idea';
    }
  } catch { /* detection failed — default to idea */ }

  const project: ProjectFile = {
    version: PROJECT_VERSION,
    id: projectId,
    title: generateProjectTitle(cleanInput),
    originalInputFile: inputFilePath,
    style,
    inputType: detectedInputType as any,
    ...(targetDuration != null ? { targetDuration } : {}),
    ...(templateId ? { templateId } : {}),
    // Image-anchored shot chain default: v2v_extend is off so each shot's
    // generated first/last frames actually appear in the final video. Users
    // can opt in by setting useV2V: true in project.json.
    useV2V: false,
    createdAt: now,
    updatedAt: now,
    productionStartedAt: now,
    currentPhase: initialPhase as import('./types.js').WorkflowPhase,
    phases,
    // Empty content registry - entries added when content is created
    content: createDefaultContentRegistry(),
    // Empty arrays - populated as items are created
    characters: [],
    settings: [],
    scenes: [],
    assets: [],
    // Track only files that actually exist
    files: [{ type: 'original_input', path: inputFilePath }],
  };

  // Save project file
  saveProject(project, basePath);

  return project;
}

/**
 * Set the input type for a project and handle phase skipping.
 * Called by the agent after analyzing the user's input.
 * @param inputType - The detected input type (idea or story)
 * @param basePath - Base path for the project
 */
export function setProjectInputType(
  inputType: InputType,
  basePath: string = defaultBasePath()
): ProjectFile | null {
  const project = loadProject(basePath);
  if (!project) return null;

  const now = Date.now();
  const inputTypeConfig = INPUT_TYPE_CONFIGS[inputType];

  // Update the input type
  project.inputType = inputType;

  // If it's a full story, skip plot and story phases
  if (inputType === 'story') {
    // Mark skipped phases. `project.phases` and `project.content` are
    // legacy v2.0 parallel-state structures; loadProject strips them on
    // migration to v3.0, so guard each access. Without these guards the
    // function crashes ("Cannot read properties of undefined (reading
    // 'plot')") for any project that's been through the migration.
    if (project.phases) {
      for (const skipPhase of inputTypeConfig.skipPhases) {
        const phaseInfo = project.phases[skipPhase];
        if (phaseInfo) {
          phaseInfo.status = 'skipped';
          phaseInfo.completedAt = now;
          phaseInfo.plannerStage = PlannerStage.COMPLETE;
        }
      }
    }

    // Update current phase to the start phase for this input type
    project.currentPhase = inputTypeConfig.startPhase;

    // Clear todos when skipping phases - new phase will create its own
    project.todos = [];

    // Read the original input and save it as the story
    const originalInput = getOriginalInput(project, basePath);
    if (originalInput) {
      writeProjectText('plans/story.md', `# Story\n\n${originalInput}`, basePath);

      // Update content registry (also stripped on v3.0 migration).
      if (project.content?.story) {
        project.content.story.status = 'available';
      }
    }
  }

  saveProject(project, basePath);
  return project;
}

function extractSummary(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const summary = trimmed
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .find(line => !line.startsWith('#') && !line.startsWith('```'));

  return summary?.slice(0, 200);
}

function setContentEntryFile(
  project: ProjectFile,
  contentType: 'story' | 'plot',
  filePath: string
): boolean {
  const entry = project.content[contentType];
  if (entry.file !== filePath) {
    entry.file = filePath;
    return true;
  }
  return false;
}

function migrateContentItemName(
  entry: ContentEntry,
  fromName: string,
  toName: string
): boolean {
  let changed = false;

  if (entry.items) {
    const index = entry.items.indexOf(fromName);
    if (index >= 0) {
      entry.items[index] = toName;
      changed = true;
    }
  }

  if (entry.itemFiles?.[fromName]) {
    const existingFile = entry.itemFiles[fromName];
    delete entry.itemFiles[fromName];
    entry.itemFiles[toName] = existingFile;
    changed = true;
  }

  return changed;
}

function discoverProfileFiles(
  directoryName: 'characters' | 'settings',
  basePath: string = defaultBasePath(),
): Map<string, string> {
  const discovered = new Map<string, string>();
  const files = listProjectEntries(directoryName, basePath)
    .filter(entry => entry.type === 'file')
    .map(entry => entry.path)
    .filter(file =>
      file.endsWith('.profile.md') || (file.endsWith('.md') && !file.endsWith('.prompt.md'))
    )
    .sort();

  for (const relativePath of files) {
    const file = relativePath.replace(`${directoryName}/`, '');
    let discoveredName: string | undefined;
    try {
      const content = readProjectText(relativePath, basePath);
      if (content) {
        discoveredName = extractHeadingName(content);
      }
    } catch {
      // Ignore read errors and fall back to the filename.
    }

    const fallbackName = normalizeProfileName(
      file
        .replace(/\.profile\.md$/, '')
        .replace(/\.md$/, '')
        .replace(/[-_]/g, ' ')
    );
    discovered.set((discoveredName || fallbackName).toLowerCase(), relativePath);
  }

  return discovered;
}

function discoverSceneFiles(
  basePath: string = defaultBasePath()
): Map<number, { path: string; title?: string; description?: string; valid: boolean }> {
  const discovered = new Map<number, { path: string; title?: string; description?: string; valid: boolean }>();
  const sceneDirectories = [
    {
      relativePrefix: 'plans/scenes',
      filePattern: /^scene-(\d+)\.md$/i,
    },
    {
      relativePrefix: 'scenes',
      filePattern: /^scene_(\d+)\.md$/i,
    },
  ];

  for (const directory of sceneDirectories) {
    const sceneFiles = listProjectEntries(directory.relativePrefix, basePath)
      .filter(entry => entry.type === 'file')
      .map(entry => entry.path.replace(`${directory.relativePrefix}/`, ''))
      .filter(f => directory.filePattern.test(f))
      .sort();

    for (const sceneFile of sceneFiles) {
      const match = sceneFile.match(directory.filePattern);
      const sceneNumber = match?.[1] ? parseInt(match[1], 10) : NaN;
      if (!Number.isFinite(sceneNumber)) {
        continue;
      }

      const relativePath = `${directory.relativePrefix}/${sceneFile}`;
      try {
        const content = readProjectText(relativePath, basePath);
        if (content == null) {
          discovered.set(sceneNumber, { path: relativePath, valid: false });
          continue;
        }
        const valid = isValidSceneContent(content, sceneNumber);
        const title = valid ? extractSceneTitleFromContent(content, sceneNumber) : undefined;
        const description = valid ? extractSummary(content) : undefined;
        discovered.set(sceneNumber, { path: relativePath, title, description, valid });
      } catch {
        discovered.set(sceneNumber, { path: relativePath, valid: false });
      }
    }
  }

  return discovered;
}

function syncGoalPreferencesIntoProject(project: ProjectFile): boolean {
  let changed = false;
  const goalPreferences = project.goal?.preferences;

  if (
    project.goal?.status === 'active' &&
    goalPreferences?.duration != null &&
    project.targetDuration !== goalPreferences.duration
  ) {
    project.targetDuration = goalPreferences.duration;
    changed = true;
  }

  if (
    project.goal?.status === 'active' &&
    typeof goalPreferences?.style === 'string' &&
    goalPreferences.style &&
    project.style !== goalPreferences.style
  ) {
    project.style = goalPreferences.style as ProjectStyle;
    changed = true;
  }

  return changed;
}


/**
 * Load an existing project file.
 * Returns null if project doesn't exist or is incompatible (old version).
 */
export function loadProject(basePath: string = defaultBasePath()): ProjectFile | null {
  if (!projectFileExists(PROJECT_FILE, basePath)) {
    return null;
  }

  try {
    const content = readProjectText(PROJECT_FILE, basePath);
    if (!content) {
      return null;
    }
    const project = JSON.parse(content);

    // Version handling. v3.0 dropped the legacy parallel state layers
    // (project.characters[], settings[], scenes[], content{}, files[],
    // artifacts{}, phases{}) — see todos/unify-project-state.md. v2.0
    // projects load fine since all those fields are now optional, but
    // we strip the legacy fields silently so the project file isn't
    // confusingly bloated on the next save.
    if (project.version === '2.0') {
      delete project.characters;
      delete project.settings;
      delete project.scenes;
      delete project.content;
      delete project.files;
      delete project.artifacts;
      delete project.phases;
      delete project.currentPhase;
      project.version = PROJECT_VERSION;
    } else if (project.version !== PROJECT_VERSION) {
      console.warn(
        `[ProjectManager] Unknown project version: ${project.version ?? 'unknown'}. Expected: ${PROJECT_VERSION}. Loading anyway.`,
      );
    }

    // Legacy `syncContentRegistry` + `recomputeNarrativePhaseState` +
    // `initializeArtifactsFromFiles` calls removed — all three
    // rebuilt parallel state (project.content / project.phases /
    // project.characters / project.artifacts) from disk on every
    // load. The dependency graph (project.executorState) is the
    // source of truth now and doesn't need this rehydration step.
    return project as ProjectFile;
  } catch {
    return null;
  }
}

/**
 * Check if an existing project is compatible with the current workflow.
 */
export function isProjectCompatible(basePath: string = defaultBasePath()): {
  compatible: boolean;
  version?: string;
  reason?: string;
} {
  if (!projectFileExists(PROJECT_FILE, basePath)) {
    return { compatible: true, reason: 'No existing project' };
  }

  try {
    const content = readProjectText(PROJECT_FILE, basePath);
    if (!content) {
      return { compatible: false, reason: 'Failed to read project file' };
    }
    const project = JSON.parse(content);

    if (!project.version) {
      return {
        compatible: false,
        version: 'unknown',
        reason: `Old project without version metadata (before ${PROJECT_VERSION}). Delete .dhee directory to start fresh.`,
      };
    }

    if (project.version !== PROJECT_VERSION) {
      return {
        compatible: false,
        version: project.version,
        reason: `Incompatible version ${project.version}. Expected ${PROJECT_VERSION}. Delete .dhee directory to start fresh.`,
      };
    }

    return { compatible: true, version: project.version };
  } catch {
    return { compatible: false, reason: 'Failed to parse project file' };
  }
}

/**
 * Save the project file.
 */
export function saveProject(project: ProjectFile, basePath: string = defaultBasePath()): void {
  project.updatedAt = Date.now();
  const orderedProject = {
    version: project.version,
    id: project.id,
    title: project.title,
    originalInputFile: project.originalInputFile,
    style: project.style,
    inputType: project.inputType,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    currentPhase: project.currentPhase,
    ...(project.templateId ? { templateId: project.templateId } : {}),
    ...(typeof project.targetDuration === 'number'
      ? { targetDuration: project.targetDuration }
      : {}),
    ...(typeof project.duration === 'number' ? { duration: project.duration } : {}),
    ...(typeof project.autonomousMode === 'boolean'
      ? { autonomousMode: project.autonomousMode }
      : {}),
    phases: project.phases,
    content: project.content,
    characters: project.characters,
    settings: project.settings,
    scenes: project.scenes,
    assets: project.assets,
    ...(project.finalVideo ? { finalVideo: project.finalVideo } : {}),
    ...(typeof project.productionStartedAt === 'number'
      ? { productionStartedAt: project.productionStartedAt }
      : {}),
    ...(typeof project.productionCompletedAt === 'number'
      ? { productionCompletedAt: project.productionCompletedAt }
      : {}),
    ...(typeof project.lastCheckpointAt === 'number'
      ? { lastCheckpointAt: project.lastCheckpointAt }
      : {}),
    ...('elapsedMs' in project ? { elapsedMs: project.elapsedMs } : {}),
    ...('timerLastStartedAt' in project
      ? { timerLastStartedAt: project.timerLastStartedAt }
      : {}),
    ...('files' in project ? { files: project.files } : {}),
    ...('artifacts' in project ? { artifacts: project.artifacts } : {}),
    ...('goal' in project ? { goal: project.goal } : {}),
    ...('todos' in project ? { todos: project.todos } : {}),
    ...('inputs' in project ? { inputs: project.inputs } : {}),
    ...('primaryNarration' in project
      ? { primaryNarration: project.primaryNarration }
      : {}),
    // CRITICAL: executorState is the dependency-graph snapshot — every
    // completed node's status, outputs, and topology mutations live
    // here. Omitting it from the on-disk write silently wipes the
    // executor's memory of all prior progress, so the next run
    // restarts from "Expand Characters" even if the user already
    // generated 27 nodes worth of work. Regression-pinned in
    // tests/workflow/ProjectManager.test.ts → "preserves executor state".
    ...('executorState' in project
      ? { executorState: project.executorState }
      : {}),
  };
  writeProjectText(PROJECT_FILE, JSON.stringify(orderedProject, null, 2), basePath);
}

export function updateProjectConfiguration(
  config: {
    templateId: string;
    style: ProjectStyle;
    duration: number;
    autonomousMode?: boolean;
  },
  basePath: string = defaultBasePath(),
): boolean {
  const project = loadProject(basePath);
  if (!project) {
    return false;
  }

  project.templateId = config.templateId;
  project.style = config.style;
  project.targetDuration = config.duration;
  project.duration = config.duration;
  if (typeof config.autonomousMode === 'boolean') {
    project.autonomousMode = config.autonomousMode;
  }
  project.goal = {
    targetArtifacts: project.goal?.targetArtifacts ?? ['final_short'],
    description: project.goal?.description ?? '',
    preferences: {
      ...project.goal?.preferences,
      style: config.style,
      duration: config.duration,
    },
    setAt: project.goal?.setAt ?? Date.now(),
    status: project.goal?.status ?? 'active',
    ...(project.goal?.achievedAt ? { achievedAt: project.goal.achievedAt } : {}),
  };

  saveProject(project, basePath);
  return true;
}

export function updateProjectAutonomousMode(
  autonomousMode: boolean,
  basePath: string = defaultBasePath(),
): boolean {
  const project = loadProject(basePath);
  if (!project) {
    return false;
  }

  project.autonomousMode = autonomousMode;
  saveProject(project, basePath);
  return true;
}

// ============================================================================
// ACTIVE TIMER TRACKING
// ============================================================================

/**
 * Start the active timer. Called when agent begins running.
 * Sets timerLastStartedAt so elapsed time can be computed on stop.
 */
export function startTimer(basePath: string = defaultBasePath()): void {
  const project = loadProject(basePath);
  if (!project) return;
  project.timerLastStartedAt = Date.now();
  saveProject(project, basePath);
}

/**
 * Stop the active timer. Called when agent finishes running.
 * Adds the delta since timerLastStartedAt to elapsedMs and clears timerLastStartedAt.
 * Returns the total elapsedMs.
 */
export function stopTimer(basePath: string = defaultBasePath()): number {
  const project = loadProject(basePath);
  if (!project) return 0;
  const lastStart = project.timerLastStartedAt;
  if (lastStart) {
    project.elapsedMs = (project.elapsedMs || 0) + (Date.now() - lastStart);
    delete project.timerLastStartedAt;
    saveProject(project, basePath);
  }
  return project.elapsedMs || 0;
}

/**
 * Recover the timer on project load. If timerLastStartedAt is set,
 * the server crashed mid-run — add the delta and clear the marker.
 * Returns the total elapsedMs.
 */
export function recoverTimer(basePath: string = defaultBasePath()): number {
  const project = loadProject(basePath);
  if (!project) return 0;

  // Migration: if elapsedMs is missing but productionCompletedAt exists, compute a rough estimate
  if (project.elapsedMs == null && project.productionCompletedAt && project.productionStartedAt) {
    project.elapsedMs = project.productionCompletedAt - project.productionStartedAt;
  }

  const lastStart = project.timerLastStartedAt;
  if (lastStart) {
    project.elapsedMs = (project.elapsedMs || 0) + (Date.now() - lastStart);
    delete project.timerLastStartedAt;
    saveProject(project, basePath);
  }
  return project.elapsedMs || 0;
}

/**
 * Checkpoint the active timer. Flushes the current delta to elapsedMs
 * and resets timerLastStartedAt to now. Called periodically (~60s) to
 * limit data loss if the server crashes mid-run.
 */
export function checkpointTimer(basePath: string = defaultBasePath()): void {
  const project = loadProject(basePath);
  if (!project) return;
  const lastStart = project.timerLastStartedAt;
  if (lastStart) {
    project.elapsedMs = (project.elapsedMs || 0) + (Date.now() - lastStart);
    project.timerLastStartedAt = Date.now();
    saveProject(project, basePath);
  }
}

/**
 * Get the current accumulated elapsed time without modifying state.
 */
export function getElapsedMs(basePath: string = defaultBasePath()): number {
  const project = loadProject(basePath);
  if (!project) return 0;
  return project.elapsedMs || 0;
}

/**
 * Generate a brief summary of file content (first 1-2 sentences or key info).
 */
export function generateFileSummary(content: string, fileType: string): string {
  const trimmed = content.trim();

  // For markdown files, try to extract the first meaningful paragraph
  if (fileType === 'plot' || fileType === 'story') {
    // Skip title lines (starting with #)
    const lines = trimmed.split('\n').filter(l => !l.startsWith('#') && l.trim());
    const firstParagraph = lines.slice(0, 3).join(' ').trim();
    if (firstParagraph.length > 150) {
      return firstParagraph.slice(0, 147) + '...';
    }
    return firstParagraph || `${fileType} content`;
  }

  // For character/setting files, extract name and brief description
  if (fileType === 'character' || fileType === 'setting') {
    const nameMatch = trimmed.match(/^#\s*(.+)/m);
    const name = nameMatch ? nameMatch[1] : 'Unknown';
    const descLines = trimmed
      .split('\n')
      .filter(l => !l.startsWith('#') && l.trim())
      .slice(0, 2);
    const desc = descLines.join(' ').trim();
    if (desc.length > 100) {
      return `${name}: ${desc.slice(0, 97)}...`;
    }
    return `${name}: ${desc || 'No description'}`;
  }

  // For scene files
  if (fileType === 'scene') {
    const titleMatch = trimmed.match(/^#\s*(.+)/m);
    const title = titleMatch?.[1] ?? 'Untitled scene';
    return title;
  }

  // Default: first 100 chars
  if (trimmed.length > 100) {
    return trimmed.slice(0, 97) + '...';
  }
  return trimmed || `${fileType} content`;
}

/**
 * Read the original user input from its file.
 */
export function getOriginalInput(project: ProjectFile, basePath: string = defaultBasePath()): string {
  return readProjectText(project.originalInputFile, basePath) ?? '';
}

/**
 * Get or create a project.
 */
export function getOrCreateProject(
  originalInput: string,
  style: ProjectStyle = 'cinematic_realism',
  basePath: string = defaultBasePath()
): ProjectFile {
  const existing = loadProject(basePath);
  if (existing) {
    return existing;
  }
  return createProject(originalInput, style, basePath);
}

/**
 * Get the current workflow phase from the project.
 */
export function getCurrentPhase(project: ProjectFile): WorkflowPhase | string {
  return project.currentPhase;
}

/**
 * Get the project style.
 */
export function getProjectStyle(basePath: string = defaultBasePath()): ProjectStyle {
  const project = loadProject(basePath);
  return project?.style ?? 'cinematic_realism';
}

/**
 * Get the style configuration for the current project.
 */
export function getProjectStyleConfig(basePath: string = defaultBasePath()): StyleConfig {
  const style = getProjectStyle(basePath);
  return STYLE_CONFIGS[style] ?? STYLE_CONFIGS['cinematic_realism'];
}

/**
 * Update a phase's planner stage.
 */

/**
 * Check if a plan file has content.
 */
export function planFileHasContent(planFile: string, basePath: string = defaultBasePath()): boolean {
  const content = readProjectText(planFile, basePath);
  if (content === null) {
    return false;
  }
  return content.trim().length > 0;
}

/**
 * Read a file from the project directory.
 */
export function readProjectFile(
  relativePath: string,
  basePath: string = defaultBasePath()
): string | null {
  return readProjectText(relativePath, basePath);
}

/**
 * Write a file to the project directory.
 */
export function writeProjectFile(
  relativePath: string,
  content: string,
  basePath: string = defaultBasePath()
): void {
  writeProjectText(relativePath, content, basePath);
}

/**
 * Load character markdown from characters/[name].md.
 * Returns the raw markdown content (parsing not needed for index-only approach).
 */
export function loadCharacterMarkdown(
  name: string,
  basePath: string = defaultBasePath()
): string | null {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return readProjectFile(`characters/${safeName}.md`, basePath);
}

/**
 * Load setting markdown from settings/[name].md.
 * Returns the raw markdown content.
 */
export function loadSettingMarkdown(name: string, basePath: string = defaultBasePath()): string | null {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return readProjectFile(`settings/${safeName}.md`, basePath);
}

/**
 * Maximum number of scenes allowed per project.
 * Hard limit to prevent runaway scene creation in older code paths
 * that haven't migrated to the executor's collection-expansion logic.
 */
export const MAX_SCENES = 12;

/**
 * Update a scene's approval status for a specific phase.
 */
/**
 * Add an asset to the manifest AND mirror it into project.json's
 * scenes/shots/frames tree (the new single-source-of-truth surface
 * defined in src/core/project/projectSchema.ts).
 *
 * The manifest stays as the append-only ledger; project.json is the
 * shape the Storyboard / dhee_show_* / reset paths read from.
 */
export function addAsset(asset: AssetInfo, basePath: string = defaultBasePath()): void {
  let manifest: { assets: AssetInfo[] } = { assets: [] };
  const manifestContent = readProjectText('assets/manifest.json', basePath);
  if (manifestContent) {
    try {
      manifest = JSON.parse(manifestContent);
    } catch {
      // Use empty manifest on parse error
    }
  }

  // Check if asset already exists
  const existingIndex = manifest.assets.findIndex(a => a.id === asset.id);
  if (existingIndex >= 0) {
    manifest.assets[existingIndex] = asset;
  } else {
    manifest.assets.push(asset);
  }

  writeProjectText('assets/manifest.json', JSON.stringify(manifest, null, 2), basePath);

  // Update project file's asset list and scenes/shots tree.
  const project = loadProject(basePath);
  if (project) {
    let dirty = false;
    if (!project.assets.includes(asset.id)) {
      project.assets.push(asset.id);
      dirty = true;
    }
    dirty = applyAssetToProjectSchema(project as unknown as Record<string, unknown>, asset) || dirty;
    if (dirty) saveProject(project, basePath);
  }
}

/**
 * Mirror an asset entry into project.scenes[].shots[].* using the
 * helpers in src/core/project/projectSchema.ts. Returns true if anything
 * changed so the caller can decide whether to flush project.json.
 */
function applyAssetToProjectSchema(
  project: Record<string, unknown>,
  asset: AssetInfo,
): boolean {
  const baseRef = {
    path: asset.path,
    createdAt: asset.createdAt,
    ...(asset.metadata ? { metadata: asset.metadata } : {}),
  };

  switch (asset.type) {
    case 'scene_image': {
      const m = asset.nodeId?.match(/^shot_image:scene_(\d+)_shot_(\d+)$/);
      if (!m) return false;
      const sceneNum = parseInt(m[1]!, 10);
      const shotNum = parseInt(m[2]!, 10);
      const frame = asset.frame;
      if (!frame) return false;
      const frameKey = (
        { first_frame: 'firstFrame', last_frame: 'lastFrame', mid_frame: 'midFrame' } as const
      )[frame];
      setShotFrame(project, sceneNum, shotNum, frameKey, baseRef);
      return true;
    }
    case 'scene_video': {
      const m = asset.nodeId?.match(/^shot_video:scene_(\d+)_shot_(\d+)$/);
      if (!m) return false;
      const sceneNum = parseInt(m[1]!, 10);
      const shotNum = parseInt(m[2]!, 10);
      setShotVideo(project, sceneNum, shotNum, baseRef);
      return true;
    }
    case 'final_video': {
      setFinalVideo(project, baseRef);
      return true;
    }
    case 'character_ref': {
      // character_image:<id> → upsert project.characters[].referenceImage
      const m = asset.nodeId?.match(/^character_image:(.+)$/);
      if (!m) return false;
      const characterId = m[1]!;
      const characters = (project['characters'] ??= []) as Array<{
        id: string;
        name?: string;
        referenceImage?: typeof baseRef;
      }>;
      let entry = characters.find((c) => c.id === characterId);
      if (!entry) {
        entry = { id: characterId, name: characterId };
        characters.push(entry);
      }
      entry.referenceImage = baseRef;
      return true;
    }
    case 'setting_ref': {
      const m = asset.nodeId?.match(/^setting_image:(.+)$/);
      if (!m) return false;
      const settingId = m[1]!;
      const settings = (project['settings'] ??= []) as Array<{
        id: string;
        name?: string;
        referenceImage?: typeof baseRef;
      }>;
      let entry = settings.find((s) => s.id === settingId);
      if (!entry) {
        entry = { id: settingId, name: settingId };
        settings.push(entry);
      }
      entry.referenceImage = baseRef;
      return true;
    }
    default:
      return false;
  }
}

/**
 * Get all assets from the manifest.
 */
export function getAssets(basePath: string = defaultBasePath()): AssetInfo[] {
  const manifestContent = readProjectText('assets/manifest.json', basePath);
  if (!manifestContent) {
    return [];
  }

  try {
    const manifest = JSON.parse(manifestContent);
    return manifest.assets || [];
  } catch {
    return [];
  }
}

/**
 * Get the project summary for the main agent.
 */
export function getProjectSummary(basePath: string = defaultBasePath()): string {
  const project = loadProject(basePath);

  if (!project) {
    return 'No project found. A new project will be created.';
  }

  const currentPhase = project.currentPhase;
  const phaseConfig = PHASE_CONFIGS[currentPhase as WorkflowPhase];
  const phaseInfo = project.phases[currentPhase];

  const completedPhases = Object.entries(project.phases)
    .filter(([, info]) => info.status === 'completed')
    .map(([key]) => key);

  // Get character and setting names from the data arrays
  const characterNames = project.characters.map(c => c.name);
  const settingNames = project.settings.map(s => s.name);

  // Per-item approval progress display removed in PR8 — approvals
  // live in pi-agent now, not in core. The dependency-graph executor
  // tracks per-item state via `executor.getProgress()` instead.
  const itemProgress = '';

  // Get style display name
  const styleConfig = STYLE_CONFIGS[project.style];
  const styleDisplay = styleConfig ? styleConfig.displayName : project.style;

  // Get input type display name
  const inputTypeConfig = INPUT_TYPE_CONFIGS[project.inputType];
  const inputTypeDisplay = inputTypeConfig ? inputTypeConfig.displayName : project.inputType;

  // Get skipped phases
  const skippedPhases = Object.entries(project.phases)
    .filter(([, info]) => info.status === 'skipped')
    .map(([key]) => key);

  // Scene limit warning
  let sceneLimitWarning = '';
  if (currentPhase === 'scenes') {
    const sceneCount = project.scenes.length;
    if (sceneCount >= MAX_SCENES) {
      sceneLimitWarning = `\n⛔ SCENE LIMIT REACHED: You have ${sceneCount} scenes. Maximum is ${MAX_SCENES}. STOP creating scenes and transition to the next phase NOW.`;
    } else if (sceneCount >= MAX_SCENES - 2) {
      sceneLimitWarning = `\n⚠️ APPROACHING SCENE LIMIT: ${sceneCount}/${MAX_SCENES} scenes. Finish up soon.`;
    }
  }

  // Build files section with summaries
  let filesSection = '';
  if (project.files && project.files.length > 0) {
    const fileLines = project.files.map(f => {
      const nameStr = f.name ? ` (${f.name})` : '';
      const summaryStr = f.summary ? `: ${f.summary}` : '';
      return `  - ${f.path}${nameStr}${summaryStr}`;
    });
    filesSection = `\n\nAvailable Files:\n${fileLines.join('\n')}`;
  }

  return `
Project: ${project.title || '(untitled)'}
ID: ${project.id}
Version: ${project.version}
Style: ${styleDisplay}
Input Type: ${inputTypeDisplay}
Current Phase: ${phaseConfig?.displayName ?? currentPhase} (${currentPhase})
Planner Stage: ${phaseInfo?.plannerStage ?? 'not started'}
Completed Phases: ${completedPhases.length > 0 ? completedPhases.join(', ') : 'none'}
Skipped Phases: ${skippedPhases.length > 0 ? skippedPhases.join(', ') : 'none'}
Characters: ${characterNames.length > 0 ? characterNames.join(', ') : 'none defined'}
Settings: ${settingNames.length > 0 ? settingNames.join(', ') : 'none defined'}
Scenes: ${project.scenes.length}/${MAX_SCENES} (max)
Assets: ${project.assets.length}${itemProgress}${sceneLimitWarning}${filesSection}
`.trim();
}

/**
 * Get state transition prompt for non-narrative template projects.
 * Returns a generic prompt that points to backward planner tools.
 */

// ============================================================================
// Content Registry Functions
// ============================================================================

/**
 * Update the status of a content type in the registry.
 */
export function updateContentStatus(
  project: ProjectFile,
  contentType: ContentTypeName,
  status: ContentStatus,
  filePath?: string,
  basePath: string = defaultBasePath()
): ProjectFile {
  // Ensure content registry exists (for backwards compatibility)
  if (!project.content) {
    project.content = createDefaultContentRegistry();
  }

  project.content[contentType].status = status;
  if (
    filePath &&
    (contentType === 'plot' || contentType === 'story') &&
    setContentEntryFile(project, contentType, filePath)
  ) {
    // setContentEntryFile mutates in place; nothing else needed here.
  }
  saveProject(project, basePath);
  return project;
}


/**
 * Get the files summary string for use in prompts.
 * This provides a simple list of existing files for agents to reference.
 */
export function getFilesContext(project: ProjectFile): string {
  if (!project.files || project.files.length === 0) {
    return 'No project files created yet.';
  }

  let context = '## Existing Project Files\n\n';
  context += 'The following files exist and can be read:\n\n';

  for (const file of project.files) {
    const nameStr = file.name ? ` (${file.name})` : '';
    context += `- **${file.type}${nameStr}**: \`.dhee/${file.path}\`\n`;
  }

  return context.trim();
}

/**
 * Get the content context string for use in prompts.
 * This generates a summary of what content is available/missing.
 */
export function getContentContext(project: ProjectFile): string {
  // Ensure content registry exists
  if (!project.content) {
    return `
Content Status:
- All content types are missing (no content registry initialized)

You should start from the beginning and create all content.
`.trim();
  }

  const available: string[] = [];
  const partial: string[] = [];
  const missing: string[] = [];

  for (const [type, entry] of Object.entries(project.content)) {
    const info = entry as ContentEntry;
    if (info.status === 'available') {
      available.push(type);
    } else if (info.status === 'partial') {
      const itemCount = info.items?.length ?? 0;
      partial.push(`${type} (${itemCount} items)`);
    } else {
      missing.push(type);
    }
  }

  let context = `
## Content Registry Status

**Available**: ${available.length > 0 ? available.join(', ') : 'none'}
**Partial**: ${partial.length > 0 ? partial.join(', ') : 'none'}
**Missing**: ${missing.length > 0 ? missing.join(', ') : 'none'}

## Content Files

`;

  // Add file paths for available/partial content
  for (const [type, entry] of Object.entries(project.content)) {
    const info = entry as ContentEntry;
    if (info.status !== 'missing') {
      context += `- **${type}**: \`${info.file}\`\n`;
      if (info.items && info.items.length > 0) {
        context += `  - Items: ${info.items.join(', ')}\n`;
      }
    }
  }

  context += `
## Reading Content

You can read available content using read_file with the paths listed above.
All paths are relative to the .dhee/ directory.
`;

  return context.trim();
}

/**
 * Get the content registry JSON for embedding in prompts.
 */
export function getContentRegistryJson(project: ProjectFile): string {
  if (!project.content) {
    return JSON.stringify(createDefaultContentRegistry(), null, 2);
  }
  return JSON.stringify(project.content, null, 2);
}

/**
 * Check if all required content for a phase is available.
 */
export function hasRequiredContent(
  project: ProjectFile,
  requiredTypes: ContentTypeName[]
): { complete: boolean; missing: ContentTypeName[] } {
  const missing: ContentTypeName[] = [];

  for (const type of requiredTypes) {
    const entry = project.content?.[type];
    if (!entry || entry.status === 'missing') {
      missing.push(type);
    }
  }

  return {
    complete: missing.length === 0,
    missing,
  };
}

/**
 * Mark content as available after successful creation.
 * This also syncs item lists for itemized content types.
 */
export function markContentAvailable(
  project: ProjectFile,
  contentType: ContentTypeName,
  basePath: string = defaultBasePath()
): ProjectFile {
  // Ensure content registry exists
  if (!project.content) {
    project.content = createDefaultContentRegistry();
  }

  const entry = project.content[contentType];

  // For itemized content, check if we have items
  if (['characters', 'settings', 'scenes', 'images', 'videos'].includes(contentType)) {
    // Sync with project arrays
    if (contentType === 'characters' && project.characters.length > 0) {
      entry.items = project.characters.map(c => c.name);
      entry.status = 'available';
    } else if (contentType === 'settings' && project.settings.length > 0) {
      entry.items = project.settings.map(s => s.name);
      entry.status = 'available';
    } else if (contentType === 'scenes' && project.scenes.length > 0) {
      entry.items = project.scenes.map(s => `Scene ${s.sceneNumber}`);
      entry.status = 'available';
    } else if (entry.items && entry.items.length > 0) {
      entry.status = 'available';
    } else {
      // No items yet, mark as partial
      entry.status = 'partial';
    }
  } else {
    // Non-itemized content (plot, story)
    entry.status = 'available';
  }

  saveProject(project, basePath);
  return project;
}

// ============================================================================
// Image/Video Prompt Persistence Functions
// ============================================================================

/**
 * Prompt type for image/video prompts.
 */
export type PromptType = 'character' | 'setting' | 'scene';

/**
 * Save an image prompt to the prompts directory.
 * @param type - Type of prompt (character, setting, scene)
 * @param name - Name/identifier (character name, setting name, or scene number as string)
 * @param content - The prompt content to save
 * @param basePath - Base path for the project
 * @returns The relative path where the prompt was saved
 */
export function saveImagePrompt(
  type: PromptType,
  name: string,
  content: string,
  basePath: string = defaultBasePath()
): string {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let relativePath: string;

  switch (type) {
    case 'character':
      relativePath = `prompts/images/characters/${safeName}.prompt.md`;
      break;
    case 'setting':
      relativePath = `prompts/images/settings/${safeName}.prompt.md`;
      break;
    case 'scene':
      relativePath = `prompts/images/scenes/scene-${safeName}.prompt.md`;
      break;
  }

  writeProjectFile(relativePath, content, basePath);

  // Update the project with the prompt path
  const project = loadProject(basePath);
  if (project) {
    if (type === 'character') {
      const character = project.characters.find(
        c => c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === safeName
      );
      if (character) {
        character.imagePromptPath = relativePath;
        saveProject(project, basePath);
      }
    } else if (type === 'setting') {
      const setting = project.settings.find(
        s => s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === safeName
      );
      if (setting) {
        setting.imagePromptPath = relativePath;
        saveProject(project, basePath);
      }
    } else if (type === 'scene') {
      const sceneNumber = parseInt(name, 10);
      const scene = project.scenes.find(s => s.sceneNumber === sceneNumber);
      if (scene) {
        scene.imagePromptPath = relativePath;
        saveProject(project, basePath);
      }
    }
  }

  return relativePath;
}

/**
 * Load an image prompt from the prompts directory.
 * @param type - Type of prompt (character, setting, scene)
 * @param name - Name/identifier (character name, setting name, or scene number as string)
 * @param basePath - Base path for the project
 * @returns The prompt content or null if not found
 */
export function loadImagePrompt(
  type: PromptType,
  name: string,
  basePath: string = defaultBasePath()
): string | null {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let relativePath: string;

  switch (type) {
    case 'character':
      relativePath = `prompts/images/characters/${safeName}.prompt.md`;
      break;
    case 'setting':
      relativePath = `prompts/images/settings/${safeName}.prompt.md`;
      break;
    case 'scene':
      relativePath = `prompts/images/scenes/scene-${safeName}.prompt.md`;
      break;
  }

  return readProjectFile(relativePath, basePath);
}

/**
 * Save a video/motion prompt to the prompts directory.
 * @param sceneNumber - The scene number
 * @param content - The prompt content to save
 * @param basePath - Base path for the project
 * @returns The relative path where the prompt was saved
 */
export function saveVideoPrompt(
  sceneNumber: number,
  content: string,
  basePath: string = defaultBasePath()
): string {
  const relativePath = `prompts/videos/scenes/scene-${sceneNumber}.motion.json`;
  writeProjectFile(relativePath, content, basePath);

  // Update the project with the prompt path
  const project = loadProject(basePath);
  if (project) {
    const scene = project.scenes.find(s => s.sceneNumber === sceneNumber);
    if (scene) {
      scene.videoPromptPath = relativePath;
      saveProject(project, basePath);
    }
  }

  return relativePath;
}

/**
 * Load a video/motion prompt from the prompts directory.
 * @param sceneNumber - The scene number
 * @param basePath - Base path for the project
 * @returns The prompt content or null if not found
 */
export function loadVideoPrompt(
  sceneNumber: number,
  basePath: string = defaultBasePath()
): string | null {
  const canonicalPath = `prompts/videos/scenes/scene-${sceneNumber}.motion.json`;
  const canonical = readProjectFile(canonicalPath, basePath);
  if (canonical !== null) {
    return canonical;
  }

  const legacyPath = `prompts/videos/scenes/scene-${sceneNumber}.motion.md`;
  return readProjectFile(legacyPath, basePath);
}

/**
 * Update the image prompt approval status for a character, setting, or scene.
 */
// ============================================================================
// Todo Persistence Functions
// ============================================================================

import type { PersistedTodo } from './types.js';

/**
 * Save todos to the project file for resumption.
 * Called after TodoWrite operations to persist the current state.
 */
export function saveTodos(todos: PersistedTodo[], basePath: string = defaultBasePath()): boolean {
  const project = loadProject(basePath);
  if (!project) {
    return false;
  }

  project.todos = todos;
  saveProject(project, basePath);
  return true;
}

/**
 * Load persisted todos from the project file.
 * Returns empty array if no todos are stored.
 */
export function loadTodos(basePath: string = defaultBasePath()): PersistedTodo[] {
  const project = loadProject(basePath);
  if (!project || !project.todos) {
    return [];
  }
  return project.todos;
}

/**
 * Clear persisted todos from the project file.
 * Useful when starting a new phase or resetting.
 */
export function clearPersistedTodos(basePath: string = defaultBasePath()): boolean {
  const project = loadProject(basePath);
  if (!project) {
    return false;
  }

  project.todos = [];
  saveProject(project, basePath);
  return true;
}

// ============================================================================
// Multi-Input Management Functions
// ============================================================================

import type { ProjectInput, InputPurpose, PrimaryNarrationConfig } from './types.js';

/**
 * Add a new input to the project.
 * @param input - The input to add (without ID)
 * @param basePath - Base path for the project
 * @returns The added input with its generated ID
 */
export function addProjectInput(
  input: Omit<ProjectInput, 'id'>,
  basePath: string = defaultBasePath()
): ProjectInput {
  const project = loadProject(basePath);
  if (!project) {
    throw new Error('No project found');
  }

  // Initialize inputs array if needed
  if (!project.inputs) {
    project.inputs = [];
  }

  // Generate ID
  const inputId = `input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const newInput: ProjectInput = {
    ...input,
    id: inputId,
  };

  project.inputs.push(newInput);
  saveProject(project, basePath);

  // Create inputs directory structure
  const inputsDir = join(getProjectDir(basePath), 'inputs');
  const subdirs = ['local', 'remote', 'youtube', 'transcriptions', 'keyframes', 'extracted_audio'];
  for (const subdir of subdirs) {
    const dir = join(inputsDir, subdir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  return newInput;
}

/**
 * Update an existing input in the project.
 * @param inputId - ID of the input to update
 * @param updates - Partial input data to merge
 * @param basePath - Base path for the project
 * @returns The updated input or null if not found
 */
export function updateProjectInput(
  inputId: string,
  updates: Partial<ProjectInput>,
  basePath: string = defaultBasePath()
): ProjectInput | null {
  const project = loadProject(basePath);
  if (!project || !project.inputs) {
    return null;
  }

  const index = project.inputs.findIndex(i => i.id === inputId);
  if (index === -1) {
    return null;
  }

  // Deep merge for nested objects
  const existing = project.inputs[index];
  if (!existing) {
    return null;
  }

  const updated: ProjectInput = {
    ...existing,
    ...updates,
    source: { ...existing.source, ...updates.source },
    metadata: { ...existing.metadata, ...updates.metadata },
    processing: { ...existing.processing, ...updates.processing },
  };

  project.inputs[index] = updated;
  saveProject(project, basePath);

  return updated;
}

/**
 * Delete an input from the project.
 * @param inputId - ID of the input to delete
 * @param basePath - Base path for the project
 * @returns Whether the deletion was successful
 */
export function deleteProjectInput(inputId: string, basePath: string = defaultBasePath()): boolean {
  const project = loadProject(basePath);
  if (!project || !project.inputs) {
    return false;
  }

  const initialLength = project.inputs.length;
  project.inputs = project.inputs.filter(i => i.id !== inputId);

  if (project.inputs.length === initialLength) {
    return false;
  }

  // Clear primary narration if it was this input
  if (project.primaryNarration?.inputId === inputId) {
    project.primaryNarration = undefined;
  }

  saveProject(project, basePath);
  return true;
}

/**
 * Get an input by ID.
 * @param inputId - ID of the input to get
 * @param basePath - Base path for the project
 * @returns The input or null if not found
 */
export function getProjectInput(
  inputId: string,
  basePath: string = defaultBasePath()
): ProjectInput | null {
  const project = loadProject(basePath);
  if (!project || !project.inputs) {
    return null;
  }

  return project.inputs.find(i => i.id === inputId) || null;
}

/**
 * Set the primary narration source for the project.
 * @param inputId - ID of the input to use as narration
 * @param preserveAudio - Whether to preserve original audio in final video
 * @param basePath - Base path for the project
 */
export function setPrimaryNarration(
  inputId: string,
  preserveAudio: boolean,
  basePath: string = defaultBasePath()
): void {
  const project = loadProject(basePath);
  if (!project) {
    throw new Error('No project found');
  }

  const input = project.inputs?.find(i => i.id === inputId);
  if (!input) {
    throw new Error(`Input not found: ${inputId}`);
  }

  // Determine narration type based on media type
  let narrationType: 'text' | 'audio' | 'transcription';
  if (input.mediaType === 'text') {
    narrationType = 'text';
  } else if (input.mediaType === 'audio') {
    narrationType = 'audio';
  } else if (input.mediaType === 'video') {
    narrationType = 'transcription';
  } else {
    throw new Error(`Cannot use ${input.mediaType} as narration source`);
  }

  project.primaryNarration = {
    inputId,
    type: narrationType,
    preserveAudio: narrationType !== 'text' && preserveAudio,
  };

  saveProject(project, basePath);
}

/**
 * Get inputs filtered by purpose.
 * @param purpose - The purpose to filter by
 * @param basePath - Base path for the project
 * @returns Array of inputs with the specified purpose
 */
export function getInputsByPurpose(
  purpose: InputPurpose,
  basePath: string = defaultBasePath()
): ProjectInput[] {
  const project = loadProject(basePath);
  if (!project || !project.inputs) {
    return [];
  }

  return project.inputs.filter(i => i.purpose === purpose);
}

/**
 * Get the narration content from the primary narration source.
 * Returns the text content (from text input or audio transcription)
 * along with timing information if audio is being preserved.
 * @param basePath - Base path for the project
 * @returns Narration content or null if no primary narration set
 */
export function getNarrationContent(basePath: string = defaultBasePath()): {
  content: string;
  audioPath?: string;
  timingMarkers?: Array<{ start: number; end: number; text: string }>;
} | null {
  const project = loadProject(basePath);
  if (!project || !project.primaryNarration) {
    return null;
  }

  const input = project.inputs?.find(i => i.id === project.primaryNarration?.inputId);
  if (!input) {
    return null;
  }

  // Get content based on narration type
  let content: string;
  if (project.primaryNarration.type === 'text') {
    // Read text content from local path
    if (input.processing.localPath && existsSync(input.processing.localPath)) {
      content = readFileSync(input.processing.localPath, 'utf-8');
    } else if (input.source.type === 'inline') {
      content = input.source.value;
    } else {
      return null;
    }
  } else {
    // Use transcription for audio/video
    if (!input.processing.transcription) {
      return null;
    }
    content = input.processing.transcription;
  }

  const result: {
    content: string;
    audioPath?: string;
    timingMarkers?: Array<{ start: number; end: number; text: string }>;
  } = { content };

  // Add audio path if preserving audio
  if (project.primaryNarration.preserveAudio) {
    if (input.mediaType === 'audio') {
      result.audioPath = input.processing.localPath;
    } else if (input.mediaType === 'video') {
      result.audioPath = input.processing.extractedAudioPath || input.processing.localPath;
    }
    result.timingMarkers = input.processing.timingMarkers;
  }

  return result;
}

/**
 * Get all inputs for the project.
 * @param basePath - Base path for the project
 * @returns Array of all inputs
 */
export function getAllInputs(basePath: string = defaultBasePath()): ProjectInput[] {
  const project = loadProject(basePath);
  if (!project || !project.inputs) {
    return [];
  }
  return project.inputs;
}

/**
 * Check if any inputs exist in the project.
 * @param basePath - Base path for the project
 * @returns Whether the project has any inputs
 */
export function hasInputs(basePath: string = defaultBasePath()): boolean {
  const project = loadProject(basePath);
  return !!(project?.inputs && project.inputs.length > 0);
}

/**
 * Get inputs by processing status.
 * @param status - The processing status to filter by
 * @param basePath - Base path for the project
 * @returns Array of inputs with the specified status
 */
export function getInputsByStatus(
  status: 'pending' | 'processing' | 'completed' | 'failed',
  basePath: string = defaultBasePath()
): ProjectInput[] {
  const project = loadProject(basePath);
  if (!project || !project.inputs) {
    return [];
  }

  return project.inputs.filter(i => i.processing.status === status);
}
