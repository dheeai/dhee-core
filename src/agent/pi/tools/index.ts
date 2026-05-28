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

import { dheeCreateProjectTool, makeCreateProjectTool } from './dheeCreateProject.js';
import { dheeGetStatusTool, makeGetStatusTool } from './dheeGetStatus.js';
import { dheeReadArtifactTool, makeReadArtifactTool } from './dheeReadArtifact.js';
import { dheeRegenerateNodeTool, makeRegenerateNodeTool } from './dheeRegenerateNode.js';
import { dheeRunBundleTool, makeRunBundleTool } from './dheeRunBundle.js';
import { dheeShowFileTool, makeShowFileTool } from './dheeShowFile.js';
import { dheeShowNodeOutputTool, makeShowNodeOutputTool } from './dheeShowNodeOutput.js';

export const DHEE_TOOL_NAMES = [
  'dhee_create_project',
  'dhee_run_bundle',
  'dhee_get_status',
  'dhee_regenerate_node',
  'dhee_read_artifact',
  'dhee_show_node_output',
  'dhee_show_file',
] as const;

export {
  dheeCreateProjectTool,
  dheeGetStatusTool,
  dheeReadArtifactTool,
  dheeRegenerateNodeTool,
  dheeRunBundleTool,
  dheeShowFileTool,
  dheeShowNodeOutputTool,
  makeCreateProjectTool,
  makeGetStatusTool,
  makeReadArtifactTool,
  makeRegenerateNodeTool,
  makeRunBundleTool,
  makeShowFileTool,
  makeShowNodeOutputTool,
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
  pi.registerTool(dheeReadArtifactTool);
  pi.registerTool(dheeShowNodeOutputTool);
  pi.registerTool(dheeShowFileTool);
}
