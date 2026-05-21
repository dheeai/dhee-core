/**
 * Pure helpers driving the runtime supervisor — the loop that
 * re-engages pi-agent on runner events when oversight is on.
 *
 * Two concerns live here, both pure (no I/O, no global state):
 *   - SupervisorState + shouldFireSupervisor: per-task circuit
 *     breaker. failed/completed events share a hard cap (max 2 per
 *     task.id) so one infinitely-failing pipeline can't starve the
 *     LLM budget. Per-asset events have their own (looser) cap.
 *   - buildSupervisorTask: format a runner event as a `[SYSTEM EVENT]`
 *     message for runTask. The agent's orchestrator prompt teaches
 *     pi to expect this prefix and decide concisely.
 *
 * The wiring (defer-via-setImmediate, runTask call, runner subscription)
 * lives in ConversationManager and is tested separately. This file is
 * the surgical-test slice.
 */
import { describe, it, expect } from "vitest";
import {
  buildSupervisorTask,
  emptySupervisorState,
  recordSupervisorInvocation,
  shouldFireSupervisor,
  type SupervisorState,
} from "../../src/server/conversation/supervisor.js";

describe("supervisor circuit breaker", () => {
  const taskId = "task-x";

  it("fires on the first 'failed' event for a task", () => {
    const state = emptySupervisorState();
    expect(shouldFireSupervisor(state, "failed", taskId)).toBe(true);
  });

  it("fires on the second 'failed' event for the same task", () => {
    let state: SupervisorState = emptySupervisorState();
    state = recordSupervisorInvocation(state, "failed", taskId);
    expect(shouldFireSupervisor(state, "failed", taskId)).toBe(true);
  });

  it("does NOT fire on the third event (failed/completed) for the same task — hard cap of 2", () => {
    let state: SupervisorState = emptySupervisorState();
    state = recordSupervisorInvocation(state, "failed", taskId);
    state = recordSupervisorInvocation(state, "completed", taskId);
    expect(shouldFireSupervisor(state, "failed", taskId)).toBe(false);
    expect(shouldFireSupervisor(state, "completed", taskId)).toBe(false);
  });

  it("resets the cap when the task id changes", () => {
    let state: SupervisorState = emptySupervisorState();
    state = recordSupervisorInvocation(state, "failed", "task-old");
    state = recordSupervisorInvocation(state, "completed", "task-old");
    // Same state, brand-new task id — cap resets.
    expect(shouldFireSupervisor(state, "failed", "task-new")).toBe(true);
  });

  it("per-asset events have a separate, higher cap (50)", () => {
    let state: SupervisorState = emptySupervisorState();
    for (let i = 0; i < 49; i += 1) {
      state = recordSupervisorInvocation(state, "asset", taskId);
    }
    // Still under cap — fires.
    expect(shouldFireSupervisor(state, "asset", taskId)).toBe(true);
    state = recordSupervisorInvocation(state, "asset", taskId);
    // 50th — last allowed by `<` cap, but at the boundary the
    // shouldFire check uses count < 50 so the 51st returns false.
    expect(shouldFireSupervisor(state, "asset", taskId)).toBe(false);
  });

  it("asset count does NOT consume the failed/completed cap (independent counters)", () => {
    let state: SupervisorState = emptySupervisorState();
    for (let i = 0; i < 30; i += 1) {
      state = recordSupervisorInvocation(state, "asset", taskId);
    }
    // failed/completed should still be at full budget.
    expect(shouldFireSupervisor(state, "failed", taskId)).toBe(true);
    state = recordSupervisorInvocation(state, "failed", taskId);
    expect(shouldFireSupervisor(state, "failed", taskId)).toBe(true);
  });
});

describe("buildSupervisorTask", () => {
  it("emits a [SYSTEM EVENT] prefix so pi-agent can recognize it", () => {
    const msg = buildSupervisorTask({
      event: "failed",
      taskId: "task-1",
      taskKind: "run_to",
      projectName: "noir",
      reason: "node X exhausted retries",
    });
    expect(msg.startsWith("[SYSTEM EVENT]")).toBe(true);
  });

  it("includes the failure reason in 'failed' messages", () => {
    const msg = buildSupervisorTask({
      event: "failed",
      taskId: "task-1",
      taskKind: "run_to",
      projectName: "noir",
      reason: "ComfyUI cloud rejected: lora_name not in list",
    });
    expect(msg).toContain("failed");
    expect(msg).toContain("lora_name not in list");
  });

  it("for 'completed' events surfaces task identity but no failure reason", () => {
    const msg = buildSupervisorTask({
      event: "completed",
      taskId: "task-1",
      taskKind: "run_to",
      projectName: "noir",
    });
    expect(msg).toContain("completed");
    expect(msg).toContain("noir");
    expect(msg.toLowerCase()).not.toContain("error");
  });

  it("for 'asset' events with a vlm_description carries the description verbatim", () => {
    const msg = buildSupervisorTask({
      event: "asset",
      taskId: "task-1",
      taskKind: "run_to",
      projectName: "noir",
      assetPath: "assets/images/s1shot1_first_frame.png",
      assetPrompt: "officer at forest edge, dawn light",
      vlmDescription:
        "A police officer in a tactical jacket stands beside a parked SUV at sunset; trees in background.",
    });
    expect(msg).toContain("asset");
    expect(msg).toContain("s1shot1_first_frame.png");
    expect(msg).toContain("dawn light");
    expect(msg).toContain(
      "A police officer in a tactical jacket stands beside a parked SUV at sunset",
    );
  });

  it("for 'asset' events without a vlm_description (VLM off) marks the field absent so pi knows it has no vision feedback", () => {
    const msg = buildSupervisorTask({
      event: "asset",
      taskId: "task-1",
      taskKind: "run_to",
      projectName: "noir",
      assetPath: "assets/images/foo.png",
      assetPrompt: "test prompt",
    });
    expect(msg).toContain("asset");
    expect(msg.toLowerCase()).toMatch(/no vision|vlm.*off|vlm_description.*(none|null|absent)/i);
  });

  it("for 'user_invalidate' events surfaces the seeds + tells pi-agent to re-check before resuming", () => {
    const msg = buildSupervisorTask({
      event: "user_invalidate",
      taskId: "task-1",
      taskKind: "user_invalidate",
      projectName: "noir",
      seeds: [
        "shot_image_prompt:scene_1_shot_2",
        "shot_image_last_frame:scene_1_shot_2",
      ],
      source: "prompts_tab_save",
    });
    expect(msg).toContain("[SYSTEM EVENT]");
    expect(msg).toContain("user_invalidated");
    expect(msg).toContain("shot_image_prompt:scene_1_shot_2");
    expect(msg).toContain("shot_image_last_frame:scene_1_shot_2");
    expect(msg).toContain("prompts_tab_save");
    // The directive: pi-agent must call kshana_status FIRST on the
    // next resume turn — the seeds + dependents are pending now.
    expect(msg.toLowerCase()).toMatch(/kshana_status/);
    // And: do NOT auto-dispatch run_to from this event. The user
    // decides when to resume.
    expect(msg.toLowerCase()).toMatch(/do not auto-dispatch|do not.*run_to|user decides/i);
  });

  it("user_invalidate without a source defaults to 'source: ui' so pi-agent always sees a tag", () => {
    const msg = buildSupervisorTask({
      event: "user_invalidate",
      taskId: "task-1",
      taskKind: "user_invalidate",
      projectName: "noir",
      seeds: ["shot_image:scene_1_shot_2"],
    });
    expect(msg).toContain("source: ui");
  });
});

describe("supervisor circuit breaker — user_invalidate is uncapped", () => {
  it("user_invalidate fires every time regardless of count (it's a user-driven event, not a failure loop)", () => {
    let state = emptySupervisorState();
    for (let i = 0; i < 100; i++) {
      expect(shouldFireSupervisor(state, "user_invalidate", "task-1")).toBe(true);
      state = recordSupervisorInvocation(state, "user_invalidate", "task-1");
    }
  });

  it("user_invalidate does NOT consume the failed/completed cap", () => {
    let state = emptySupervisorState();
    // Burn 50 user_invalidate events.
    for (let i = 0; i < 50; i++) {
      state = recordSupervisorInvocation(state, "user_invalidate", "task-1");
    }
    // failed should still have its full budget of 2.
    expect(shouldFireSupervisor(state, "failed", "task-1")).toBe(true);
    state = recordSupervisorInvocation(state, "failed", "task-1");
    expect(shouldFireSupervisor(state, "failed", "task-1")).toBe(true);
    state = recordSupervisorInvocation(state, "failed", "task-1");
    expect(shouldFireSupervisor(state, "failed", "task-1")).toBe(false);
  });
});
