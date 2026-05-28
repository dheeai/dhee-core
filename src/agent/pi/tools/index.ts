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

export const DHEE_TOOL_NAMES = [
  'dhee_create_project',
  'dhee_run_bundle',
  'dhee_get_status',
  'dhee_regenerate_node',
  'dhee_read_artifact',
] as const;

export {
  dheeCreateProjectTool,
  dheeGetStatusTool,
  dheeReadArtifactTool,
  dheeRegenerateNodeTool,
  dheeRunBundleTool,
  makeCreateProjectTool,
  makeGetStatusTool,
  makeReadArtifactTool,
  makeRegenerateNodeTool,
  makeRunBundleTool,
};

/**
 * pi extensionFactory — registers all 5 v1 dhee tools.
 * Pass this in `DefaultResourceLoader({extensionFactories: [registerDheeTools]})`.
 */
export function registerDheeTools(pi: ExtensionAPI): void {
  pi.registerTool(dheeCreateProjectTool);
  pi.registerTool(dheeRunBundleTool);
  pi.registerTool(dheeGetStatusTool);
  pi.registerTool(dheeRegenerateNodeTool);
  pi.registerTool(dheeReadArtifactTool);
}
