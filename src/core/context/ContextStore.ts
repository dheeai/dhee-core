/**
 * DEPRECATED: Context store - file persistence has been disabled.
 *
 * Context storage has been replaced with dynamic file discovery:
 * - Agents use list_project_files() to discover what content exists
 * - Agents use read_file() to access specific content when needed
 *
 * This class is kept for API compatibility but does NOT write to disk.
 * It only tracks variable names in memory.
 */

/**
 * Metadata for stored context (stored in index.json)
 * Key is the variable name (e.g., "$plan", "$chapter_1")
 */
interface StoredContextMeta {
  variableName: string;  // e.g., $user_story, $chapter_1 (also used as key and filename)
  label: string;
  createdAt: string;
  charCount: number;
  source: 'user_input' | 'tool' | 'manual';
}

/**
 * Full context data (metadata + content)
 */
export interface StoredContext extends StoredContextMeta {
  content: string;
}

// NOTE: Context directory is no longer used
// Agents use .dhee/plans/, .dhee/characters/, etc. directly

/**
 * Persistent context store for large content.
 * Uses variable names as the primary key for both index and file storage.
 */
export class ContextStore {
  private index: Map<string, StoredContextMeta> = new Map();
  private variableCounter: Map<string, number> = new Map();

  constructor() {
    this.loadIndex();
    this.rebuildVariableCounter();
  }

  /**
   * Rebuild variable counter from existing index for unique naming.
   */
  private rebuildVariableCounter(): void {
    this.variableCounter.clear();
    for (const meta of this.index.values()) {
      const match = meta.variableName.match(/^\$([a-z_]+)(?:_(\d+))?$/);
      if (match) {
        const baseName = match[1] as string;
        const num = match[2] ? parseInt(match[2], 10) : 1;
        const current = this.variableCounter.get(baseName) ?? 0;
        this.variableCounter.set(baseName, Math.max(current, num));
      }
    }
  }

  /**
   * Generate a unique variable name based on a base name.
   */
  private generateVariableName(baseName: string): string {
    const normalized = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const base = normalized || 'context';

    const count = (this.variableCounter.get(base) ?? 0) + 1;
    this.variableCounter.set(base, count);

    return count === 1 ? `$${base}` : `$${base}_${count}`;
  }

  /**
   * DEPRECATED: No longer loads from disk.
   * Context storage has been replaced with dynamic file discovery.
   */
  private loadIndex(): void {
    // No-op: Context files are no longer used
    // Agents use list_project_files() + read_file() instead
    this.index = new Map();
  }

  /**
   * DEPRECATED: No longer saves to disk.
   * Context storage has been replaced with dynamic file discovery.
   */
  private saveIndex(): void {
    // No-op: Context files are no longer created
  }

  /**
   * DEPRECATED: File-based context storage has been replaced with dynamic file discovery.
   *
   * Agents now use:
   * - list_project_files() to discover what content exists in .dhee/
   * - read_file() to read specific content when needed
   *
   * This method is kept for API compatibility but does NOT write to disk.
   * It only generates a variable name and tracks in memory (no persistence).
   *
   * @param content - The full content (ignored - not stored)
   * @param label - A descriptive label for this context
   * @param options - Additional options
   * @returns The variable name (e.g., "$plan") - for API compatibility only
   */
  store(
    content: string,
    label: string,
    options: {
      source?: 'user_input' | 'tool' | 'manual';
      variableBaseName?: string;
    } = {}
  ): { variableName: string } {
    // Generate a variable name for API compatibility, but don't persist anything
    const variableName = this.generateVariableName(options.variableBaseName ?? label);

    // Track in memory only (no file creation, no index persistence)
    // This allows getActiveVariables() to still work for debugging
    const meta: StoredContextMeta = {
      variableName,
      label,
      createdAt: new Date().toISOString(),
      charCount: content.length,
      source: options.source ?? 'manual',
    };
    this.index.set(variableName, meta);

    // NOTE: Deliberately NOT calling saveIndex() or writeFileSync()
    // Context files are no longer created - agents use project files directly

    return { variableName };
  }

  /**
   * DEPRECATED: Context content is no longer stored.
   * Use read_file() to access project files directly.
   *
   * @param variableName - The variable name (e.g., "$plan")
   * @returns Always returns null - content is not stored
   */
  get(variableName: string): { content: string; label: string } | null {
    // Content is no longer stored - agents should use read_file() instead
    return null;
  }

  /**
   * Get all active context variables with their metadata.
   */
  getActiveVariables(): Array<{ variableName: string; label: string; charCount: number }> {
    return Array.from(this.index.values()).map(meta => ({
      variableName: meta.variableName,
      label: meta.label,
      charCount: meta.charCount,
    }));
  }

  /**
   * Get metadata for a stored context (without loading content).
   */
  getMeta(variableName: string): StoredContextMeta | null {
    return this.index.get(variableName) ?? null;
  }

  /**
   * DEPRECATED: Context files are no longer created.
   * This method only clears in-memory tracking.
   *
   * @param variableName - The variable name (e.g., "$plan")
   * @returns true if removed from memory, false if not found
   */
  delete(variableName: string): boolean {
    if (!this.index.has(variableName)) return false;
    this.index.delete(variableName);
    return true;
  }

  /**
   * List all stored contexts (metadata only).
   */
  list(): StoredContextMeta[] {
    return Array.from(this.index.values());
  }

  /**
   * Search for contexts by label pattern (case-insensitive).
   * Returns contexts whose labels contain the given pattern.
   *
   * @param pattern - Text pattern to search for in labels
   * @returns Array of matching context metadata
   */
  searchByLabel(pattern: string): StoredContextMeta[] {
    const normalizedPattern = pattern.toLowerCase();
    const results: StoredContextMeta[] = [];
    for (const meta of this.index.values()) {
      if (meta.label.toLowerCase().includes(normalizedPattern)) {
        results.push(meta);
      }
    }
    return results;
  }

  /**
   * DEPRECATED: Context content is no longer stored.
   * Use list_project_files() + read_file() instead.
   *
   * @param pattern - Text pattern to search for in labels
   * @returns Always returns empty array - content is not stored
   */
  searchByLabelWithContent(pattern: string): StoredContext[] {
    // Content is no longer stored - agents should use project files directly
    return [];
  }

  /**
   * DEPRECATED: Context files are no longer created.
   * This method only clears old entries from in-memory tracking.
   */
  cleanup(olderThanDays: number = 7): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    const cutoffTime = cutoffDate.getTime();

    let deleted = 0;
    for (const [variableName, meta] of this.index.entries()) {
      const createdTime = new Date(meta.createdAt).getTime();
      if (createdTime < cutoffTime) {
        this.index.delete(variableName);
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * DEPRECATED: Context files are no longer created.
   * This method only clears in-memory tracking.
   */
  clear(): number {
    const count = this.index.size;
    this.index.clear();
    this.variableCounter.clear();
    return count;
  }
}

// Singleton instance for shared access across the application
export const contextStore = new ContextStore();
