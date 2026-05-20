/**
 * State Assertions
 *
 * Fluent API for verifying agent state transitions.
 * Provides Given-When-Then style assertions for test scenarios.
 */

import type { Message, ToolCall } from '../../src/core/llm/types.js';
import type { GenericProjectFile } from '../../src/core/templates/types.js';
import type { ContextStore } from '../../src/core/context/ContextStore.js';

export interface ToolCallExpectation {
  name: string;
  arguments?: Record<string, unknown>;
  containsArguments?: Partial<Record<string, unknown>>;
}

export interface ContextExpectation {
  variableName: string;
  label?: string;
  source?: 'user_input' | 'tool' | 'manual';
  contentContains?: string;
}

export interface StateSnapshot {
  /** Agent status */
  status?: 'waiting_for_user' | 'completed' | 'running' | 'interrupted';
  /** Current phase */
  phase?: string;
  /** Message history */
  messages?: Message[];
  /** Tool calls made */
  toolCalls?: ToolCall[];
  /** Context store entries */
  contexts?: Array<{ variableName: string; label: string; content: string }>;
  /** Project file state */
  project?: GenericProjectFile | null;
}

/**
 * Fluent assertion builder for state verification.
 */
export class StateAssertions {
  private actual: StateSnapshot;
  private contextStore?: ContextStore;
  private expectations: Array<{ check: () => boolean; message: string }> = [];

  constructor(actual: StateSnapshot, contextStore?: ContextStore) {
    this.actual = actual;
    this.contextStore = contextStore;
  }

  /**
   * Assert the agent status.
   */
  expectStatus(status: 'waiting_for_user' | 'completed' | 'running' | 'interrupted'): this {
    this.expectations.push({
      check: () => this.actual.status === status,
      message: `Expected status "${status}", got "${this.actual.status}"`,
    });
    return this;
  }

  /**
   * Assert the current phase.
   */
  expectPhase(phase: string): this {
    this.expectations.push({
      check: () => this.actual.phase === phase,
      message: `Expected phase "${phase}", got "${this.actual.phase}"`,
    });
    return this;
  }

  /**
   * Assert a specific tool was called.
   */
  expectToolCalled(toolName: string, args?: Record<string, unknown>): this {
    this.expectations.push({
      check: () => {
        const calls = this.actual.toolCalls || [];
        const matchingCall = calls.find(tc => tc.name === toolName);

        if (!matchingCall) {
          return false;
        }

        if (args) {
          return JSON.stringify(matchingCall.arguments) === JSON.stringify(args);
        }

        return true;
      },
      message: args
        ? `Expected tool "${toolName}" with args ${JSON.stringify(args)} to be called`
        : `Expected tool "${toolName}" to be called`,
    });
    return this;
  }

  /**
   * Assert a tool was called with partial argument matching.
   */
  expectToolCalledWith(toolName: string, partialArgs: Partial<Record<string, unknown>>): this {
    this.expectations.push({
      check: () => {
        const calls = this.actual.toolCalls || [];
        const matchingCall = calls.find(tc => tc.name === toolName);

        if (!matchingCall) {
          return false;
        }

        // Check if all partial args are present and match
        for (const [key, value] of Object.entries(partialArgs)) {
          if (matchingCall.arguments[key] !== value) {
            return false;
          }
        }

        return true;
      },
      message: `Expected tool "${toolName}" with args containing ${JSON.stringify(partialArgs)}`,
    });
    return this;
  }

  /**
   * Assert a specific number of tool calls were made.
   */
  expectToolCallCount(count: number): this {
    this.expectations.push({
      check: () => (this.actual.toolCalls?.length || 0) === count,
      message: `Expected ${count} tool calls, got ${this.actual.toolCalls?.length || 0}`,
    });
    return this;
  }

  /**
   * Assert a context was stored.
   */
  expectContextStored(expectation: ContextExpectation): this {
    this.expectations.push({
      check: () => {
        const contexts = this.actual.contexts || [];
        const match = contexts.find(
          c =>
            c.variableName === expectation.variableName &&
            (!expectation.label || c.label === expectation.label)
        );

        if (!match) {
          return false;
        }

        if (expectation.contentContains) {
          return match.content.includes(expectation.contentContains);
        }

        return true;
      },
      message: expectation.label
        ? `Expected context "${expectation.variableName}" with label "${expectation.label}"`
        : `Expected context "${expectation.variableName}"`,
    });
    return this;
  }

  /**
   * Assert multiple contexts were stored.
   */
  expectContextsStored(count: number): this {
    this.expectations.push({
      check: () => (this.actual.contexts?.length || 0) >= count,
      message: `Expected at least ${count} contexts, got ${this.actual.contexts?.length || 0}`,
    });
    return this;
  }

  /**
   * Assert message count increased by a specific amount.
   */
  expectMessageCount(count: number): this {
    this.expectations.push({
      check: () => (this.actual.messages?.length || 0) === count,
      message: `Expected ${count} messages, got ${this.actual.messages?.length || 0}`,
    });
    return this;
  }

  /**
   * Assert last message contains specific text.
   */
  expectLastMessageContains(text: string): this {
    this.expectations.push({
      check: () => {
        const messages = this.actual.messages || [];
        const lastMessage = messages[messages.length - 1];
        return lastMessage?.content?.includes(text) ?? false;
      },
      message: `Expected last message to contain "${text}"`,
    });
    return this;
  }

  /**
   * Assert project phase status.
   */
  expectProjectPhaseStatus(phaseId: string, status: 'pending' | 'in_progress' | 'completed' | 'skipped'): this {
    this.expectations.push({
      check: () => {
        const project = this.actual.project;
        if (!project?.phases) {
          return false;
        }
        const phaseInfo = project.phases[phaseId];
        return phaseInfo?.status === status;
      },
      message: `Expected project phase "${phaseId}" to have status "${status}"`,
    });
    return this;
  }

  /**
   * Assert project has artifacts of a specific type.
   */
  expectProjectArtifacts(typeId: string, count?: number): this {
    this.expectations.push({
      check: () => {
        const project = this.actual.project;
        if (!project?.artifacts) {
          return false;
        }
        const artifacts = project.artifacts[typeId];
        if (!artifacts) {
          return false;
        }
        if (count !== undefined) {
          return Object.keys(artifacts).length === count;
        }
        return true;
      },
      message: count
        ? `Expected ${count} artifacts of type "${typeId}"`
        : `Expected artifacts of type "${typeId}"`,
    });
    return this;
  }

  /**
   * Assert a specific artifact exists.
   */
  expectArtifactExists(typeId: string, instanceId: string): this {
    this.expectations.push({
      check: () => {
        const project = this.actual.project;
        if (!project?.artifacts) {
          return false;
        }
        const artifacts = project.artifacts[typeId];
        return artifacts?.[instanceId] !== undefined;
      },
      message: `Expected artifact "${instanceId}" of type "${typeId}" to exist`,
    });
    return this;
  }

  /**
   * Assert artifact approval status.
   */
  expectArtifactStatus(
    typeId: string,
    instanceId: string,
    status: 'pending' | 'in_review' | 'approved' | 'rejected'
  ): this {
    this.expectations.push({
      check: () => {
        const project = this.actual.project;
        if (!project?.artifacts) {
          return false;
        }
        const artifacts = project.artifacts[typeId];
        return artifacts?.[instanceId]?.status === status;
      },
      message: `Expected artifact "${instanceId}" to have status "${status}"`,
    });
    return this;
  }

  /**
   * Assert project current phase.
   */
  expectProjectCurrentPhase(phaseId: string): this {
    this.expectations.push({
      check: () => this.actual.project?.currentPhase === phaseId,
      message: `Expected project current phase to be "${phaseId}", got "${this.actual.project?.currentPhase}"`,
    });
    return this;
  }

  /**
   * Assert a file exists in the project.
   */
  expectFileExists(relativePath: string): this {
    this.expectations.push({
      check: () => {
        const { existsSync } = require('node:fs');
        const { join } = require('node:path');
        const fullPath = join(process.cwd(), '.dhee', relativePath);
        return existsSync(fullPath);
      },
      message: `Expected file to exist: ${relativePath}`,
    });
    return this;
  }

  /**
   * Assert a file contains specific content.
   */
  expectFileContains(relativePath: string, content: string): this {
    this.expectations.push({
      check: () => {
        const { readFileSync, existsSync } = require('node:fs');
        const { join } = require('node:path');
        const fullPath = join(process.cwd(), '.dhee', relativePath);

        if (!existsSync(fullPath)) {
          return false;
        }

        const fileContent = readFileSync(fullPath, 'utf-8');
        return fileContent.includes(content);
      },
      message: `Expected file "${relativePath}" to contain "${content}"`,
    });
    return this;
  }

  /**
   * Run all assertions and throw if any fail.
   */
  verify(): void {
    const failures: string[] = [];

    for (const expectation of this.expectations) {
      if (!expectation.check()) {
        failures.push(expectation.message);
      }
    }

    if (failures.length > 0) {
      const error = new Error(
        `State assertion failures:\n${failures.map(f => `  - ${f}`).join('\n')}`
      );
      (error as any).failures = failures;
      throw error;
    }
  }

  /**
   * Run all assertions and return result without throwing.
   */
  check(): { success: boolean; failures: string[] } {
    const failures: string[] = [];

    for (const expectation of this.expectations) {
      if (!expectation.check()) {
        failures.push(expectation.message);
      }
    }

    return {
      success: failures.length === 0,
      failures,
    };
  }

  /**
   * Get a diff-style summary of expected vs actual state.
   */
  getSummary(): string {
    const lines: string[] = ['State Assertion Summary:', ''];

    if (this.actual.status) {
      lines.push(`  Status: ${this.actual.status}`);
    }
    if (this.actual.phase) {
      lines.push(`  Phase: ${this.actual.phase}`);
    }
    if (this.actual.messages) {
      lines.push(`  Messages: ${this.actual.messages.length}`);
    }
    if (this.actual.toolCalls) {
      lines.push(`  Tool Calls: ${this.actual.toolCalls.length}`);
      for (const tc of this.actual.toolCalls) {
        lines.push(`    - ${tc.name}(${JSON.stringify(tc.arguments)})`);
      }
    }
    if (this.actual.contexts) {
      lines.push(`  Contexts: ${this.actual.contexts.length}`);
      for (const ctx of this.actual.contexts) {
        lines.push(`    - ${ctx.variableName} (${ctx.label})`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Create a StateAssertions instance.
 */
export function then(state: StateSnapshot, contextStore?: ContextStore): StateAssertions {
  return new StateAssertions(state, contextStore);
}

/**
 * Alias for `then` for Given-When-Then style tests.
 */
export function expectState(state: StateSnapshot, contextStore?: ContextStore): StateAssertions {
  return new StateAssertions(state, contextStore);
}
