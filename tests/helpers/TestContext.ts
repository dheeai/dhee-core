/**
 * Test Context
 *
 * Manages test isolation and cleanup.
 * Creates temporary workspaces and cleans up after tests.
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ContextStore } from '../../src/core/context/ContextStore.js';
import { contextStore as globalContextStore } from '../../src/core/context/ContextStore.js';

export interface TestContextOptions {
  /** Custom name for the test workspace (default: random ID) */
  name?: string;
  /** Base directory for test workspaces (default: system temp dir) */
  baseDir?: string;
  /** Whether to preserve the workspace after test (for debugging) */
  preserve?: boolean;
}

export class TestContext {
  private readonly workspaceId: string;
  private readonly workspacePath: string;
  private readonly preserve: boolean;
  private contextStore?: ContextStore;

  constructor(options: TestContextOptions = {}) {
    this.workspaceId = options.name || `test_${randomBytes(8).toString('hex')}`;
    this.preserve = options.preserve ?? false;

    // Use custom base dir or system temp dir
    const baseDir = options.baseDir || tmpdir();
    this.workspacePath = join(baseDir, `dhee_test_${this.workspaceId}`);

    // Create workspace directory
    this.setup();
  }

  /**
   * Set up the test workspace.
   */
  private setup(): void {
    if (!existsSync(this.workspacePath)) {
      mkdirSync(this.workspacePath, { recursive: true });
    }
  }

  /**
   * Get the workspace path.
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Get a path within the workspace.
   * @param relativePath - Path relative to workspace root
   */
  getPath(relativePath: string): string {
    return join(this.workspacePath, relativePath);
  }

  /**
   * Get the .dhee project directory path.
   */
  getProjectPath(): string {
    return join(this.workspacePath, '.dhee');
  }

  /**
   * Get or create a ContextStore for this test context.
   * Uses a separate instance to avoid interfering with global state.
   */
  getContextStore(): ContextStore {
    if (!this.contextStore) {
      // Change to workspace directory so ContextStore uses the right path
      const originalCwd = process.cwd();
      process.chdir(this.workspacePath);

      try {
        this.contextStore = new ContextStore();
      } finally {
        process.chdir(originalCwd);
      }
    }
    return this.contextStore;
  }

  /**
   * Change to the workspace directory.
   */
  chdir(): void {
    process.chdir(this.workspacePath);
  }

  /**
   * Change back to the original directory.
   */
  chdirOriginal(): void {
    // We'll need to track the original cwd if we want to restore it
    // For now, tests should handle this themselves
  }

  /**
   * Clean up the test workspace.
   * Call this in test afterEach to clean up.
   */
  cleanup(): void {
    if (this.preserve) {
      console.log(`[TestContext] Preserving workspace: ${this.workspacePath}`);
      return;
    }

    // Clear context store
    if (this.contextStore) {
      try {
        this.contextStore.clear();
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Remove workspace directory
    if (existsSync(this.workspacePath)) {
      try {
        rmSync(this.workspacePath, { recursive: true, force: true });
      } catch {
        // Ignore errors during cleanup
      }
    }
  }

  /**
   * Create a file in the workspace.
   * @param relativePath - Path relative to workspace root
   * @param content - File content
   */
  writeFile(relativePath: string, content: string): void {
    const filePath = this.getPath(relativePath);
    const dir = require('path').dirname(filePath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    require('fs').writeFileSync(filePath, content, 'utf-8');
  }

  /**
   * Read a file from the workspace.
   * @param relativePath - Path relative to workspace root
   * @returns File content or null if not found
   */
  readFile(relativePath: string): string | null {
    const filePath = this.getPath(relativePath);

    if (!existsSync(filePath)) {
      return null;
    }

    return require('fs').readFileSync(filePath, 'utf-8');
  }

  /**
   * Check if a file exists in the workspace.
   * @param relativePath - Path relative to workspace root
   */
  fileExists(relativePath: string): boolean {
    return existsSync(this.getPath(relativePath));
  }

  /**
   * Create a .dhee project structure.
   */
  createProjectStructure(): void {
    const projectDir = this.getProjectPath();
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    // Create common subdirectories
    const subdirs = [
      'plans',
      'assets',
      'assets/images',
      'assets/videos',
      'characters',
      'settings',
      'scenes',
    ];

    for (const subdir of subdirs) {
      const path = join(projectDir, subdir);
      if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
      }
    }
  }

  /**
   * Get the workspace ID.
   */
  getId(): string {
    return this.workspaceId;
  }
}

/**
 * Helper to create and auto-cleanup test contexts.
 * Use with beforeEach/afterEach:
 *
 * ```ts
 * let ctx: TestContext;
 * beforeEach(() => {
 *   ctx = createTestContext();
 * });
 * afterEach(() => {
 *   ctx.cleanup();
 * });
 * ```
 */
export function createTestContext(options?: TestContextOptions): TestContext {
  return new TestContext(options);
}
