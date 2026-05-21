/**
 * Tests for DependencyGraphExecutor.resetAbortedNodes() — Bug 16 / Bug 17.
 *
 * Abort-induced failures (user Stop click, desktop process restart, ComfyUI
 * WebSocket teardown by deleteSession) leave nodes in `status='failed'` with
 * error strings like:
 *   - "aborted: agent.stop():user"
 *   - "aborted: agent.stop():shutdown"
 *   - "Shot image: aborted: agent.stop()"
 *
 * On the NEXT run, those should reset to `pending` so the pipeline resumes
 * cleanly. Real failures (LLM errors, JSON parse failures, ComfyUI render
 * failures) must NOT be reset — those are real bugs that need to be seen.
 */
import { describe, it, expect } from 'vitest';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import type { ExecutionNode } from '../../src/core/planner/types.js';
import type { VideoTemplate } from '../../src/core/templates/types.js';

function minimalTemplate(): VideoTemplate {
  return {
    id: 'reset_abort_test',
    displayName: 'Test',
    description: '',
    version: '1.0.0',
    defaultStyle: 'default',
    styles: [{ id: 'default', displayName: 'Default', description: '', promptModifiers: [], negativePrompt: [] }],
    inputTypes: [{ id: 'idea', displayName: 'Idea', description: '', examples: [], skipsArtifacts: [], mapsToArtifact: 'story' }],
    artifactTypes: {
      story: {
        id: 'story', displayName: 'Story', category: 'concept', description: '',
        isCollection: false, outputFormat: 'markdown', filePattern: 'story.md',
        agentType: 'content', promptFile: 'story.md', isExpensive: false,
        requiresPerItemApproval: false, dependencies: [],
      },
    },
    contextVariables: {},
    orchestratorPrompt: 'orchestrator.md',
  };
}

function makeNode(id: string, status: ExecutionNode['status'], error?: string): ExecutionNode {
  return {
    id,
    typeId: 'story',
    status,
    error,
    displayName: id,
    isExpensive: false,
    isCollection: false,
    dependencies: [],
    dependents: [],
  } as ExecutionNode;
}

function buildExecutor(nodes: ExecutionNode[]): DependencyGraphExecutor {
  const record: Record<string, ExecutionNode> = {};
  for (const n of nodes) record[n.id] = n;
  return DependencyGraphExecutor.fromState(
    {
      nodes: record,
      targetArtifacts: ['story'],
      goalDescription: 'test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    minimalTemplate(),
  );
}

describe('resetAbortedNodes — auto-recover from abort-induced failures', () => {
  it('resets a node with error "aborted: agent.stop():user"', () => {
    const exec = buildExecutor([makeNode('a', 'failed', 'aborted: agent.stop():user')]);
    const reset = exec.resetAbortedNodes();
    expect(reset).toEqual(['a']);
    expect(exec.getNode('a')!.status).toBe('pending');
    expect(exec.getNode('a')!.error).toBeUndefined();
  });

  it('resets a node with error "aborted: agent.stop():shutdown"', () => {
    const exec = buildExecutor([makeNode('a', 'failed', 'aborted: agent.stop():shutdown')]);
    const reset = exec.resetAbortedNodes();
    expect(reset).toEqual(['a']);
    expect(exec.getNode('a')!.status).toBe('pending');
  });

  it('resets a node whose error contains "Shot image: aborted: agent.stop()" (wrapped)', () => {
    const exec = buildExecutor([makeNode('a', 'failed', 'Shot image: aborted: agent.stop()')]);
    const reset = exec.resetAbortedNodes();
    expect(reset).toEqual(['a']);
    expect(exec.getNode('a')!.status).toBe('pending');
  });

  it('does NOT reset nodes whose error is a real failure (JSON parse, LLM API error)', () => {
    const exec = buildExecutor([
      makeNode('a', 'failed', 'JSON parse error at line 12'),
      makeNode('b', 'failed', 'OpenAI API: rate_limit_exceeded'),
      makeNode('c', 'failed', 'ComfyUI workflow: node 87 missing input'),
    ]);
    const reset = exec.resetAbortedNodes();
    expect(reset).toEqual([]);
    expect(exec.getNode('a')!.status).toBe('failed');
    expect(exec.getNode('b')!.status).toBe('failed');
    expect(exec.getNode('c')!.status).toBe('failed');
  });

  it('does NOT reset completed or pending nodes', () => {
    const exec = buildExecutor([
      makeNode('a', 'completed'),
      makeNode('b', 'pending'),
    ]);
    const reset = exec.resetAbortedNodes();
    expect(reset).toEqual([]);
    expect(exec.getNode('a')!.status).toBe('completed');
    expect(exec.getNode('b')!.status).toBe('pending');
  });

  it('mixed batch: only abort-failed nodes reset, real failures and completed nodes preserved', () => {
    const exec = buildExecutor([
      makeNode('abort1', 'failed', 'aborted: agent.stop():shutdown'),
      makeNode('real_fail', 'failed', 'OpenAI API: rate_limit_exceeded'),
      makeNode('abort2', 'failed', 'Shot image: aborted: agent.stop()'),
      makeNode('done', 'completed'),
    ]);
    const reset = exec.resetAbortedNodes();
    expect(reset.sort()).toEqual(['abort1', 'abort2']);
    expect(exec.getNode('real_fail')!.status).toBe('failed');
    expect(exec.getNode('done')!.status).toBe('completed');
  });
});
