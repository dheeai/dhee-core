/**
 * Video creation task module — exposes the modern executor-based
 * factory (`createExecutorAgent`), the template helpers, and a few
 * project-level utility re-exports. The legacy GenericAgent factories,
 * tool-registry builders, and `update_project` mega-tool that this
 * file used to ship were removed in PR7 + PR4 + PR6.
 */
import { LLMClient, type LLMClientConfig } from '../../core/llm/index.js';
import { ExecutorAgent } from '../../core/planner/index.js';
import type { UserGoal } from '../../core/planner/types.js';

// `loadProject`, `saveProject`, `getProjectDir`, `getProjectStyle`,
// `addAsset`, `GenericProjectManager`, `createProjectManager` are all
// re-exported below via `export * from './workflow/index.js'` —
// callers continue to consume them from `tasks/video/index.js`.
import { createProjectManager } from './workflow/index.js';
import { getProjectDir } from './workflow/ProjectManager.js';

// Template system imports
import {
  initializeTemplates,
  listTemplates,
  detectTemplate,
  getTemplateOrThrow,
  TEMPLATE_IDS,
} from '../../templates/index.js';
import type { VideoTemplate, GenericProjectFile } from '../../core/templates/types.js';

// Re-export prompts
export { VIDEO_CREATION_SYSTEM_PROMPT, getVideoCreationPrompt } from './prompts.js';

// Re-export tools
export {
  generateImageTool,
  generateVideoTool,
  editImageTool,
  getVideoGenerationTools,
  getGraphicNovelTools,
  VIDEO_COMPLEX_TOOLS,
} from './tools.js';

// Infographic tools removed: the Remotion render path lived inside a
// `npx remotion bundle` subprocess that doesn't ship in packaged
// builds. Infographic rendering is now handled by the host wrapper
// (kshana-desktop/src/main/remotionManager.ts) over IPC.

// Re-export state types
export { resetProjectState, setCurrentProjectId } from './state.js';
export type { Character, Setting, StoryboardScene, ProjectState } from './state.js';

// Re-export workflow module
export * from './workflow/index.js';

/**
 * Configuration options for creating a video agent.
 */
export interface VideoAgentConfig {
  llmConfig: LLMClientConfig;
  maxIterations?: number;
  includeCharacterGuidelines?: boolean;
  includeStoryboardGuidelines?: boolean;
}


// =============================================================================
// TEMPLATE-BASED WORKFLOW (v3.0)
// =============================================================================

/**
 * Configuration options for creating a template-based video agent.
 */
export interface TemplateVideoAgentConfig {
  llmConfig: LLMClientConfig;
  maxIterations?: number;
  /** Template ID to use (auto-detected if not provided) */
  templateId?: string;
  /** Original user input/content */
  originalInput?: string;
  /** Project title */
  title?: string;
  /** Visual style ID */
  style?: string;
  /** Base path for project directory (defaults to cwd) */
  basePath?: string;
}

/**
 * Result of template detection
 */
export interface TemplateDetectionResult {
  templateId: string;
  templateName: string;
  inputTypeId: string;
  confidence: number;
  alternatives: Array<{ id: string; displayName: string; description: string }>;
}

/**
 * Initialize the template system.
 * Must be called before using template-based workflow.
 */
export function initializeVideoTemplates(): void {
  initializeTemplates();
}

/**
 * Get available video templates.
 */
export function getAvailableTemplates(): Array<{
  id: string;
  displayName: string;
  description: string;
}> {
  initializeTemplates();
  return listTemplates();
}

/**
 * Detect the best template for given content.
 */
export function detectVideoTemplate(content: string): TemplateDetectionResult | null {
  initializeTemplates();
  const result = detectTemplate(content);

  if (!result) {
    return null;
  }

  const template = getTemplateOrThrow(result.templateId);
  const alternatives = listTemplates().filter(t => t.id !== result.templateId);

  return {
    templateId: result.templateId,
    templateName: template.displayName,
    inputTypeId: result.inputTypeId,
    confidence: result.confidence,
    alternatives,
  };
}

/**
 * @deprecated Removed in graph-as-source-of-truth refactor. Stub
 * kept so old callers fail loudly instead of silently building an
 * agent that no longer exists.
 */
function buildTemplateAgentPrompt(
  template: VideoTemplate,
  project: GenericProjectFile | null,
  currentPhase: { id: string; displayName: string; description: string } | undefined,
  loadedContexts: string[]
): string {
  // Build artifact types summary
  const artifactsSummary = Object.entries(template.artifactTypes)
    .map(([id, def]) => `- **${def.displayName}** (${def.category}): ${def.description}`)
    .join('\n');

  // Build phases summary if available
  let phasesSummary = 'No phases defined - artifact-driven workflow.';
  if (template.phases && template.phases.length > 0) {
    phasesSummary = template.phases
      .map((p, i) => `${i + 1}. **${p.displayName}**: ${p.description}`)
      .join('\n');
  }

  // Build loaded contexts section
  let loadedContextsSection = 'No existing project files loaded yet.';
  if (loadedContexts.length > 0) {
    loadedContextsSection = `## Available Contexts
The following project files have been loaded as contexts:
${loadedContexts.map(c => `- ${c}`).join('\n')}

Use the \`generate_content\` tool for creating content - it automatically injects the correct contexts.`;
  }

  // Current phase info
  let currentPhaseSection = '';
  if (currentPhase) {
    currentPhaseSection = `
## Current Phase: ${currentPhase.displayName}
${currentPhase.description}
`;
  }

  return `# ${template.displayName} - Video Creation Workflow

${template.description}

## Project Information
- **Project ID**: ${project?.id ?? 'new'}
- **Title**: ${project?.title || '(not set)'}
- **Template**: ${template.displayName} (v${template.version})
- **Style**: ${project?.style || template.defaultStyle}

${currentPhaseSection}

## Workflow Phases
${phasesSummary}

## Artifact Types
${artifactsSummary}

${loadedContextsSection}

## Your Role

You are an orchestrator guiding the user through the video creation process.

### Guidelines

1. **Follow the artifact dependency order** - Check dependencies before creating artifacts
2. **Get approval for expensive operations** - Image and video generation require confirmation
3. **Track progress** - Use update_project to track artifact status
4. **Offer choices** - When multiple approaches are valid, present options to the user
5. **Explain what you're doing** - Keep the user informed of progress

### Available Tools

- **read_project**: Read current project state
- **update_project**: Update project state (artifacts, phases)
- **read_file**: Read project files
- **import_file**: Import/copy external files into the project
- **generate_content**: Generate content using AI (with automatic context injection)
- **ask_user**: Ask user for input or confirmation
- **Task**: Dispatch subagents for complex tasks

### Getting Started

1. Read the current project state with read_project
2. Determine what artifact to work on next based on dependencies
3. Create or update artifacts as needed
4. Get user approval for completed artifacts
5. Proceed to the next artifact or phase
`;
}

/**

/**
 * Options for creating an ExecutorAgent (code-driven dependency graph execution).
 */
export interface CreateExecutorAgentOptions {
  templateId: string;
  style: string;
  duration: number;
  llmConfig: LLMClientConfig;
  /** Target artifacts the user wants (e.g., ['final_video'], ['story']) */
  targetArtifacts: string[];
  /** Description of the user's goal */
  goalDescription: string;
  /** Custom project description from user */
  customProjectDescription?: string;
  /**
   * Run media generation (images/videos via ComfyUI) in parallel with LLM prompt generation.
   * Enable when the image/video provider is on a separate server from the LLM.
   * Default: false (serial — suitable when LLM and ComfyUI share the same machine).
   */
  parallelMediaGeneration?: boolean;
}

/**
 * Create an ExecutorAgent that drives the workflow deterministically.
 *
 * Unlike createAgentForProject (which returns tools + prompt for a GenericAgent),
 * this creates a self-contained ExecutorAgent that owns the execution loop.
 * The LLM is called as a pure content generator — no tools, no agent decisions.
 */
export function createExecutorAgent(options: CreateExecutorAgentOptions): ExecutorAgent {
  const {
    templateId, style, duration, llmConfig,
    targetArtifacts, goalDescription,
  } = options;

  // Initialize templates and get the template
  initializeTemplates();
  const template = getTemplateOrThrow(templateId);

  // Create or load project
  const projectManager = createProjectManager();
  const project = projectManager.projectExistsSync()
    ? projectManager.loadProjectQuick()
    : projectManager.createEmptyProject(templateId);

  // Ensure project has required fields (old format projects may lack them)
  const proj = project as unknown as Record<string, unknown>;
  if (!proj['artifacts']) proj['artifacts'] = {};
  if (!proj['contextStore']) proj['contextStore'] = {};
  if (!proj['assets']) proj['assets'] = [];

  const projectDir = getProjectDir();

  // Build user goal
  const goal: UserGoal = {
    targetArtifacts,
    preferences: { style, duration },
    description: goalDescription,
  };

  // Create LLM client
  const llm = new LLMClient(llmConfig);

  return new ExecutorAgent(llm, {
    template,
    project: project as unknown as GenericProjectFile,
    projectDir,
    goal,
    name: 'dhee-executor',
    parallelMediaGeneration: options.parallelMediaGeneration,
  });
}

/**
 * Get template by ID.
 */
export function getVideoTemplate(templateId: string): VideoTemplate {
  initializeTemplates();
  return getTemplateOrThrow(templateId);
}

/**
 * Re-export template IDs for convenience.
 */
export { TEMPLATE_IDS } from '../../templates/index.js';

