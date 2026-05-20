/**
 * Pure selection function for the unified `dhee_invalidate` op.
 *
 * Given a project's executor state and a selection mode (one of
 * `node`, `type`, or `stage`), returns the set of node ids that
 * should be invalidated. Three modes converge into one whitelist —
 * the same whitelist later picked up by `dhee_run_to scope=
 * 'last_invalidated'` so the user can choose between "continue from
 * here" (no whitelist) and "run only what I just invalidated" (this
 * whitelist).
 *
 * The selector is pure — no I/O, no mutation. Tests exercise it
 * against in-memory `ExecutorState` fixtures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { selectInvalidationIds } from "../../src/core/planner/selectInvalidationIds.js";
import type { ExecutorState } from "../../src/core/project/projectTypes.js";

function node(id: string, typeId: string, itemId?: string): ExecutorState["nodes"][string] {
  return {
    id,
    typeId,
    displayName: id,
    status: "completed",
    dependencies: [],
    dependents: [],
    ...(itemId !== undefined ? { itemId } : {}),
  } as never;
}

let state: ExecutorState;

beforeEach(() => {
  state = {
    nodes: {
      // Type-level / collection nodes (no `:itemId`)
      shot_image_prompt: node("shot_image_prompt", "shot_image_prompt"),
      shot_image: node("shot_image", "shot_image"),
      shot_video: node("shot_video", "shot_video"),
      // Per-item nodes (with itemId)
      "shot_image_prompt:scene_1_shot_1": node("shot_image_prompt:scene_1_shot_1", "shot_image_prompt", "scene_1_shot_1"),
      "shot_image_prompt:scene_1_shot_2": node("shot_image_prompt:scene_1_shot_2", "shot_image_prompt", "scene_1_shot_2"),
      "shot_image_prompt:scene_2_shot_1": node("shot_image_prompt:scene_2_shot_1", "shot_image_prompt", "scene_2_shot_1"),
      "shot_image:scene_1_shot_1": node("shot_image:scene_1_shot_1", "shot_image", "scene_1_shot_1"),
      "shot_image:scene_1_shot_2": node("shot_image:scene_1_shot_2", "shot_image", "scene_1_shot_2"),
      "shot_video:scene_1_shot_1": node("shot_video:scene_1_shot_1", "shot_video", "scene_1_shot_1"),
    },
  } as never;
});

describe("selectInvalidationIds — node mode", () => {
  it("returns the verbatim id when given a fully-qualified node id", () => {
    expect(
      selectInvalidationIds(state, { node: "shot_image_prompt:scene_1_shot_2" }),
    ).toEqual(["shot_image_prompt:scene_1_shot_2"]);
  });

  it("resolves a friendly alias (e.g. 'scene_1_shot_2.prompt') to the per-item node id", () => {
    expect(selectInvalidationIds(state, { node: "scene_1_shot_2.prompt" })).toEqual([
      "shot_image_prompt:scene_1_shot_2",
    ]);
  });

  it("returns an empty array when the node does not exist", () => {
    expect(selectInvalidationIds(state, { node: "nonexistent_node" })).toEqual([]);
  });
});

describe("selectInvalidationIds — type mode", () => {
  it("returns every per-item node of the given type, plus the type-level collection node if present", () => {
    const ids = selectInvalidationIds(state, { type: "shot_image_prompt" });
    expect(ids.sort()).toEqual(
      [
        "shot_image_prompt",
        "shot_image_prompt:scene_1_shot_1",
        "shot_image_prompt:scene_1_shot_2",
        "shot_image_prompt:scene_2_shot_1",
      ].sort(),
    );
  });

  it("does not include nodes of other types (no false positives via name overlap)", () => {
    const ids = selectInvalidationIds(state, { type: "shot_image" });
    expect(ids).not.toContain("shot_image_prompt");
    expect(ids).not.toContain("shot_image_prompt:scene_1_shot_1");
    // Should include the type-level shot_image and per-item shot_image:* nodes
    expect(ids.sort()).toEqual(
      [
        "shot_image",
        "shot_image:scene_1_shot_1",
        "shot_image:scene_1_shot_2",
      ].sort(),
    );
  });

  it("returns an empty array for an unknown type", () => {
    expect(selectInvalidationIds(state, { type: "no_such_type" })).toEqual([]);
  });
});

describe("selectInvalidationIds — stage mode", () => {
  it("returns the stage's type cone (start type + every downstream type via TEMPLATE_DEPS)", () => {
    // stage='shot_image_prompt' should include shot_image_prompt + everything
    // downstream by type — shot_image, shot_video, etc. All per-item nodes
    // of those types (across all scenes/shots) plus their type-level
    // collections.
    const ids = selectInvalidationIds(state, { stage: "shot_image_prompt" });
    // Every shot_image_prompt:* and shot_image:* and shot_video:* in the
    // fixture must appear, plus the three type-level collection nodes.
    expect(ids).toContain("shot_image_prompt");
    expect(ids).toContain("shot_image_prompt:scene_1_shot_1");
    expect(ids).toContain("shot_image_prompt:scene_2_shot_1");
    expect(ids).toContain("shot_image");
    expect(ids).toContain("shot_image:scene_1_shot_2");
    expect(ids).toContain("shot_video");
    expect(ids).toContain("shot_video:scene_1_shot_1");
  });

  it("for a leaf stage with no downstream (e.g. shot_video), returns just that type", () => {
    const ids = selectInvalidationIds(state, { stage: "shot_video" });
    // shot_video has only final_video downstream; no final_video in fixture.
    // Result: only shot_video type-level + per-items.
    expect(ids.sort()).toEqual(
      ["shot_video", "shot_video:scene_1_shot_1"].sort(),
    );
  });

  it("throws for an unknown stage (mirrors dhee_reset's error contract)", () => {
    expect(() =>
      selectInvalidationIds(state, { stage: "no_such_stage" as never }),
    ).toThrow(/unknown stage/i);
  });
});

describe("selectInvalidationIds — input validation", () => {
  it("requires exactly one of node | type | stage", () => {
    expect(() => selectInvalidationIds(state, {} as never)).toThrow(
      /exactly one/i,
    );
    expect(() =>
      selectInvalidationIds(state, { node: "x", type: "y" } as never),
    ).toThrow(/exactly one/i);
  });
});
