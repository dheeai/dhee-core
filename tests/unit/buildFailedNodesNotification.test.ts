import { describe, it, expect } from 'vitest';
import { buildFailedNodesNotification } from '../../src/core/planner/buildFailedNodesNotification.js';
import type { ExecutionNode } from '../../src/core/planner/types.js';

function fakeNode(overrides: Partial<ExecutionNode>): ExecutionNode {
  return {
    id: 'plot',
    typeId: 'plot',
    displayName: 'Plot',
    status: 'failed',
    dependencies: [],
    dependents: [],
    ...overrides,
  } as ExecutionNode;
}

describe('buildFailedNodesNotification', () => {
  it('GIVEN a single failed node with an error WHEN building the notification THEN displayName and error appear on their own line and retry instruction is included', () => {
    const node = fakeNode({
      displayName: 'Story Essence',
      error:
        'LLM generate failed (model=Qwen3.5-9B-HighIQ-Heretic): 402 "Credits exhausted"',
    });

    const msg = buildFailedNodesNotification([node], 3);

    expect(msg).toContain('1 node(s) failed after 3 retry attempt(s)');
    expect(msg).toContain('Story Essence');
    expect(msg).toContain('402');
    expect(msg).toContain('Credits exhausted');
    expect(msg).toContain('Send any message to retry.');
  });

  it('GIVEN two failed nodes WHEN building the notification THEN both displayName + error pairs appear on their own lines', () => {
    const a = fakeNode({ id: 'plot', displayName: 'Plot', error: 'plot 402' });
    const b = fakeNode({
      id: 'story',
      typeId: 'story',
      displayName: 'Story',
      error: 'story timeout after 90s',
    });

    const msg = buildFailedNodesNotification([a, b], 3);

    expect(msg).toContain('2 node(s) failed after 3 retry attempt(s)');
    expect(msg).toMatch(/- Plot: plot 402/);
    expect(msg).toMatch(/- Story: story timeout after 90s/);
  });

  it('GIVEN a failed node with no error string WHEN building the notification THEN the displayName still appears (no dangling colon)', () => {
    const node = fakeNode({ displayName: 'Plot', error: undefined });
    const msg = buildFailedNodesNotification([node], 3);
    expect(msg).toContain('Plot');
    expect(msg).not.toMatch(/Plot:\s*$/m);
    expect(msg).not.toMatch(/Plot:\s*\n/);
  });
});
