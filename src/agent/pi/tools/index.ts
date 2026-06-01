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
import { dheeDescribeBundleTool, makeDescribeBundleTool } from './dheeDescribeBundle.js';
import { dheeForkTool, makeForkTool } from './dheeFork.js';
import { dheeFindTool, dheeGrepTool, dheeLsTool, dheeReadTool, makeFindTool, makeGrepTool, makeLsTool, makeReadTool } from './dheeFs.js';
import { dheeGetStatusTool, makeGetStatusTool } from './dheeGetStatus.js';
import { dheeListBundlesTool, makeListBundlesTool } from './dheeListBundles.js';
import { dheeListVersionsTool, makeListVersionsTool } from './dheeListVersions.js';
import { dheePresentBundleChoicesTool, makePresentBundleChoicesTool } from './dheePresentBundleChoices.js';
import { dheeReadArtifactTool, makeReadArtifactTool } from './dheeReadArtifact.js';
import { dheeRegenerateNodeTool, makeRegenerateNodeTool } from './dheeRegenerateNode.js';
import { dheeRunBundleTool, makeRunBundleTool } from './dheeRunBundle.js';
import { dheeSelectVersionTool, makeSelectVersionTool } from './dheeSelectVersion.js';
import { dheeShowFileTool, makeShowFileTool } from './dheeShowFile.js';
import { dheeShowNodeOutputTool, makeShowNodeOutputTool } from './dheeShowNodeOutput.js';
import { dheeSwapRunnerTool, makeSwapRunnerTool } from './dheeSwapRunner.js';
import { dheeWriteInputTool, makeWriteInputTool } from './dheeWriteInput.js';
import { dheeWriteNodeContentTool, makeWriteNodeContentTool } from './dheeWriteNodeContent.js';

export const DHEE_TOOL_NAMES = [
  'dhee_create_project',
  'dhee_list_bundles',
  'dhee_present_bundle_choices',
  'dhee_describe_bundle',
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
  'dhee_write_input',
  'dhee_write_node_content',
  'dhee_read',
  'dhee_ls',
  'dhee_grep',
  'dhee_find',
] as const;

export {
  dheeApplyWorkflowAliasesTool,
  dheeCheckWorkflowTool,
  dheeCreateProjectTool,
  dheeCritiqueNodeTool,
  dheeDescribeBundleTool,
  dheeForkTool,
  dheeGetStatusTool,
  dheeListBundlesTool,
  dheeListVersionsTool,
  dheePresentBundleChoicesTool,
  dheeReadArtifactTool,
  dheeRegenerateNodeTool,
  dheeRunBundleTool,
  dheeSelectVersionTool,
  dheeShowFileTool,
  dheeShowNodeOutputTool,
  dheeSwapRunnerTool,
  dheeWriteInputTool,
  dheeWriteNodeContentTool,
  dheeReadTool,
  dheeLsTool,
  dheeGrepTool,
  dheeFindTool,
  makeApplyWorkflowAliasesTool,
  makeCheckWorkflowTool,
  makeCreateProjectTool,
  makeCritiqueNodeTool,
  makeDescribeBundleTool,
  makeForkTool,
  makeGetStatusTool,
  makeListBundlesTool,
  makeListVersionsTool,
  makePresentBundleChoicesTool,
  makeReadArtifactTool,
  makeRegenerateNodeTool,
  makeRunBundleTool,
  makeSelectVersionTool,
  makeShowFileTool,
  makeShowNodeOutputTool,
  makeSwapRunnerTool,
  makeWriteInputTool,
  makeWriteNodeContentTool,
  makeReadTool,
  makeLsTool,
  makeGrepTool,
  makeFindTool,
};

/**
 * pi extensionFactory — registers all v1 dhee tools.
 * Pass this in `DefaultResourceLoader({extensionFactories: [registerDheeTools]})`.
 */
export function registerDheeTools(pi: ExtensionAPI): void {
  pi.registerTool(dheeCreateProjectTool);
  pi.registerTool(dheeListBundlesTool);
  pi.registerTool(dheePresentBundleChoicesTool);
  pi.registerTool(dheeDescribeBundleTool);
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
  pi.registerTool(dheeWriteInputTool);
  pi.registerTool(dheeWriteNodeContentTool);
  pi.registerTool(dheeReadTool);
  pi.registerTool(dheeLsTool);
  pi.registerTool(dheeGrepTool);
  pi.registerTool(dheeFindTool);
}
