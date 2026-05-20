/**
 * Pure invalidation op for `dhee_invalidate`.
 *
 * Given a list of node ids (typically from `selectInvalidationIds`),
 * mutate `project.executorState`:
 *   - Mark each node pending; clear outputPath / promptPath /
 *     completedAt / startedAt / artifactId / error.
 *   - Set `executorState.lastInvalidatedIds` to the list, so
 *     `dhee_run_to scope='last_invalidated'` can read it later.
 *
 * Pure: mutates the passed-in object, no I/O. Caller persists.
 *
 * Mark-pending (not remove-and-rebuild) is the default because
 * invalidate's contract is "regen existing nodes" — the graph
 * topology stays intact. The remove-and-rebuild semantic of the old
 * `dhee_reset` is reachable later via an explicit `clean: true`
 * opt-in if the user changed something upstream that might alter
 * which per-items exist.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { applyInvalidation } from "../../src/core/planner/applyInvalidation.js";
import type { ExecutorState } from "../../src/core/project/projectTypes.js";

interface ProjectFile {
  executorState: ExecutorState;
}

let project: ProjectFile;

beforeEach(() => {
  project = {
    executorState: {
      nodes: {
        "shot_image_prompt:scene_1_shot_1": {
          id: "shot_image_prompt:scene_1_shot_1",
          typeId: "shot_image_prompt",
          itemId: "scene_1_shot_1",
          displayName: "S1 Shot 1 Prompt",
          status: "completed",
          dependencies: [],
          dependents: ["shot_image:scene_1_shot_1"],
          outputPath: "assets/prompts/shot_image_prompt-scene_1_shot_1.json",
          promptPath: "assets/prompts/shot_image_prompt-scene_1_shot_1.txt",
          startedAt: 1000,
          completedAt: 2000,
          artifactId: "art-1",
        },
        "shot_image:scene_1_shot_1": {
          id: "shot_image:scene_1_shot_1",
          typeId: "shot_image",
          itemId: "scene_1_shot_1",
          displayName: "S1 Shot 1 Image",
          status: "completed",
          dependencies: ["shot_image_prompt:scene_1_shot_1"],
          dependents: [],
          outputPath: "assets/images/foo.png",
          startedAt: 1000,
          completedAt: 3000,
        },
      },
    } as never,
  };
});

describe("applyInvalidation", () => {
  it("marks each targeted node as pending and clears its execution metadata", () => {
    applyInvalidation(project, ["shot_image_prompt:scene_1_shot_1"]);
    const n = project.executorState.nodes["shot_image_prompt:scene_1_shot_1"]!;
    expect(n.status).toBe("pending");
    expect(n.outputPath).toBeUndefined();
    expect(n.promptPath).toBeUndefined();
    expect(n.startedAt).toBeUndefined();
    expect(n.completedAt).toBeUndefined();
    expect(n.artifactId).toBeUndefined();
    expect(n.error).toBeUndefined();
  });

  /**
   * Cascade behavior: invalidating an upstream node should also mark
   * every transitive dependent pending. Without this, a surgical
   * "redo this one shot's prompt" leaves the downstream image stuck
   * in `completed` — the next run skips it, and the new prompt never
   * affects the rendered image. Same shape of bug we hit on
   * Baker-and-the-Bee where final_video stayed completed after a
   * shot_video re-run.
   *
   * Older test in this file pinned the OPPOSITE invariant ("does NOT
   * touch nodes outside the invalidation set"). That contract was
   * wrong — invalidate's user-facing semantic is "this node's output
   * is stale", which by transitivity makes its consumers stale too.
   */
  it("cascades pending status to transitive dependents by default", () => {
    applyInvalidation(project, ["shot_image_prompt:scene_1_shot_1"]);
    const downstream = project.executorState.nodes["shot_image:scene_1_shot_1"]!;
    expect(downstream.status).toBe("pending");
    expect(downstream.outputPath).toBeUndefined();
    expect(downstream.completedAt).toBeUndefined();
  });

  it("with cascade:false, leaves downstream nodes alone (opt-out for surgical regen)", () => {
    applyInvalidation(
      project,
      ["shot_image_prompt:scene_1_shot_1"],
      { cascade: false },
    );
    const downstream = project.executorState.nodes["shot_image:scene_1_shot_1"]!;
    expect(downstream.status).toBe("completed");
    expect(downstream.outputPath).toBe("assets/images/foo.png");
    expect(downstream.completedAt).toBe(3000);
  });

  it("persists the invalidated id list (including cascaded dependents) onto executorState.lastInvalidatedIds", () => {
    applyInvalidation(project, ["shot_image_prompt:scene_1_shot_1"]);
    expect(
      ((project.executorState as unknown as { lastInvalidatedIds: string[] })
        .lastInvalidatedIds).sort(),
    ).toEqual(
      [
        "shot_image_prompt:scene_1_shot_1",
        "shot_image:scene_1_shot_1",
      ].sort(),
    );
  });

  it("returns seeds (caller-named) separately from the full invalidated set", () => {
    const result = applyInvalidation(project, [
      "shot_image_prompt:scene_1_shot_1",
    ]);
    expect(result.seeds).toEqual(["shot_image_prompt:scene_1_shot_1"]);
    expect(result.invalidated.sort()).toEqual(
      [
        "shot_image_prompt:scene_1_shot_1",
        "shot_image:scene_1_shot_1",
      ].sort(),
    );
  });

  it("overwrites a previous lastInvalidatedIds (most recent invalidate wins)", () => {
    (project.executorState as unknown as { lastInvalidatedIds: string[] })
      .lastInvalidatedIds = ["earlier:node"];
    applyInvalidation(project, ["shot_image:scene_1_shot_1"]);
    expect(
      (project.executorState as unknown as { lastInvalidatedIds: string[] })
        .lastInvalidatedIds,
    ).toEqual(["shot_image:scene_1_shot_1"]);
  });

  it("silently skips ids that don't exist in the graph (does not throw)", () => {
    expect(() =>
      applyInvalidation(project, ["nonexistent:node"]),
    ).not.toThrow();
    expect(
      (project.executorState as unknown as { lastInvalidatedIds: string[] })
        .lastInvalidatedIds,
    ).toEqual([]);
  });

  it("returns the list of ids that were actually invalidated (skips missing ones)", () => {
    const result = applyInvalidation(project, [
      "shot_image_prompt:scene_1_shot_1",
      "nonexistent:node",
      "shot_image:scene_1_shot_1",
    ]);
    expect(result.invalidated.sort()).toEqual(
      [
        "shot_image_prompt:scene_1_shot_1",
        "shot_image:scene_1_shot_1",
      ].sort(),
    );
    expect(result.notFound).toEqual(["nonexistent:node"]);
  });

  /**
   * Regression: ExecutorAgent's per-frame "incremental retry" check
   * (ExecutorAgent.ts:5537 + 5579) reuses on-disk first_frame /
   * last_frame / mid_frame images when `node.outputPaths[frame]` is
   * still set AND the file exists. If we only clear `outputPath`
   * (the legacy single path) but leave `outputPaths` (the per-frame
   * dict) intact, invalidation looks like it worked but the next
   * run silently reuses the stale frames — exactly what the user
   * saw when only the video regenerated and the upstream image
   * stayed put.
   */
  /**
   * Regression: live failure on Baker-and-the-Bee where regenerating a
   * single shot_video left final_video in `completed` state, so the
   * runner counted it in the 88/88 without re-running ffmpeg and the
   * existing final_video2.mp4 stayed stale (assembled before the new
   * shot was rendered). Cascade should walk shot_video → final_video.
   *
   * Also verifies the dependents-list dedupe path: real project.json
   * files in the wild had final_video listed multiple times in the
   * shot_video's dependents array (we observed 4× on baker), so
   * naïve cascade would visit it repeatedly. We expect each id to
   * appear exactly once in the result.
   */
  it("cascades from a single shot_video to final_video and dedupes duplicate dependent edges", () => {
    type N = ExecutorState["nodes"][string];
    project.executorState.nodes["shot_video:scene_1_shot_1"] = {
      id: "shot_video:scene_1_shot_1",
      typeId: "shot_video",
      itemId: "scene_1_shot_1",
      displayName: "S1 Shot 1 Video",
      status: "completed",
      dependencies: [],
      // Wild-data shape: same id repeated 4× — see Baker-and-the-Bee
      // project.json. Cascade must dedupe so we don't double-mark.
      dependents: ["final_video", "final_video", "final_video", "final_video"],
      outputPath: "assets/videos/shots/s1shot1_ltx23_xxx.mp4",
      completedAt: 5000,
    } as N;
    project.executorState.nodes["final_video"] = {
      id: "final_video",
      typeId: "final_video",
      displayName: "Final Video",
      status: "completed",
      dependencies: ["shot_video:scene_1_shot_1"],
      dependents: [],
      outputPath: "assets/videos/final/final_video2.mp4",
      completedAt: 9000,
    } as N;

    const result = applyInvalidation(project, ["shot_video:scene_1_shot_1"]);

    const fv = project.executorState.nodes["final_video"]!;
    expect(fv.status).toBe("pending");
    expect(fv.outputPath).toBeUndefined();
    expect(fv.completedAt).toBeUndefined();
    // Dedupe: final_video should appear exactly once in the result.
    const occurrences = result.invalidated.filter(id => id === "final_video").length;
    expect(occurrences).toBe(1);
  });

  // ─── Surgical-frame options (mirror DependencyGraphExecutor.invalidateNode) ───
  //
  // The desktop's per-asset regenerate buttons need the on-disk
  // applyInvalidation to support the same shape the in-memory executor
  // supports:
  //   - `preserveFramesOther` + `singleFrame`: drop only the named frame
  //     from `outputPaths`, leaving the others (so the next run reuses
  //     them via ExecutorAgent's incremental-retry path).
  //   - `cascadeOnlyCompleted`: walk dependents but ONLY mark pending
  //     those that are already 'completed'. Pending dependents are left
  //     untouched — they'll pick up the new upstream when they run.
  //
  // These three contracts mirror `ExecutorAgent.redoNode(..., { scope,
  // frame })` so a subprocess-driven surgical regen behaves the same as
  // the in-process redo.

  it("with preserveFramesOther + singleFrame, drops only the named frame and keeps the rest", () => {
    const node = project.executorState.nodes[
      "shot_image:scene_1_shot_1"
    ] as typeof project.executorState.nodes[string] & {
      outputPaths?: Record<string, string>;
    };
    node.outputPaths = {
      first_frame: "assets/images/s1shot1_first_frame.png",
      last_frame: "assets/images/s1shot1_last_frame.png",
      mid_frame: "assets/images/s1shot1_mid_frame.png",
    };

    applyInvalidation(project, ["shot_image:scene_1_shot_1"], {
      cascade: false,
      preserveFramesOther: true,
      singleFrame: "last_frame",
    });

    const cleared = project.executorState.nodes[
      "shot_image:scene_1_shot_1"
    ] as typeof project.executorState.nodes[string] & {
      outputPaths?: Record<string, string>;
    };
    expect(cleared.status).toBe("pending");
    expect(cleared.outputPaths).toEqual({
      first_frame: "assets/images/s1shot1_first_frame.png",
      mid_frame: "assets/images/s1shot1_mid_frame.png",
    });
    // outputPath conventionally mirrors first_frame, so keep it when the
    // dropped frame is NOT first_frame.
    expect(cleared.outputPath).toBe("assets/images/foo.png");
  });

  it("with preserveFramesOther + singleFrame='first_frame', clears outputPath too (it mirrors first_frame)", () => {
    const node = project.executorState.nodes[
      "shot_image:scene_1_shot_1"
    ] as typeof project.executorState.nodes[string] & {
      outputPaths?: Record<string, string>;
    };
    node.outputPaths = {
      first_frame: "assets/images/s1shot1_first_frame.png",
      last_frame: "assets/images/s1shot1_last_frame.png",
    };

    applyInvalidation(project, ["shot_image:scene_1_shot_1"], {
      cascade: false,
      preserveFramesOther: true,
      singleFrame: "first_frame",
    });

    const cleared = project.executorState.nodes[
      "shot_image:scene_1_shot_1"
    ] as typeof project.executorState.nodes[string] & {
      outputPaths?: Record<string, string>;
    };
    expect(cleared.outputPaths).toEqual({
      last_frame: "assets/images/s1shot1_last_frame.png",
    });
    expect(cleared.outputPath).toBeUndefined();
  });

  it("with cascadeOnlyCompleted, leaves already-pending downstream nodes alone", () => {
    type N = ExecutorState["nodes"][string];
    project.executorState.nodes["shot_video:scene_1_shot_1"] = {
      id: "shot_video:scene_1_shot_1",
      typeId: "shot_video",
      itemId: "scene_1_shot_1",
      displayName: "S1 Shot 1 Video",
      status: "pending",
      dependencies: ["shot_image:scene_1_shot_1"],
      dependents: [],
    } as N;
    project.executorState.nodes["shot_image:scene_1_shot_1"]!.dependents = [
      "shot_video:scene_1_shot_1",
    ];

    applyInvalidation(project, ["shot_image:scene_1_shot_1"], {
      cascade: true,
      cascadeOnlyCompleted: true,
    });

    // Already-pending shot_video stays pending; not re-walked through.
    expect(project.executorState.nodes["shot_video:scene_1_shot_1"]!.status).toBe(
      "pending",
    );
  });

  it("with cascadeOnlyCompleted, dirties completed dependents and walks transitively", () => {
    type N = ExecutorState["nodes"][string];
    project.executorState.nodes["shot_video:scene_1_shot_1"] = {
      id: "shot_video:scene_1_shot_1",
      typeId: "shot_video",
      itemId: "scene_1_shot_1",
      displayName: "S1 Shot 1 Video",
      status: "completed",
      dependencies: ["shot_image:scene_1_shot_1"],
      dependents: ["final_video"],
      outputPath: "assets/videos/shots/s1shot1.mp4",
      completedAt: 5000,
    } as N;
    project.executorState.nodes["final_video"] = {
      id: "final_video",
      typeId: "final_video",
      displayName: "Final",
      status: "completed",
      dependencies: ["shot_video:scene_1_shot_1"],
      dependents: [],
      outputPath: "assets/videos/final/final.mp4",
      completedAt: 9000,
    } as N;
    project.executorState.nodes["shot_image:scene_1_shot_1"]!.dependents = [
      "shot_video:scene_1_shot_1",
    ];

    applyInvalidation(project, ["shot_image:scene_1_shot_1"], {
      cascade: true,
      cascadeOnlyCompleted: true,
    });

    expect(project.executorState.nodes["shot_video:scene_1_shot_1"]!.status).toBe(
      "pending",
    );
    expect(project.executorState.nodes["final_video"]!.status).toBe("pending");
  });

  it("clears the per-frame outputPaths dict so the executor's incremental-retry path can't reuse stale frames", () => {
    const node = project.executorState.nodes[
      "shot_image:scene_1_shot_1"
    ] as typeof project.executorState.nodes[string] & {
      outputPaths?: Record<string, string>;
    };
    node.outputPaths = {
      first_frame: "assets/images/s1shot1_first_frame_klein_xxx.png",
      last_frame: "assets/images/s1shot1_last_frame_klein_yyy.png",
    };

    applyInvalidation(project, ["shot_image:scene_1_shot_1"]);

    const cleared = project.executorState.nodes[
      "shot_image:scene_1_shot_1"
    ] as typeof project.executorState.nodes[string] & {
      outputPaths?: Record<string, string>;
    };
    expect(cleared.outputPaths).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────
  // Graph-state edge cases — comprehensive coverage. These tests
  // attack the cascade BFS with malformed / inconsistent graph state
  // to make sure stale dependents arrays, cycles, phantom IDs, and
  // duplicate edges don't break invalidation.
  //
  // Real-world bug that motivated this block: noir_detective_story_setup-3
  // had `scene_shot_plan.dependents` truncated to only include the
  // matching-scope dependent (scene_video_prompt:scene_N) — the
  // shot_breakdown:scene_N_shot_M entries had been silently dropped at
  // some point by an upstream dep-rewire pass. The user invalidated
  // 'plot'; the cascade walked stale dependents and stopped before
  // reaching shot_breakdown / shot_image_prompt / shot_video /
  // final_video. The pipeline appeared to "skip from ref images to
  // complete" because all the downstream shot work stayed in its
  // prior completed state from a week earlier.
  //
  // Fix: applyInvalidation's Phase 0 rebuilds `dependents` from
  // `dependencies` deterministically before the cascade BFS. These
  // tests pin that invariant.
  // ──────────────────────────────────────────────────────────────────

  function makeChainProject(opts: {
    staleDependents?: boolean;
    cycle?: boolean;
    phantomDependent?: boolean;
    duplicateDependents?: boolean;
    missingDependentsField?: boolean;
  } = {}): ProjectFile {
    const aDependents = opts.cycle ? ["B", "C"] : ["B"];
    const bDependents = opts.staleDependents
      ? []
      : opts.duplicateDependents
        ? ["C", "C", "C"]
        : opts.phantomDependent
          ? ["C", "ghost_node_that_does_not_exist"]
          : ["C"];
    const cDependents = opts.cycle ? ["A"] : [];
    const baseNode = (id: string, deps: string[], dependents: string[]) => {
      const node: Record<string, unknown> = {
        id,
        typeId: id === "A" ? "plot" : id === "B" ? "story" : "shot_breakdown",
        displayName: id,
        status: "completed",
        dependencies: deps,
        outputPath: `out/${id}.json`,
        completedAt: 1_000_000_000_000,
        startedAt: 1_000_000_000_000,
      };
      if (!opts.missingDependentsField || id !== "B") {
        node.dependents = dependents;
      }
      return node;
    };
    return {
      executorState: {
        nodes: {
          A: baseNode("A", [], aDependents) as never,
          B: baseNode("B", ["A"], bDependents) as never,
          C: baseNode("C", ["B"], cDependents) as never,
        },
      },
    };
  }

  it("REGRESSION (noir-3): cascade reaches C even when B.dependents is stale (missing C)", () => {
    const proj = makeChainProject({ staleDependents: true });
    const result = applyInvalidation(proj, ["A"]);

    // Without the Phase 0 rebuild, C stays completed because B's
    // stale dependents array doesn't list it.
    expect(result.invalidated.sort()).toEqual(["A", "B", "C"]);
    expect(proj.executorState.nodes["C"]!.status).toBe("pending");
    expect(proj.executorState.nodes["C"]!.outputPath).toBeUndefined();
    expect(proj.executorState.nodes["C"]!.completedAt).toBeUndefined();
  });

  it("INVARIANT: after applyInvalidation, dependents is the deterministic inverse of dependencies", () => {
    // Independent of cascade correctness — this property is what the
    // Phase 0 rebuild establishes. Verify it directly so future
    // regressions get caught even if cascade somehow accidentally
    // "looks right" via other code paths.
    const proj = makeChainProject({ staleDependents: true });
    applyInvalidation(proj, ["A"]);

    const nodes = proj.executorState.nodes;
    for (const id of Object.keys(nodes)) {
      const node = nodes[id]!;
      for (const depId of node.dependencies) {
        const dep = nodes[depId];
        expect(dep).toBeDefined();
        expect(dep!.dependents ?? []).toContain(id);
      }
    }
    // And the converse: every entry in dependents corresponds to a
    // real dependency edge from that node back to this one.
    for (const id of Object.keys(nodes)) {
      const node = nodes[id]!;
      for (const depId of node.dependents ?? []) {
        const dep = nodes[depId];
        expect(dep).toBeDefined();
        expect(dep!.dependencies).toContain(id);
      }
    }
  });

  it("handles a cycle (A→B→C→A) without infinite looping", () => {
    const proj = makeChainProject({ cycle: true });
    const result = applyInvalidation(proj, ["A"]);
    expect(result.invalidated.sort()).toEqual(["A", "B", "C"]);
    expect(proj.executorState.nodes["A"]!.status).toBe("pending");
    expect(proj.executorState.nodes["B"]!.status).toBe("pending");
    expect(proj.executorState.nodes["C"]!.status).toBe("pending");
  });

  it("ignores phantom dependent IDs (entries pointing at non-existent nodes)", () => {
    const proj = makeChainProject({ phantomDependent: true });
    const result = applyInvalidation(proj, ["A"]);
    // Cascade reaches A, B, C — the phantom is silently skipped.
    expect(result.invalidated.sort()).toEqual(["A", "B", "C"]);
    expect(result.notFound).toEqual([]);
  });

  it("dedupes duplicate dependent edges (B.dependents = ['C','C','C'])", () => {
    const proj = makeChainProject({ duplicateDependents: true });
    const result = applyInvalidation(proj, ["A"]);
    // Each node appears exactly once in invalidated.
    expect(result.invalidated.filter(id => id === "C")).toHaveLength(1);
    expect(result.invalidated.sort()).toEqual(["A", "B", "C"]);
  });

  it("handles nodes that lack a dependents field entirely", () => {
    const proj = makeChainProject({ missingDependentsField: true });
    // B has no `dependents` key on its node. The rebuild populates
    // it from C's dependencies — cascade still reaches C.
    const result = applyInvalidation(proj, ["A"]);
    expect(result.invalidated.sort()).toEqual(["A", "B", "C"]);
    // After the rebuild, B.dependents is now an array containing C.
    expect(proj.executorState.nodes["B"]!.dependents).toBeDefined();
    expect(proj.executorState.nodes["B"]!.dependents).toContain("C");
  });

  it("cascade with cascadeOnlyCompleted=true: stops at non-completed dependents", () => {
    // B.status = 'pending' (not completed). With cascadeOnlyCompleted,
    // the cascade skips it and doesn't descend to C.
    const proj: ProjectFile = {
      executorState: {
        nodes: {
          A: {
            id: "A",
            typeId: "plot",
            status: "completed",
            dependencies: [],
            dependents: ["B"],
            outputPath: "out/A.json",
          } as never,
          B: {
            id: "B",
            typeId: "story",
            status: "pending",  // <-- not completed
            dependencies: ["A"],
            dependents: ["C"],
          } as never,
          C: {
            id: "C",
            typeId: "shot_breakdown",
            status: "completed",
            dependencies: ["B"],
            dependents: [],
            outputPath: "out/C.json",
          } as never,
        },
      },
    };
    const result = applyInvalidation(proj, ["A"], { cascadeOnlyCompleted: true });
    // A is seed → pending. B is not completed → cascade skips it.
    // C is not reached because cascade didn't descend through B.
    expect(result.invalidated).toEqual(["A"]);
    expect(proj.executorState.nodes["B"]!.status).toBe("pending"); // unchanged
    expect(proj.executorState.nodes["C"]!.status).toBe("completed"); // unchanged
  });

  it("cascade=false: only seed nodes are invalidated", () => {
    const proj = makeChainProject();
    const result = applyInvalidation(proj, ["A"], { cascade: false });
    expect(result.invalidated).toEqual(["A"]);
    expect(proj.executorState.nodes["A"]!.status).toBe("pending");
    expect(proj.executorState.nodes["B"]!.status).toBe("completed");
    expect(proj.executorState.nodes["C"]!.status).toBe("completed");
  });

  it("multi-seed with overlapping cascades dedupes via shared seen set", () => {
    // Seed both A and B — B is also reachable from A. Should still
    // produce exactly one entry per node in `invalidated`.
    const proj = makeChainProject();
    const result = applyInvalidation(proj, ["A", "B"]);
    const uniqueIds = new Set(result.invalidated);
    expect(uniqueIds.size).toBe(result.invalidated.length);
    expect(result.invalidated.sort()).toEqual(["A", "B", "C"]);
  });

  it("REGRESSION (real noir-3 scenario): plot → 4-deep chain with stale dependents at intermediate node", () => {
    // Reproduces the exact shape of the noir bug: plot → scene →
    // scene_shot_plan → shot_breakdown chain where scene_shot_plan's
    // dependents was truncated (missing shot_breakdown).
    const proj: ProjectFile = {
      executorState: {
        nodes: {
          plot: {
            id: "plot",
            typeId: "plot",
            status: "completed",
            dependencies: [],
            dependents: ["scene:scene_1"],
            outputPath: "plans/plot.md",
            completedAt: 1000,
          } as never,
          "scene:scene_1": {
            id: "scene:scene_1",
            typeId: "scene",
            status: "completed",
            dependencies: ["plot"],
            dependents: ["scene_shot_plan:scene_1"],
            outputPath: "scenes/scene_1.md",
            completedAt: 1000,
          } as never,
          "scene_shot_plan:scene_1": {
            id: "scene_shot_plan:scene_1",
            typeId: "scene_shot_plan",
            status: "completed",
            dependencies: ["scene:scene_1"],
            // STALE — missing shot_breakdown:scene_1_shot_1 (the bug)
            dependents: [],
            outputPath: "plans/scene_1.plan.json",
            completedAt: 1000,
          } as never,
          "shot_breakdown:scene_1_shot_1": {
            id: "shot_breakdown:scene_1_shot_1",
            typeId: "shot_breakdown",
            status: "completed",
            dependencies: ["scene_shot_plan:scene_1"],
            dependents: [],
            outputPath: "shots/1.json",
            completedAt: 1778589351589, // May 12 — the stale render
          } as never,
        },
      },
    };

    const result = applyInvalidation(proj, ["plot"]);

    // ALL four nodes should be invalidated. Without the Phase 0
    // rebuild, the cascade stops at scene_shot_plan because its
    // stale dependents doesn't list shot_breakdown.
    expect(result.invalidated).toContain("shot_breakdown:scene_1_shot_1");
    expect(proj.executorState.nodes["shot_breakdown:scene_1_shot_1"]!.status).toBe("pending");
    expect(proj.executorState.nodes["shot_breakdown:scene_1_shot_1"]!.completedAt).toBeUndefined();
    expect(proj.executorState.nodes["shot_breakdown:scene_1_shot_1"]!.outputPath).toBeUndefined();
  });
});
