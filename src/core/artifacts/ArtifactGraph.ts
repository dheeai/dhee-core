/**
 * Artifact Graph
 *
 * Builds and manages the dependency graph for artifacts within a template.
 * Provides utilities for dependency resolution, topological sorting,
 * and ripple effect calculation.
 */

import type {
  VideoTemplate,
  ArtifactTypeDefinition,
  ArtifactInstance,
  ArtifactDependency,
  GenericProjectFile,
  DependencyScope,
} from '../templates/types.js';

/**
 * Node in the artifact dependency graph
 */
export interface ArtifactGraphNode {
  /** Artifact type ID */
  typeId: string;

  /** Artifact type definition */
  definition: ArtifactTypeDefinition;

  /** IDs of artifact types this node depends on */
  dependsOn: string[];

  /** IDs of artifact types that depend on this node */
  dependedBy: string[];

  /** Detailed dependency information */
  dependencies: ArtifactDependency[];

  /** Depth in the graph (0 = no dependencies) */
  depth: number;
}

/**
 * Result of checking if an artifact can be created
 */
export interface CanCreateResult {
  /** Whether the artifact can be created */
  canCreate: boolean;

  /** Missing required dependencies */
  missingRequired: MissingDependency[];

  /** Missing optional dependencies */
  missingOptional: MissingDependency[];

  /** Available dependencies that are met */
  availableDependencies: string[];
}

/**
 * Information about a missing dependency
 */
export interface MissingDependency {
  /** Artifact type ID */
  typeId: string;

  /** Display name */
  displayName: string;

  /** Whether it's required */
  required: boolean;

  /** For collections: specific items that are missing */
  missingItems?: string[];

  /** Reason this dependency is needed */
  reason: string;
}

/**
 * Ripple effect when an artifact changes
 */
export interface RippleEffect {
  /** Artifacts that will be invalidated */
  invalidated: ArtifactImpact[];

  /** Artifacts that need updating */
  needsUpdate: ArtifactImpact[];

  /** Total count of affected artifacts */
  totalAffected: number;
}

/**
 * Impact on a specific artifact
 */
export interface ArtifactImpact {
  /** Instance ID */
  instanceId: string;

  /** Artifact type ID */
  typeId: string;

  /** Name of the artifact */
  name: string;

  /** Type of impact */
  impactType: 'invalidated' | 'needs_update';

  /** Chain depth (how many dependencies away) */
  chainDepth: number;

  /** Human-readable reason */
  reason: string;
}

/**
 * Creation plan for artifacts
 */
export interface CreationPlan {
  /** Ordered list of artifact types to create */
  order: string[];

  /** Steps with details */
  steps: CreationStep[];

  /** Total estimated cost (for expensive operations) */
  estimatedCost: number;
}

/**
 * Single step in a creation plan
 */
export interface CreationStep {
  /** Step number (1-indexed) */
  step: number;

  /** Artifact type ID */
  typeId: string;

  /** Display name */
  displayName: string;

  /** Whether this is an expensive operation */
  isExpensive: boolean;

  /** Dependencies that must be complete before this step */
  requiredBefore: string[];

  /** For collections: items to create */
  items?: string[];
}

/**
 * Artifact Dependency Graph
 */
export class ArtifactGraph {
  private template: VideoTemplate;
  private nodes: Map<string, ArtifactGraphNode> = new Map();
  private creationOrder: string[] = [];

  constructor(template: VideoTemplate) {
    this.template = template;
    this.buildGraph();
  }

  /**
   * Build the dependency graph from the template
   */
  private buildGraph(): void {
    // Create nodes for each artifact type
    for (const [typeId, definition] of Object.entries(this.template.artifactTypes)) {
      const dependsOn = definition.dependencies
        .filter((d: ArtifactDependency) => d.required)
        .map((d: ArtifactDependency) => d.artifactTypeId);

      this.nodes.set(typeId, {
        typeId,
        definition,
        dependsOn,
        dependedBy: [],
        dependencies: definition.dependencies,
        depth: 0,
      });
    }

    // Build reverse dependencies
    for (const node of Array.from(this.nodes.values())) {
      for (const depId of node.dependsOn) {
        const depNode = this.nodes.get(depId);
        if (depNode) {
          depNode.dependedBy.push(node.typeId);
        }
      }
    }

    // Calculate depths
    this.calculateDepths();

    // Calculate creation order
    this.creationOrder = this.topologicalSort();
  }

  /**
   * Calculate the depth of each node in the graph
   */
  private calculateDepths(): void {
    const calculateNodeDepth = (typeId: string, visited: Set<string> = new Set()): number => {
      if (visited.has(typeId)) {
        return 0; // Cycle detected, handled elsewhere
      }

      const node = this.nodes.get(typeId);
      if (!node) return 0;

      if (node.depth > 0) return node.depth;

      visited.add(typeId);

      let maxDepth = 0;
      for (const depId of node.dependsOn) {
        const depDepth = calculateNodeDepth(depId, visited);
        maxDepth = Math.max(maxDepth, depDepth + 1);
      }

      node.depth = maxDepth;
      return maxDepth;
    };

    for (const typeId of Array.from(this.nodes.keys())) {
      calculateNodeDepth(typeId);
    }
  }

  /**
   * Topological sort of artifact types
   */
  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (typeId: string) => {
      if (visited.has(typeId)) return;
      visited.add(typeId);

      const node = this.nodes.get(typeId);
      if (node) {
        for (const depId of node.dependsOn) {
          visit(depId);
        }
      }

      result.push(typeId);
    };

    for (const typeId of Array.from(this.nodes.keys())) {
      visit(typeId);
    }

    return result;
  }

  /**
   * Get a node by type ID
   */
  getNode(typeId: string): ArtifactGraphNode | undefined {
    return this.nodes.get(typeId);
  }

  /**
   * Get all nodes
   */
  getAllNodes(): ArtifactGraphNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get the creation order for all artifact types
   */
  getCreationOrder(): string[] {
    return [...this.creationOrder];
  }

  /**
   * Get direct dependencies of an artifact type
   */
  getDependencies(typeId: string): string[] {
    return this.nodes.get(typeId)?.dependsOn || [];
  }

  /**
   * Get all dependencies (transitive) of an artifact type
   */
  getAllDependencies(typeId: string): string[] {
    const result = new Set<string>();

    const collect = (id: string) => {
      const node = this.nodes.get(id);
      if (!node) return;

      for (const depId of node.dependsOn) {
        if (!result.has(depId)) {
          result.add(depId);
          collect(depId);
        }
      }
    };

    collect(typeId);
    return Array.from(result);
  }

  /**
   * Get direct dependents of an artifact type
   */
  getDependents(typeId: string): string[] {
    return this.nodes.get(typeId)?.dependedBy || [];
  }

  /**
   * Get all dependents (transitive) of an artifact type
   */
  getAllDependents(typeId: string): string[] {
    const result = new Set<string>();

    const collect = (id: string) => {
      const node = this.nodes.get(id);
      if (!node) return;

      for (const depById of node.dependedBy) {
        if (!result.has(depById)) {
          result.add(depById);
          collect(depById);
        }
      }
    };

    collect(typeId);
    return Array.from(result);
  }

  /**
   * Check if an artifact type can be created given current project state
   */
  canCreate(typeId: string, project: GenericProjectFile): CanCreateResult {
    const node = this.nodes.get(typeId);
    if (!node) {
      return {
        canCreate: false,
        missingRequired: [
          {
            typeId,
            displayName: typeId,
            required: true,
            reason: `Unknown artifact type: ${typeId}`,
          },
        ],
        missingOptional: [],
        availableDependencies: [],
      };
    }

    const missingRequired: MissingDependency[] = [];
    const missingOptional: MissingDependency[] = [];
    const availableDependencies: string[] = [];

    for (const dep of node.dependencies) {
      const depNode = this.nodes.get(dep.artifactTypeId);
      if (!depNode) continue;

      const checkResult = this.checkDependencyMet(dep, depNode.definition, project);

      if (checkResult.met) {
        availableDependencies.push(dep.artifactTypeId);
      } else {
        const missingInfo: MissingDependency = {
          typeId: dep.artifactTypeId,
          displayName: depNode.definition.displayName,
          required: dep.required,
          missingItems: checkResult.missingItems,
          reason: checkResult.reason,
        };

        if (dep.required) {
          missingRequired.push(missingInfo);
        } else {
          missingOptional.push(missingInfo);
        }
      }
    }

    return {
      canCreate: missingRequired.length === 0,
      missingRequired,
      missingOptional,
      availableDependencies,
    };
  }

  /**
   * Check if a specific dependency is met
   */
  private checkDependencyMet(
    dep: ArtifactDependency,
    definition: ArtifactTypeDefinition,
    project: GenericProjectFile
  ): { met: boolean; missingItems?: string[]; reason: string } {
    const artifacts = project.artifacts[dep.artifactTypeId];

    // No artifacts of this type exist
    if (!artifacts || Object.keys(artifacts).length === 0) {
      return {
        met: false,
        reason: `No ${definition.displayName.toLowerCase()} artifacts exist`,
      };
    }

    // For singular artifacts, just check if it exists and is approved
    if (!definition.isCollection) {
      const artifactValues = Object.values(artifacts);
      const artifact = artifactValues[0];
      if (!artifact) {
        return {
          met: false,
          reason: `${definition.displayName} has not been created`,
        };
      }
      if (artifact.status !== 'approved') {
        return {
          met: false,
          reason: `${definition.displayName} is not approved (status: ${artifact.status})`,
        };
      }
      return { met: true, reason: '' };
    }

    // For collections, check based on scope
    const scope = dep.scope || 'all';
    const allArtifacts = Object.values(artifacts);
    const approvedArtifacts = allArtifacts.filter((a: ArtifactInstance) => a.status === 'approved');

    switch (scope) {
      case 'all': {
        const allApproved = allArtifacts.every((a: ArtifactInstance) => a.status === 'approved');
        if (!allApproved) {
          const unapproved = allArtifacts
            .filter((a: ArtifactInstance) => a.status !== 'approved')
            .map((a: ArtifactInstance) => a.name);
          return {
            met: false,
            missingItems: unapproved,
            reason: `Not all ${definition.displayName.toLowerCase()} are approved`,
          };
        }
        return { met: true, reason: '' };
      }

      case 'any': {
        if (approvedArtifacts.length === 0) {
          return {
            met: false,
            reason: `At least one approved ${definition.itemName || 'item'} is required`,
          };
        }
        return { met: true, reason: '' };
      }

      case 'matching': {
        // For matching scope, we can't determine here which items are needed
        // This would require context about what's being created
        // For now, we check if any are approved
        if (approvedArtifacts.length === 0) {
          return {
            met: false,
            reason: `No approved ${definition.displayName.toLowerCase()} available`,
          };
        }
        return { met: true, reason: '' };
      }

      default:
        return { met: true, reason: '' };
    }
  }

  /**
   * Calculate ripple effects when an artifact changes
   */
  calculateRippleEffect(
    typeId: string,
    project: GenericProjectFile,
    instanceId?: string
  ): RippleEffect {
    const invalidated: ArtifactImpact[] = [];
    const needsUpdate: ArtifactImpact[] = [];

    const processedTypes = new Set<string>();

    const processType = (
      currentTypeId: string,
      depth: number,
      reason: string,
      impactType: 'invalidated' | 'needs_update'
    ) => {
      if (processedTypes.has(currentTypeId)) return;
      processedTypes.add(currentTypeId);

      const artifacts = project.artifacts[currentTypeId];
      if (!artifacts) return;

      for (const artifact of Object.values(artifacts)) {
        // Skip if this is the source artifact
        if (currentTypeId === typeId && instanceId && artifact.id === instanceId) {
          continue;
        }

        const impact: ArtifactImpact = {
          instanceId: artifact.id,
          typeId: currentTypeId,
          name: artifact.name,
          impactType,
          chainDepth: depth,
          reason,
        };

        if (impactType === 'invalidated') {
          invalidated.push(impact);
        } else {
          needsUpdate.push(impact);
        }
      }

      // Process dependents
      const dependents = this.getDependents(currentTypeId);
      for (const depTypeId of dependents) {
        const depNode = this.nodes.get(depTypeId);
        if (!depNode) continue;

        // Find the dependency relationship
        const dependency = depNode.dependencies.find((d) => d.artifactTypeId === currentTypeId);
        if (!dependency) continue;

        // Determine impact type for dependent
        let newImpactType: 'invalidated' | 'needs_update';
        if (dependency.usage === 'reference' || dependency.usage === 'input') {
          // Visual references and direct inputs cause invalidation
          newImpactType = 'invalidated';
        } else {
          // Context dependencies might just need review
          newImpactType = depth > 1 ? 'needs_update' : 'invalidated';
        }

        const newReason = `Depends on ${this.nodes.get(currentTypeId)?.definition.displayName || currentTypeId}`;
        processType(depTypeId, depth + 1, newReason, newImpactType);
      }
    };

    // Start processing from the changed artifact type
    const startNode = this.nodes.get(typeId);
    const startName = startNode?.definition.displayName || typeId;
    processType(typeId, 0, `${startName} changed`, 'invalidated');

    // Process downstream dependents
    const dependents = this.getDependents(typeId);
    for (const depTypeId of dependents) {
      const depNode = this.nodes.get(depTypeId);
      if (!depNode) continue;

      const dependency = depNode.dependencies.find((d) => d.artifactTypeId === typeId);
      const impactType =
        dependency?.usage === 'reference' || dependency?.usage === 'input'
          ? 'invalidated'
          : 'needs_update';

      processType(depTypeId, 1, `Depends on ${startName}`, impactType);
    }

    return {
      invalidated: invalidated.filter((i) => i.chainDepth > 0), // Exclude source
      needsUpdate,
      totalAffected: invalidated.length + needsUpdate.length,
    };
  }

  /**
   * Generate a creation plan for a target artifact type
   */
  getCreationPlan(
    targetTypeId: string,
    project: GenericProjectFile,
    options: { includeOptional?: boolean } = {}
  ): CreationPlan {
    const steps: CreationStep[] = [];
    const neededTypes = new Set<string>();

    // Find all dependencies that need to be created
    const findNeeded = (typeId: string) => {
      const node = this.nodes.get(typeId);
      if (!node) return;

      for (const dep of node.dependencies) {
        if (!options.includeOptional && !dep.required) continue;

        const checkResult = this.checkDependencyMet(
          dep,
          this.nodes.get(dep.artifactTypeId)!.definition,
          project
        );

        if (!checkResult.met) {
          if (!neededTypes.has(dep.artifactTypeId)) {
            neededTypes.add(dep.artifactTypeId);
            findNeeded(dep.artifactTypeId);
          }
        }
      }
    };

    // Start from target
    neededTypes.add(targetTypeId);
    findNeeded(targetTypeId);

    // Sort by creation order
    const orderedTypes = this.creationOrder.filter((t) => neededTypes.has(t));

    // Build steps
    let stepNum = 1;
    let estimatedCost = 0;

    for (const typeId of orderedTypes) {
      const node = this.nodes.get(typeId);
      if (!node) continue;

      const step: CreationStep = {
        step: stepNum++,
        typeId,
        displayName: node.definition.displayName,
        isExpensive: node.definition.isExpensive,
        requiredBefore: node.dependsOn.filter((d) => neededTypes.has(d)),
      };

      if (node.definition.isExpensive) {
        estimatedCost++;
      }

      steps.push(step);
    }

    return {
      order: orderedTypes,
      steps,
      estimatedCost,
    };
  }

  /**
   * Get artifact types by category
   */
  getTypesByCategory(category: string): ArtifactGraphNode[] {
    return Array.from(this.nodes.values()).filter(
      (node) => node.definition.category === category
    );
  }

  /**
   * Get artifact types by depth (0 = root/no dependencies)
   */
  getTypesByDepth(depth: number): ArtifactGraphNode[] {
    return Array.from(this.nodes.values()).filter((node) => node.depth === depth);
  }

  /**
   * Get the maximum depth in the graph
   */
  getMaxDepth(): number {
    let maxDepth = 0;
    for (const node of Array.from(this.nodes.values())) {
      maxDepth = Math.max(maxDepth, node.depth);
    }
    return maxDepth;
  }

  /**
   * Check if creating one artifact type would allow creating another
   */
  wouldEnable(
    toCreate: string,
    toEnable: string,
    project: GenericProjectFile
  ): boolean {
    const enableNode = this.nodes.get(toEnable);
    if (!enableNode) return false;

    // Check if toCreate is a dependency of toEnable
    if (!enableNode.dependsOn.includes(toCreate)) {
      return false;
    }

    // Simulate having toCreate and check if toEnable can be created
    const simulatedProject = {
      ...project,
      artifacts: {
        ...project.artifacts,
        [toCreate]: {
          [toCreate]: {
            id: 'simulated',
            typeId: toCreate,
            name: 'Simulated',
            status: 'approved' as const,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: 1,
            dependsOn: [],
            dependedBy: [],
            metadata: {},
          },
        },
      },
    };

    const result = this.canCreate(toEnable, simulatedProject);
    return result.canCreate;
  }

  /**
   * Export the graph for visualization
   */
  toVisualizationFormat(): {
    nodes: Array<{ id: string; label: string; depth: number; category: string }>;
    edges: Array<{ from: string; to: string; required: boolean }>;
  } {
    const nodes = Array.from(this.nodes.values()).map((node) => ({
      id: node.typeId,
      label: node.definition.displayName,
      depth: node.depth,
      category: node.definition.category,
    }));

    const edges: Array<{ from: string; to: string; required: boolean }> = [];
    for (const node of Array.from(this.nodes.values())) {
      for (const dep of node.dependencies) {
        edges.push({
          from: dep.artifactTypeId,
          to: node.typeId,
          required: dep.required,
        });
      }
    }

    return { nodes, edges };
  }
}
