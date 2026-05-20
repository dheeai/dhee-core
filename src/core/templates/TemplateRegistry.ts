/**
 * Template Registry
 *
 * Central registry for video generation templates.
 * Handles loading, validation, and retrieval of templates.
 */

import type {
  VideoTemplate,
  ArtifactTypeDefinition,
  ArtifactDependency,
  PhaseDefinition,
  InputTypeConfig,
  StyleConfig,
} from './types.js';

/**
 * Validation error for template definitions
 */
export interface TemplateValidationError {
  type: 'error' | 'warning';
  path: string;
  message: string;
}

/**
 * Result of template validation
 */
export interface TemplateValidationResult {
  valid: boolean;
  errors: TemplateValidationError[];
  warnings: TemplateValidationError[];
}

/**
 * Template Registry singleton
 */
export class TemplateRegistry {
  private static instance: TemplateRegistry;
  private templates: Map<string, VideoTemplate> = new Map();
  private customValidators: Map<string, (content: unknown) => boolean> = new Map();

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): TemplateRegistry {
    if (!TemplateRegistry.instance) {
      TemplateRegistry.instance = new TemplateRegistry();
    }
    return TemplateRegistry.instance;
  }

  /**
   * Reset the registry (for testing)
   */
  static reset(): void {
    TemplateRegistry.instance = new TemplateRegistry();
  }

  /**
   * Register a template
   */
  register(template: VideoTemplate): TemplateValidationResult {
    const validation = this.validate(template);

    if (!validation.valid) {
      return validation;
    }

    this.templates.set(template.id, template);
    return validation;
  }

  /**
   * Register multiple templates
   */
  registerAll(templates: VideoTemplate[]): Map<string, TemplateValidationResult> {
    const results = new Map<string, TemplateValidationResult>();

    for (const template of templates) {
      results.set(template.id, this.register(template));
    }

    return results;
  }

  /**
   * Get a template by ID
   */
  get(id: string): VideoTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Get a template by ID or throw
   */
  getOrThrow(id: string): VideoTemplate {
    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`Template not found: ${id}`);
    }
    return template;
  }

  /**
   * Check if a template exists
   */
  has(id: string): boolean {
    return this.templates.has(id);
  }

  /**
   * List all registered templates
   */
  list(): VideoTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * List template IDs
   */
  listIds(): string[] {
    return Array.from(this.templates.keys());
  }

  /**
   * Get templates summary for display
   */
  getSummary(): Array<{ id: string; displayName: string; description: string }> {
    return this.list().map((t) => ({
      id: t.id,
      displayName: t.displayName,
      description: t.description,
    }));
  }

  /**
   * Unregister a template
   */
  unregister(id: string): boolean {
    return this.templates.delete(id);
  }

  /**
   * Register a custom validator function
   */
  registerValidator(name: string, validator: (content: unknown) => boolean): void {
    this.customValidators.set(name, validator);
  }

  /**
   * Get a custom validator
   */
  getValidator(name: string): ((content: unknown) => boolean) | undefined {
    return this.customValidators.get(name);
  }

  /**
   * Validate a template definition
   */
  validate(template: VideoTemplate): TemplateValidationResult {
    const errors: TemplateValidationError[] = [];
    const warnings: TemplateValidationError[] = [];

    // Basic required fields
    if (!template.id) {
      errors.push({ type: 'error', path: 'id', message: 'Template ID is required' });
    }
    if (!template.displayName) {
      errors.push({ type: 'error', path: 'displayName', message: 'Display name is required' });
    }
    if (!template.version) {
      errors.push({ type: 'error', path: 'version', message: 'Version is required' });
    }

    // Check for duplicate template ID
    if (template.id && this.templates.has(template.id)) {
      warnings.push({
        type: 'warning',
        path: 'id',
        message: `Template '${template.id}' already exists and will be overwritten`,
      });
    }

    // Validate artifact types
    const artifactTypeIds = new Set<string>();
    for (const [typeId, artifactType] of Object.entries(template.artifactTypes || {})) {
      if (typeId !== artifactType.id) {
        errors.push({
          type: 'error',
          path: `artifactTypes.${typeId}`,
          message: `Artifact type key '${typeId}' does not match id '${artifactType.id}'`,
        });
      }

      artifactTypeIds.add(typeId);

      // Validate artifact type
      const typeErrors = this.validateArtifactType(artifactType, template);
      errors.push(...typeErrors.filter((e) => e.type === 'error'));
      warnings.push(...typeErrors.filter((e) => e.type === 'warning'));
    }

    // Validate dependencies reference existing artifact types
    for (const [typeId, artifactType] of Object.entries(template.artifactTypes || {})) {
      for (const dep of artifactType.dependencies || []) {
        if (!artifactTypeIds.has(dep.artifactTypeId)) {
          errors.push({
            type: 'error',
            path: `artifactTypes.${typeId}.dependencies`,
            message: `Dependency '${dep.artifactTypeId}' does not exist in template`,
          });
        }
      }
    }

    // Validate dependency graph is acyclic
    const cycleCheck = this.checkForCycles(template);
    if (cycleCheck) {
      errors.push({
        type: 'error',
        path: 'artifactTypes',
        message: `Circular dependency detected: ${cycleCheck.join(' -> ')}`,
      });
    }

    // Validate input types
    for (const inputType of template.inputTypes || []) {
      const inputErrors = this.validateInputType(inputType, artifactTypeIds);
      errors.push(...inputErrors.filter((e) => e.type === 'error'));
      warnings.push(...inputErrors.filter((e) => e.type === 'warning'));
    }

    // Validate phases
    if (template.phases) {
      const phaseErrors = this.validatePhases(template.phases, artifactTypeIds);
      errors.push(...phaseErrors.filter((e) => e.type === 'error'));
      warnings.push(...phaseErrors.filter((e) => e.type === 'warning'));
    }

    // Validate context variables
    for (const [varName, artifactTypeId] of Object.entries(template.contextVariables || {})) {
      if (!artifactTypeIds.has(artifactTypeId)) {
        errors.push({
          type: 'error',
          path: `contextVariables.${varName}`,
          message: `Context variable references non-existent artifact type '${artifactTypeId}'`,
        });
      }
    }

    // Validate default style exists
    if (template.defaultStyle) {
      const styleExists = template.styles?.some((s: StyleConfig) => s.id === template.defaultStyle);
      if (!styleExists) {
        errors.push({
          type: 'error',
          path: 'defaultStyle',
          message: `Default style '${template.defaultStyle}' not found in styles`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a single artifact type definition
   */
  private validateArtifactType(
    artifactType: ArtifactTypeDefinition,
    template: VideoTemplate
  ): TemplateValidationError[] {
    const errors: TemplateValidationError[] = [];
    const path = `artifactTypes.${artifactType.id}`;

    if (!artifactType.id) {
      errors.push({ type: 'error', path, message: 'Artifact type ID is required' });
    }
    if (!artifactType.displayName) {
      errors.push({ type: 'error', path, message: 'Display name is required' });
    }
    if (!artifactType.category) {
      errors.push({ type: 'error', path, message: 'Category is required' });
    }
    if (!artifactType.outputFormat) {
      errors.push({ type: 'error', path, message: 'Output format is required' });
    }
    if (!artifactType.filePattern) {
      errors.push({ type: 'error', path, message: 'File pattern is required' });
    }
    if (!artifactType.agentType) {
      errors.push({ type: 'error', path, message: 'Agent type is required' });
    }
    if (!artifactType.promptFile) {
      errors.push({ type: 'error', path, message: 'Prompt file is required' });
    }

    // Collection-specific validation
    if (artifactType.isCollection) {
      if (!artifactType.itemName) {
        errors.push({
          type: 'warning',
          path,
          message: 'Collection type should have an itemName',
        });
      }
    }

    // Validate file pattern has required placeholders for collections
    if (artifactType.isCollection) {
      const hasNamePlaceholder = artifactType.filePattern.includes('{{name}}');
      const hasIndexPlaceholder = artifactType.filePattern.includes('{{index}}');
      const hasIdPlaceholder = artifactType.filePattern.includes('{{id}}');

      if (!hasNamePlaceholder && !hasIndexPlaceholder && !hasIdPlaceholder) {
        errors.push({
          type: 'error',
          path: `${path}.filePattern`,
          message: 'Collection file pattern must include {{name}}, {{index}}, or {{id}} placeholder',
        });
      }
    }

    // Validate custom validator exists if specified
    if (artifactType.validation?.customValidator) {
      if (!this.customValidators.has(artifactType.validation.customValidator)) {
        errors.push({
          type: 'warning',
          path: `${path}.validation.customValidator`,
          message: `Custom validator '${artifactType.validation.customValidator}' not registered`,
        });
      }
    }

    return errors;
  }

  /**
   * Validate an input type configuration
   */
  private validateInputType(
    inputType: InputTypeConfig,
    artifactTypeIds: Set<string>
  ): TemplateValidationError[] {
    const errors: TemplateValidationError[] = [];
    const path = `inputTypes.${inputType.id}`;

    if (!inputType.id) {
      errors.push({ type: 'error', path, message: 'Input type ID is required' });
    }
    if (!inputType.displayName) {
      errors.push({ type: 'error', path, message: 'Display name is required' });
    }
    if (!inputType.mapsToArtifact) {
      errors.push({ type: 'error', path, message: 'mapsToArtifact is required' });
    } else if (!artifactTypeIds.has(inputType.mapsToArtifact)) {
      errors.push({
        type: 'error',
        path: `${path}.mapsToArtifact`,
        message: `Artifact type '${inputType.mapsToArtifact}' does not exist`,
      });
    }

    // Validate skipsArtifacts references existing types
    for (const skipId of inputType.skipsArtifacts || []) {
      if (!artifactTypeIds.has(skipId)) {
        errors.push({
          type: 'error',
          path: `${path}.skipsArtifacts`,
          message: `Artifact type '${skipId}' does not exist`,
        });
      }
    }

    return errors;
  }

  /**
   * Validate phase definitions
   */
  private validatePhases(
    phases: PhaseDefinition[],
    artifactTypeIds: Set<string>
  ): TemplateValidationError[] {
    const errors: TemplateValidationError[] = [];
    const phaseIds = new Set<string>();
    const assignedArtifacts = new Set<string>();

    for (const phase of phases) {
      const path = `phases.${phase.id}`;

      if (!phase.id) {
        errors.push({ type: 'error', path, message: 'Phase ID is required' });
        continue;
      }

      if (phaseIds.has(phase.id)) {
        errors.push({ type: 'error', path, message: `Duplicate phase ID '${phase.id}'` });
      }
      phaseIds.add(phase.id);

      // Validate artifact types in phase exist
      for (const artifactTypeId of phase.artifactTypes || []) {
        if (!artifactTypeIds.has(artifactTypeId)) {
          errors.push({
            type: 'error',
            path: `${path}.artifactTypes`,
            message: `Artifact type '${artifactTypeId}' does not exist`,
          });
        }

        if (assignedArtifacts.has(artifactTypeId)) {
          errors.push({
            type: 'error',
            path: `${path}.artifactTypes`,
            message: `Artifact type '${artifactTypeId}' is assigned to multiple phases`,
          });
        }
        assignedArtifacts.add(artifactTypeId);
      }
    }

    // Check if all artifact types are assigned to a phase
    for (const artifactTypeId of Array.from(artifactTypeIds)) {
      if (!assignedArtifacts.has(artifactTypeId)) {
        errors.push({
          type: 'warning',
          path: 'phases',
          message: `Artifact type '${artifactTypeId}' is not assigned to any phase`,
        });
      }
    }

    return errors;
  }

  /**
   * Check for cycles in the dependency graph
   * Returns the cycle path if found, null otherwise
   */
  private checkForCycles(template: VideoTemplate): string[] | null {
    const artifactTypes = template.artifactTypes || {};
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const hasCycle = (typeId: string): boolean => {
      visited.add(typeId);
      recursionStack.add(typeId);
      path.push(typeId);

      const artifactType = artifactTypes[typeId];
      if (artifactType) {
        for (const dep of artifactType.dependencies || []) {
          if (!visited.has(dep.artifactTypeId)) {
            if (hasCycle(dep.artifactTypeId)) {
              return true;
            }
          } else if (recursionStack.has(dep.artifactTypeId)) {
            path.push(dep.artifactTypeId);
            return true;
          }
        }
      }

      path.pop();
      recursionStack.delete(typeId);
      return false;
    };

    for (const typeId of Object.keys(artifactTypes)) {
      if (!visited.has(typeId)) {
        if (hasCycle(typeId)) {
          // Find the start of the cycle in the path
          const lastNode = path[path.length - 1];
          if (lastNode) {
            const cycleStart = path.indexOf(lastNode);
            return path.slice(cycleStart);
          }
          return path;
        }
      }
    }

    return null;
  }

  /**
   * Get artifact types in dependency order (topological sort)
   */
  getCreationOrder(template: VideoTemplate): string[] {
    const artifactTypes = template.artifactTypes || {};
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (typeId: string) => {
      if (visited.has(typeId)) return;
      visited.add(typeId);

      const artifactType = artifactTypes[typeId] as ArtifactTypeDefinition | undefined;
      if (artifactType) {
        for (const dep of artifactType.dependencies || []) {
          if (dep.required) {
            visit(dep.artifactTypeId);
          }
        }
      }

      result.push(typeId);
    };

    for (const typeId of Object.keys(artifactTypes)) {
      visit(typeId);
    }

    return result;
  }

  /**
   * Get all artifact types that depend on a given type
   */
  getDependents(template: VideoTemplate, typeId: string): string[] {
    const dependents: string[] = [];

    for (const [otherTypeId, artifactType] of Object.entries(template.artifactTypes || {})) {
      for (const dep of artifactType.dependencies || []) {
        if (dep.artifactTypeId === typeId) {
          dependents.push(otherTypeId);
          break;
        }
      }
    }

    return dependents;
  }

  /**
   * Get all artifact types that a given type depends on
   */
  getDependencies(template: VideoTemplate, typeId: string): string[] {
    const artifactType = template.artifactTypes?.[typeId];
    if (!artifactType) return [];

    return artifactType.dependencies?.map((d) => d.artifactTypeId) || [];
  }

  /**
   * Auto-detect the best input type for given content
   */
  detectInputType(template: VideoTemplate, content: string): string | null {
    const inputTypes = template.inputTypes || [];
    let bestMatch: { id: string; score: number } | null = null;

    for (const inputType of inputTypes) {
      let score = 0;

      for (const pattern of inputType.detectionPatterns || []) {
        if (this.matchesDetectionPattern(content, pattern as { type: string; config: Record<string, unknown>; weight: number })) {
          score += pattern.weight;
        }
      }

      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { id: inputType.id, score };
      }
    }

    return bestMatch?.id ?? null;
  }

  /**
   * Check if content matches a detection pattern
   */
  private matchesDetectionPattern(
    content: string,
    pattern: { type: string; config: Record<string, unknown>; weight: number }
  ): boolean {
    switch (pattern.type) {
      case 'length': {
        const minLength = pattern.config['minLength'] as number | undefined;
        const maxLength = pattern.config['maxLength'] as number | undefined;
        const length = content.length;

        if (minLength !== undefined && length < minLength) return false;
        if (maxLength !== undefined && length > maxLength) return false;
        return true;
      }

      case 'keywords': {
        const keywords = pattern.config['keywords'] as string[];
        const minMatches = (pattern.config['minMatches'] as number) || 1;
        const matchCount = keywords.filter((kw) =>
          content.toLowerCase().includes(kw.toLowerCase())
        ).length;
        return matchCount >= minMatches;
      }

      case 'structure': {
        const hasHeadings = pattern.config['hasHeadings'] as boolean;
        const hasParagraphs = pattern.config['hasParagraphs'] as boolean;
        const hasDialogue = pattern.config['hasDialogue'] as boolean;

        if (hasHeadings && !content.match(/^#+\s/m)) return false;

        // More lenient paragraph detection: 2+ paragraph breaks OR 5+ line breaks
        if (hasParagraphs) {
          const paragraphBreaks = content.split(/\n\n+/).length;
          const lineBreaks = content.split(/\n/).length;
          if (paragraphBreaks < 2 && lineBreaks < 5) return false;
        }

        // More flexible dialogue detection: multiple quote formats + dialogue tags
        if (hasDialogue) {
          const dialoguePatterns = [
            /[""].+[""]/, // Smart quotes
            /".+"/, // Regular quotes
            /'.+'/, // Single quotes
            /—.+/, // Em-dash dialogue
            /\b(said|asked|replied|whispered|shouted|muttered|exclaimed)\b/i, // Dialogue tags
          ];
          const hasAnyDialogue = dialoguePatterns.some((p) => content.match(p));
          if (!hasAnyDialogue) return false;
        }
        return true;
      }

      default:
        return false;
    }
  }
}
