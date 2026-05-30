/**
 * dhee pi-agent custom tools — registry surface.
 *
 * The buildSession factory passes:
 *   - `customToolNames: DHEE_TOOL_NAMES` to the allowlist (otherwise
 *     pi silently blocks custom tools — see Landmine 1 in
 *     DRIVING_PI_FROM_CLAUDE_CODE.md), AND
 *   - `extensionFactories: [registerDheeTools]` so the extension
 *     runtime calls `pi.registerTool(...)` for each at startup.
 *
 * Each tool has a `make<X>Tool(deps)` factory for testability + a
 * frozen default instance for production.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { dheeApplyWorkflowAliasesTool, makeApplyWorkflowAliasesTool } from './dheeApplyWorkflowAliases.js';
import { dheeCheckWorkflowTool, makeCheckWorkflowTool } from './dheeCheckWorkflow.js';
import { dheeCreateProjectTool, makeCreateProjectTool } from './dheeCreateProject.js';
import { dheeCritiqueNodeTool, makeCritiqueNodeTool } from './dheeCritiqueNode.js';
import { dheeForkTool, makeForkTool } from './dheeFork.js';
import { dheeGetStatusTool, makeGetStatusTool } from './dheeGetStatus.js';
import { dheeListVersionsTool, makeListVersionsTool } from './dheeListVersions.js';
import { dheeReadArtifactTool, makeReadArtifactTool } from './dheeReadArtifact.js';
import { dheeRegenerateNodeTool, makeRegenerateNodeTool } from './dheeRegenerateNode.js';
import { dheeRunBundleTool, makeRunBundleTool } from './dheeRunBundle.js';
import { dheeSelectVersionTool, makeSelectVersionTool } from './dheeSelectVersion.js';
import { dheeShowFileTool, makeShowFileTool } from './dheeShowFile.js';
import { dheeShowNodeOutputTool, makeShowNodeOutputTool } from './dheeShowNodeOutput.js';
import { dheeSwapRunnerTool, makeSwapRunnerTool } from './dheeSwapRunner.js';

export const DHEE_TOOL_NAMES = [
  'dhee_create_project',
  'dhee_run_bundle',
  'dhee_get_status',
  'dhee_regenerate_node',
  'dhee_critique_node',
  'dhee_check_workflow',
  'dhee_apply_workflow_aliases',
  'dhee_read_artifact',
  'dhee_show_node_output',
  'dhee_show_file',
  'dhee_list_versions',
  'dhee_select_version',
  'dhee_fork',
  'dhee_swap_runner',
] as const;

export {
  dheeApplyWorkflowAliasesTool,
  dheeCheckWorkflowTool,
  dheeCreateProjectTool,
  dheeCritiqueNodeTool,
  dheeForkTool,
  dheeGetStatusTool,
  dheeListVersionsTool,
  dheeReadArtifactTool,
  dheeRegenerateNodeTool,
  dheeRunBundleTool,
  dheeSelectVersionTool,
  dheeShowFileTool,
  dheeShowNodeOutputTool,
  dheeSwapRunnerTool,
  makeApplyWorkflowAliasesTool,
  makeCheckWorkflowTool,
  makeCreateProjectTool,
  makeCritiqueNodeTool,
  makeForkTool,
  makeGetStatusTool,
  makeListVersionsTool,
  makeReadArtifactTool,
  makeRegenerateNodeTool,
  makeRunBundleTool,
  makeSelectVersionTool,
  makeShowFileTool,
  makeShowNodeOutputTool,
  makeSwapRunnerTool,
};

/**
 * pi extensionFactory — registers all v1 dhee tools.
 * Pass this in `DefaultResourceLoader({extensionFactories: [registerDheeTools]})`.
 */
export function registerDheeTools(pi: ExtensionAPI): void {
  pi.registerTool(dheeCreateProjectTool);
  pi.registerTool(dheeRunBundleTool);
  pi.registerTool(dheeGetStatusTool);
  pi.registerTool(dheeRegenerateNodeTool);
  pi.registerTool(dheeCritiqueNodeTool);
  pi.registerTool(dheeCheckWorkflowTool);
  pi.registerTool(dheeApplyWorkflowAliasesTool);
  pi.registerTool(dheeReadArtifactTool);
  pi.registerTool(dheeShowNodeOutputTool);
  pi.registerTool(dheeShowFileTool);
  // Event-sourced graph tools (feat/event-sourced-graph)
  pi.registerTool(dheeListVersionsTool);
  pi.registerTool(dheeSelectVersionTool);
  pi.registerTool(dheeForkTool);
  pi.registerTool(dheeSwapRunnerTool);
}
