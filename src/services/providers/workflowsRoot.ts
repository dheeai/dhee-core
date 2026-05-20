/**
 * Host-supplied user workflows directory.
 *
 * Purpose: when dhee-core is embedded in a host like dhee-desktop,
 * the host wants user-uploaded workflows to live in a writable
 * location it controls (e.g. `app.getPath('userData')/workflows/user/`)
 * rather than inside the dhee-core checkout. Built-in / cloud
 * workflows still come from dhee-core's `workflows/built-in/` and
 * `workflows/cloud/` — this only adds an additional scan target for
 * user-owned manifests.
 *
 * Init order: hosts must call `setUserWorkflowsDir()` BEFORE the first
 * `getWorkflowModeRegistry()` call. The registry reads this at
 * `refresh()` time, so a late call would silently miss the directory
 * until the next refresh — and many call sites assume the singleton's
 * first scan is authoritative. We throw to surface that timing bug
 * loudly.
 */

import { existsSync, statSync } from 'fs';
import { resetWorkflowModeRegistryForTesting } from './WorkflowModeRegistry.js';

let userWorkflowsDir: string | undefined;
let registryInitialized = false;

export function setUserWorkflowsDir(path: string): void {
  // Idempotent on the same path — hosts that restart on settings
  // changes (dhee-desktop calls dheeCoreManager.restart() →
  // start() → setUserWorkflowsDir() again) must not crash on the
  // second call with the same value. Only throw if the host tries
  // to point us at a *different* directory after init, which is a
  // real init-order bug.
  if (registryInitialized) {
    if (path === userWorkflowsDir) return;
    throw new Error(
      `setUserWorkflowsDir() called with a different path after the WorkflowModeRegistry was already created. ` +
        `previous=${userWorkflowsDir} requested=${path}. ` +
        `Call this from your host's bootstrap, before any code that imports workflows.`,
    );
  }
  if (!existsSync(path)) {
    throw new Error(`setUserWorkflowsDir: path does not exist: ${path}`);
  }
  if (!statSync(path).isDirectory()) {
    throw new Error(`setUserWorkflowsDir: path is not a directory: ${path}`);
  }
  userWorkflowsDir = path;
}

export function getUserWorkflowsDir(): string | undefined {
  return userWorkflowsDir;
}

/**
 * Called by `getWorkflowModeRegistry()` the first time the singleton is
 * created. After this point, `setUserWorkflowsDir()` will throw.
 */
export function markRegistryInitialized(): void {
  registryInitialized = true;
}

/**
 * Test-only: reset module state between tests. Production code must
 * not call this — the init-order assertion is load-bearing.
 */
export function resetUserWorkflowsDirForTesting(): void {
  userWorkflowsDir = undefined;
  registryInitialized = false;
  // Also clear the singleton so the next test gets a fresh registry
  // that reflects whatever workflowsRoot state the test sets up.
  resetWorkflowModeRegistryForTesting();
}
