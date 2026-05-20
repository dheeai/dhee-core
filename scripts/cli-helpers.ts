/**
 * Shared utilities for the project-CLI scripts (`new`, `show`, `list`,
 * `status`, `regen`, `set`).
 *
 * The actual implementations live in `src/core/project/projectTypes.ts`
 * so server code can import without violating `rootDir`. This module
 * keeps the existing import paths in scripts/ working and adds the
 * `loadProjectStrict` wrapper that exits on failure (CLI ergonomics
 * — the HTTP path uses `loadProject` which returns null instead).
 */

import {
  loadProject,
  type ProjectFile,
} from '../src/core/project/projectTypes.js';

export {
  projectDirFor,
  loadProject,
  resolveNodeId,
  matchNodes,
  type ExecutorState,
  type ExecutionNode,
  type ProjectFile,
} from '../src/core/project/projectTypes.js';

export function loadProjectStrict(name: string, basePath: string = process.cwd()): {
  project: ProjectFile;
  projectDir: string;
} {
  const result = loadProject(name, basePath);
  if (!result) {
    console.error(`Project not found: ${name}.dhee under ${basePath}`);
    process.exit(1);
  }
  return result;
}
