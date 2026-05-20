/**
 * Planner Tools
 *
 * Tools for the goal-driven orchestrator to scan assets and create backward plans.
 */

import { readFileSync } from 'fs';
import type { ToolDefinition } from '../../llm/index.js';
import { tryPathVariants } from './contentCreatorTools.js';
import { BackwardPlanner, AssetScanner } from '../../planner/index.js';
import type {
  UserGoal,
  GoalPreferences,
  AssetRegistry,
  ProvidedAsset,
  PersistedGoal,
} from '../../planner/types.js';
import type { VideoTemplate, GenericProjectFile } from '../../templates/types.js';
import { writeProjectText } from '../../../tasks/video/workflow/projectFileIO.js';

/**
 * Context required for planner tools.
 * This should be injected when creating the tool handlers.
 */
export interface PlannerToolContext {
  template: VideoTemplate;
  /** Load the latest project state at tool execution time. */
  getProject: () => GenericProjectFile;
  /** Returns the path to the active .dhee project directory (resolved at call time) */
  getProjectDir: () => string;
  /** Shared registry state across planner tool calls within a session */
  registry?: AssetRegistry;
}

/**
 * Serializable asset data for tool responses
 */
interface SerializableAsset {
  id: string;
  artifactTypeId: string;
  itemId?: string;
  path?: string;
  content?: string;
  source: string;
  registeredAt: number;
  metadata?: Record<string, unknown>;
}

/**
 * Registry data that can be passed between tool calls
 */
interface RegistryData {
  assets: SerializableAsset[];
  satisfiedArtifacts: Record<string, 'full' | 'partial'>;
  lastScanAt: number;
}

function getCurrentProject(context: PlannerToolContext): GenericProjectFile {
  return context.getProject();
}

/**
 * Create scan_assets tool
 */
export function createScanAssetsTool(context: PlannerToolContext): ToolDefinition {
  return {
    name: 'scan_assets',
    description: `Scan the project for existing and user-provided assets.

This tool examines:
1. The project state for already-approved artifacts
2. Standard artifact directories (characters/, settings/, scenes/, etc.)
3. Any additional paths you specify

Use this FIRST when starting a session to understand what already exists.
The result shows which artifact types are fully or partially satisfied.`,
    parameters: {
      type: 'object' as const,
      properties: {
        additional_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional file paths to scan for user-provided assets (images, videos, documents)',
        },
      },
    },
    handler: async (params: Record<string, unknown>) => {
      const additionalPaths = params['additional_paths'] as string[] | undefined;
      const project = getCurrentProject(context);

      const scanner = new AssetScanner(context.template);
      const result = scanner.scan(context.getProjectDir(), project);

      // Register any additional user paths
      if (additionalPaths && additionalPaths.length > 0) {
        scanner.registerUserAssets(additionalPaths, result.registry);
      }

      // Store registry in shared context for use by other planner tools
      context.registry = result.registry;

      // Build response
      const summary = scanner.getSummary(result.registry);

      // Convert registry to serializable format
      const registryData: RegistryData = {
        assets: Array.from(result.registry.assets.entries()).map(([, asset]) => ({
          id: asset.id,
          artifactTypeId: asset.artifactTypeId,
          itemId: asset.itemId,
          path: asset.path,
          content: asset.content,
          source: asset.source,
          registeredAt: asset.registeredAt,
          metadata: asset.metadata,
        })),
        satisfiedArtifacts: Object.fromEntries(result.registry.satisfiedArtifacts),
        lastScanAt: result.registry.lastScanAt,
      };

      return {
        success: true,
        summary,
        registry: registryData,
        assetCount: result.assetCount,
        issues: result.issues,
      };
    },
  };
}

/**
 * Create create_backward_plan tool
 */
export function createBackwardPlanTool(context: PlannerToolContext): ToolDefinition {
  return {
    name: 'create_backward_plan',
    description: `Create an execution plan by working backwards from target artifacts.

This tool:
1. Takes the artifact types the user wants (e.g., 'final_video', 'story', 'scene_image')
2. Traverses the dependency graph backwards to find ALL required artifacts
3. Subtracts what already exists (from a scan or provided registry)
4. Returns an ordered plan with only the steps needed

Use this AFTER understanding the user's goal to build the minimal execution path.

Available artifact types for this template:
${Object.keys(context.template.artifactTypes).join(', ')}`,
    parameters: {
      type: 'object' as const,
      properties: {
        target_artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Artifact type IDs the user wants to create (e.g., ["final_video"], ["story"], ["scene_image"])',
        },
        preferences: {
          type: 'object',
          description: 'User preferences (style, duration, format, etc.)',
          properties: {
            style: { type: 'string', description: 'Visual style preference' },
            duration: { type: 'number', description: 'Target duration in seconds' },
            format: { type: 'string', description: 'Output format preference' },
          },
        },
        goal_description: {
          type: 'string',
          description: 'Original user description of their goal',
        },
        registry_data: {
          type: 'object',
          description: 'Previously scanned registry data (from scan_assets). If not provided, a fresh scan is performed.',
        },
        include_optional: {
          type: 'boolean',
          description: 'Include optional dependencies in the plan (default: false)',
        },
      },
      required: ['target_artifacts'],
    },
    handler: async (params: Record<string, unknown>) => {
      const targetArtifacts = params['target_artifacts'] as string[];
      const preferences = params['preferences'] as GoalPreferences | undefined;
      const goalDescription = params['goal_description'] as string | undefined;
      const registryDataParam = params['registry_data'] as RegistryData | undefined;
      const includeOptional = params['include_optional'] as boolean | undefined;

      // Get or create registry
      let registry: AssetRegistry;

      if (registryDataParam) {
        // Reconstruct registry from provided data
        const assetMap = new Map<string, ProvidedAsset>();
        for (const a of registryDataParam.assets) {
          assetMap.set(a.id, {
            id: a.id,
            artifactTypeId: a.artifactTypeId,
            itemId: a.itemId,
            path: a.path,
            content: a.content,
            source: a.source as 'user_provided' | 'previously_generated' | 'imported' | 'detected',
            registeredAt: a.registeredAt,
            metadata: a.metadata,
          });
        }
        registry = {
          assets: assetMap,
          satisfiedArtifacts: new Map(Object.entries(registryDataParam.satisfiedArtifacts)),
          lastScanAt: registryDataParam.lastScanAt,
        };
      } else if (context.registry) {
        // Use shared registry from previous scan_assets call
        registry = context.registry;
      } else {
        // Perform fresh scan
        const project = getCurrentProject(context);
        const scanner = new AssetScanner(context.template);
        const scanResult = scanner.scan(context.getProjectDir(), project);
        registry = scanResult.registry;
      }

      // Build goal
      const goal: UserGoal = {
        targetArtifacts,
        preferences: preferences || {},
        description: goalDescription || `Create ${targetArtifacts.join(', ')}`,
      };

      // Create planner and build plan
      const planner = new BackwardPlanner(context.template);
      const plan = planner.buildPlan(goal, registry, {
        includeOptional,
      });

      // Compute timeline hints if duration is specified
      if (goal.preferences.duration) {
        plan.timelineHints = planner.computeTimelineHints(goal);
      }

      // Validate plan
      const validation = planner.validatePlan(plan);

      // Auto-detect goal completion
      const projectComplete = plan.steps.length === 0;
      const project = getCurrentProject(context);
      if (projectComplete && project.goal?.status === 'active') {
        project.goal.status = 'achieved';
        project.goal.achievedAt = Date.now();
        persistProject(context, project);
      }

      return {
        success: validation.valid,
        plan: {
          goal: plan.goal,
          steps: plan.steps,
          skippedArtifacts: plan.skippedArtifacts,
          summary: plan.summary,
          expensiveStepCount: plan.expensiveStepCount,
          requiresApproval: plan.requiresApproval,
          timelineHints: plan.timelineHints,
        },
        projectComplete,
        completionMessage: projectComplete
          ? 'All target artifacts are satisfied. The project goal is achieved.'
          : undefined,
        validation: {
          valid: validation.valid,
          errors: validation.errors,
          warnings: validation.warnings,
        },
      };
    },
  };
}

/**
 * Create register_user_content tool
 */
export function createRegisterContentTool(context: PlannerToolContext): ToolDefinition {
  return {
    name: 'register_user_content',
    description: `Register user-provided content as an existing asset.

Use this when the user provides content directly (e.g., pastes a story, describes characters)
or provides a file path to content. This marks the corresponding artifact type as satisfied
so the planner can skip generation.

You can provide content inline via 'content' or point to a file via 'file_path'.
At least one of 'content' or 'file_path' must be provided.

Available artifact types:
${Object.keys(context.template.artifactTypes).join(', ')}`,
    parameters: {
      type: 'object' as const,
      properties: {
        artifact_type: {
          type: 'string',
          description: 'The artifact type this content satisfies (e.g., "story", "plot")',
        },
        content: {
          type: 'string',
          description: 'The content provided by the user (inline text)',
        },
        file_path: {
          type: 'string',
          description: 'Path to a file containing the content. Can be absolute or relative to the project directory.',
        },
        item_id: {
          type: 'string',
          description: 'For collections: the specific item ID (e.g., character name)',
        },
        mark_fully_satisfied: {
          type: 'boolean',
          description: 'Whether to mark this artifact type as fully satisfied (default: true for non-collections)',
        },
      },
      required: ['artifact_type'],
    },
    handler: async (params: Record<string, unknown>) => {
      const artifactType = params['artifact_type'] as string;
      let content = params['content'] as string | undefined;
      const filePath = params['file_path'] as string | undefined;
      const itemId = params['item_id'] as string | undefined;
      const markFullySatisfied = params['mark_fully_satisfied'] as boolean | undefined;

      // Resolve content from file_path if provided
      if (!content && filePath) {
        const resolvedPath = tryPathVariants(filePath);

        if (!resolvedPath) {
          return {
            success: false,
            error: `File not found: ${filePath}`,
          };
        }

        content = readFileSync(resolvedPath, 'utf-8');
      }

      if (!content) {
        return {
          success: false,
          error: 'Either "content" or "file_path" must be provided',
        };
      }

      const scanner = new AssetScanner(context.template);
      const asset = scanner.registerContent(content, artifactType, itemId);

      if (!asset) {
        return {
          success: false,
          error: `Unknown artifact type: ${artifactType}`,
        };
      }

      // Add asset to shared registry if it exists
      if (context.registry) {
        context.registry.assets.set(asset.id, asset);
        const typeDef = context.template.artifactTypes[artifactType];
        const shouldMarkFull = markFullySatisfied ?? (typeDef && !typeDef.isCollection);
        if (shouldMarkFull) {
          context.registry.satisfiedArtifacts.set(artifactType, 'full');
        } else if (!context.registry.satisfiedArtifacts.has(artifactType)) {
          context.registry.satisfiedArtifacts.set(artifactType, 'partial');
        }
      }

      const typeDef = context.template.artifactTypes[artifactType];
      const shouldMarkFull = markFullySatisfied ?? (typeDef && !typeDef.isCollection);

      // Persist content to disk in .dhee/plans/<artifact_type>.md
      // This ensures intermediate artifacts survive session restarts.
      let persistedPath: string | undefined;
      if (content && context.getProjectDir()) {
        try {
          const fileName = itemId
            ? `plans/${artifactType}_${itemId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.md`
            : `plans/${artifactType}.md`;
          writeProjectText(fileName, content);
          persistedPath = fileName;
          // Legacy `registerFile` write to project.files[] removed —
          // file discovery is now via the executor's outputPath on
          // each per-item node, not the flat manifest array.
        } catch {
          // Non-fatal — content is still in memory registry
        }
      }

      return {
        success: true,
        asset: {
          id: asset.id,
          artifactTypeId: asset.artifactTypeId,
          itemId: asset.itemId,
          source: asset.source,
          registeredAt: asset.registeredAt,
          contentLength: content.length,
        },
        markedFullySatisfied: shouldMarkFull,
        loadedFromFile: !!filePath,
        persistedTo: persistedPath,
        message: `Registered ${asset.artifactTypeId}${asset.itemId ? ` (${asset.itemId})` : ''} as user-provided content${filePath ? ` (from ${filePath})` : ''}${persistedPath ? ` — saved to ${persistedPath}` : ''}`,
      };
    },
  };
}

/**
 * Persist the project state to disk.
 * Works with GenericProjectFile (the planner context type).
 */
function persistProject(context: PlannerToolContext, project: GenericProjectFile): void {
  const latestProject = getCurrentProject(context);
  const latestProjectRecord = latestProject as unknown as Record<string, unknown>;
  const mergedProject = {
    ...latestProjectRecord,
    goal: project.goal ?? latestProject.goal,
    updatedAt: Date.now(),
  } as GenericProjectFile & Record<string, unknown>;

  if (!project.goal && 'goal' in mergedProject) {
    delete mergedProject['goal'];
  }

  if (project.goal?.status === 'active' && 'productionCompletedAt' in mergedProject) {
    delete mergedProject['productionCompletedAt'];
  }

  writeProjectText('project.json', JSON.stringify(mergedProject, null, 2));
}

/**
 * Create set_goal tool
 */
export function createSetGoalTool(context: PlannerToolContext): ToolDefinition {
  return {
    name: 'set_goal',
    description: `Persist the user's goal so it survives across sessions.

Call this BEFORE create_backward_plan when:
- Starting a new project (no goal exists yet)
- The user changes their intent significantly
- After goal achievement, user requests new work

The goal is stored in project.json and read on session resume.`,
    parameters: {
      type: 'object' as const,
      properties: {
        target_artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Artifact type IDs the user wants (e.g., ["final_video"], ["story"])',
        },
        description: {
          type: 'string',
          description: 'What the user wants to achieve, in natural language',
        },
        preferences: {
          type: 'object',
          description: 'User preferences (style, duration, format, etc.)',
          properties: {
            style: { type: 'string' },
            duration: { type: 'number' },
            format: { type: 'string' },
          },
        },
      },
      required: ['target_artifacts', 'description'],
    },
    handler: async (params: Record<string, unknown>) => {
      const targetArtifacts = params['target_artifacts'] as string[];
      const description = params['description'] as string;
      const preferences = (params['preferences'] as GoalPreferences) || {};
      const project = getCurrentProject(context);

      // If an active goal exists, mark it superseded
      if (project.goal && project.goal.status === 'active') {
        project.goal.status = 'superseded';
      }

      // Create new persisted goal
      const newGoal: PersistedGoal = {
        targetArtifacts,
        description,
        preferences,
        setAt: Date.now(),
        status: 'active',
      };

      project.goal = newGoal;
      const mutableProject = project as GenericProjectFile & Record<string, unknown>;

      if (typeof preferences.duration === 'number' && Number.isFinite(preferences.duration)) {
        mutableProject['targetDuration'] = preferences.duration;
      }
      if (typeof preferences.style === 'string' && preferences.style) {
        project.style = preferences.style;
      }

      // Clear completion state so the nudge loop and workflow resume
      delete (project as unknown as Record<string, unknown>)['productionCompletedAt'];

      persistProject(context, project);

      return {
        success: true,
        goal: newGoal,
        message: `Goal persisted: "${description}" → targets: [${targetArtifacts.join(', ')}]`,
      };
    },
  };
}

/**
 * Create all planner tools with the given context
 */
export function createPlannerTools(context: PlannerToolContext): ToolDefinition[] {
  return [
    createScanAssetsTool(context),
    createBackwardPlanTool(context),
    createRegisterContentTool(context),
    createSetGoalTool(context),
  ];
}
