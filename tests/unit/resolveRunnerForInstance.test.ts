/**
 * resolveRunnerForInstance — TDD coverage for the runner.swapped
 * resolution layer the walker calls on every dispatch.
 *
 * Returns { tool, configOverride? } for the (nodeId, itemId) pair:
 *   - No swap event → bundle default tool.
 *   - Matching swap event → swapped tool + any configOverride.
 *   - Latest swap event wins when multiple exist.
 *
 * Failure modes:
 *  1. Empty event log → fallback tool, no override.
 *  2. Single swap event matching (nodeId, itemId) → swapped tool.
 *  3. Swap event for different itemId → IGNORED for our (nodeId, itemId).
 *  4. Swap event on bare nodeId (no itemId) applies to bare nodeId,
 *     NOT to itemId variants.
 *  5. Swap event for our itemId DOES NOT match a bare query.
 *  6. Multiple swap events for same (nodeId, itemId) → LATEST seq wins.
 *  7. configOverride flows through.
 *  8. Swap event on a different branch is ignored when branchId filter
 *     is given.
 *  9. Swap event for OUR branch picked over swap event for a different
 *     branch.
 * 10. nodeId mismatch never matches.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
import { resolveRunnerForInstance } from '../../src/dag/resolveRunnerForInstance.js';

describe('resolveRunnerForInstance', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'rri-test-'));
    dirs.push(d);
    return d;
  }

  it('1. empty log → fallback tool, no override', () => {
    const dir = tmp();
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
      fallbackTool: 'comfy.image',
    });
    expect(r.tool).toBe('comfy.image');
    expect(r.configOverride).toBeUndefined();
  });

  it('2. swap event matches (nodeId, itemId) → swapped tool', () => {
    const dir = tmp();
    const log = openEventLog(dir);
    log.append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_3',
        fromTool: 'comfy.image',
        toTool: 'comfy.qwen_edit_chain',
        reason: 'klein hand failure',
      },
    });
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
      fallbackTool: 'comfy.image',
    });
    expect(r.tool).toBe('comfy.qwen_edit_chain');
  });

  it('3. swap event for different itemId → ignored', () => {
    const dir = tmp();
    openEventLog(dir).append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_99',
        fromTool: 'comfy.image',
        toTool: 'comfy.qwen_edit_chain',
        reason: 'unrelated',
      },
    });
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
      fallbackTool: 'comfy.image',
    });
    expect(r.tool).toBe('comfy.image');
  });

  it('4. swap event on bare nodeId only applies to bare nodeId', () => {
    const dir = tmp();
    openEventLog(dir).append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: 'plot',
        fromTool: 'llm.generate',
        toTool: 'llm.generate.gpt4',
        reason: 'better quality',
      },
    });
    // Item variant query → fallback (no itemId on the swap event).
    const itemR = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'plot',
      itemId: 'something',
      fallbackTool: 'llm.generate',
    });
    expect(itemR.tool).toBe('llm.generate');
    // Bare query → swapped.
    const bareR = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'plot',
      fallbackTool: 'llm.generate',
    });
    expect(bareR.tool).toBe('llm.generate.gpt4');
  });

  it('5. swap event for our itemId does NOT match a bare-nodeId query', () => {
    const dir = tmp();
    openEventLog(dir).append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_3',
        fromTool: 'comfy.image',
        toTool: 'comfy.qwen_edit_chain',
        reason: 'klein hand failure',
      },
    });
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_image',
      fallbackTool: 'comfy.image',
    });
    expect(r.tool).toBe('comfy.image');
  });

  it('6. multiple swap events for same key → latest seq wins', () => {
    const dir = tmp();
    const log = openEventLog(dir);
    log.append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_3',
        fromTool: 'comfy.image',
        toTool: 'comfy.qwen_edit_chain',
        reason: 'first swap',
      },
    });
    log.append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_3',
        fromTool: 'comfy.qwen_edit_chain',
        toTool: 'comfy.image',
        reason: 'rolled back',
      },
    });
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
      fallbackTool: 'comfy.image',
    });
    expect(r.tool).toBe('comfy.image'); // the rollback won
  });

  it('7. configOverride flows through', () => {
    const dir = tmp();
    openEventLog(dir).append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_3',
        fromTool: 'comfy.image',
        toTool: 'comfy.qwen_edit_chain',
        reason: 'klein hand failure',
        configOverride: { strength: 0.7, seed: 12345 },
      },
    });
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
      fallbackTool: 'comfy.image',
    });
    expect(r.tool).toBe('comfy.qwen_edit_chain');
    expect(r.configOverride).toEqual({ strength: 0.7, seed: 12345 });
  });

  it('8. swap event on different branch is ignored when branchId given', () => {
    const dir = tmp();
    openEventLog(dir).append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'experiment-a',
      payload: {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_3',
        fromTool: 'comfy.image',
        toTool: 'comfy.qwen_edit_chain',
        reason: 'experimental swap',
      },
    });
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
      fallbackTool: 'comfy.image',
      branchId: 'main',
    });
    expect(r.tool).toBe('comfy.image');
  });

  it('9. swap event on requested branch beats one on a different branch', () => {
    const dir = tmp();
    const log = openEventLog(dir);
    log.append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'experiment-a',
      payload: {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_3',
        fromTool: 'comfy.image',
        toTool: 'wrong.tool',
        reason: 'should not be picked',
      },
    });
    log.append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_3',
        fromTool: 'comfy.image',
        toTool: 'right.tool',
        reason: 'should be picked',
      },
    });
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
      fallbackTool: 'comfy.image',
      branchId: 'main',
    });
    expect(r.tool).toBe('right.tool');
  });

  it('10. nodeId mismatch never matches', () => {
    const dir = tmp();
    openEventLog(dir).append({
      kind: 'runner.swapped',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: 'character_image',
        itemId: 'lara_croft',
        fromTool: 'comfy.image',
        toTool: 'comfy.qwen_edit_chain',
        reason: 'unrelated',
      },
    });
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'lara_croft',
      fallbackTool: 'comfy.image',
    });
    expect(r.tool).toBe('comfy.image');
  });

  it('11. node-scope swap applies to every item, but instance-scope wins for the exact item', () => {
    const dir = tmp();
    const log = openEventLog(dir);
    log.append({
      kind: 'runner.swapped',
      actor: 'user',
      branchId: 'main',
      payload: {
        nodeId: 'shot_video',
        itemId: 'scene_1_shot_2',
        scope: 'instance',
        fromTool: 'openrouter.video',
        toTool: 'comfy.fl2v',
        reason: 'fix one shot',
      },
    });
    log.append({
      kind: 'runner.swapped',
      actor: 'user',
      branchId: 'main',
      payload: {
        nodeId: 'shot_video',
        scope: 'node',
        fromTool: 'openrouter.video',
        toTool: 'dhee.cloud.video',
        reason: 'new default',
      },
    });

    const exact = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_video',
      itemId: 'scene_1_shot_2',
      fallbackTool: 'openrouter.video',
    });
    const sibling = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_video',
      itemId: 'scene_1_shot_3',
      fallbackTool: 'openrouter.video',
    });

    expect(exact.tool).toBe('comfy.fl2v');
    expect(exact.scope).toBe('instance');
    expect(sibling.tool).toBe('dhee.cloud.video');
    expect(sibling.scope).toBe('node');
  });

  it('12. generatedConfigOverride merges before user configOverride', () => {
    const dir = tmp();
    openEventLog(dir).append({
      kind: 'runner.swapped',
      actor: 'user',
      branchId: 'main',
      payload: {
        nodeId: 'shot_video',
        scope: 'node',
        fromTool: 'openrouter.video',
        toTool: 'dhee.cloud.video',
        reason: 'new default',
        generatedConfigOverride: { promptInput: 'generated_prompt', seed: 1 },
        configOverride: { seed: 99 },
      },
    });
    const r = resolveRunnerForInstance({
      projectDir: dir,
      nodeId: 'shot_video',
      itemId: 'scene_1_shot_2',
      fallbackTool: 'openrouter.video',
    });
    expect(r.configOverride).toEqual({ promptInput: 'generated_prompt', seed: 99 });
  });
});
