# pi-agent ↔ ExecutorAgent bridge: test coverage

The "bridge" is the layer that connects pi-agent's tool dispatch to
`ExecutorAgent`. It has two pieces:

1. **`runExecutor`** (`src/server/runners/runExecutor.ts`) — the
   in-process wrapper that constructs `ExecutorAgent`, wires its
   events to caller callbacks, handles `AbortSignal` cancellation,
   and normalizes results.
2. **pi-agent tools that invoke `runExecutor`** — at the time of
   writing, exactly two: `runTo` and `regen`.

What's tested by the bridge suite:

- `tests/unit/runExecutorBridge.test.ts` — 16 tests against the
  runner itself, with a stub agent injected via the `agentFactory`
  option. Covers event translation, lastSeenNodeId tagging,
  `AbortSignal → agent.stop()`, status mapping
  (`completed`/`cancelled`/`failed`), thrown-while-aborted handling.
- `tests/unit/piAgentBridgeTools.test.ts` — 19 tests against
  `runTo` + `regen`, with `runExecutor` mocked out and project
  fixtures laid down in a temp dir. Covers project resolution,
  validation, alias-classification edge cases (`runTo`),
  invalidation + persistence flow (`regen`), callback translation,
  result-to-response mapping.

Tests that the suite does **not** cover, and why:

## Tools that don't cross the bridge

These tools live in `src/agent/pi/tools/` but never invoke
`runExecutor` — they read project state, write project files, or call
out to host callbacks. Bugs in these tools will not be caught by the
bridge suite. Each should be tested in its own scope (project-state
ops, host integration, etc.).

| Tool file | Tool name | Why not in bridge suite |
|---|---|---|
| `status.ts` | `dhee_status` | Reads `project.json` + calls `computeStatus`. No executor invocation. **Tested in `tests/unit/piAgentReadTools.test.ts`** (read-tool suite). |
| `listItems.ts` | `dhee_list_items` | Reads `project.json` and filters node entries. **Tested in `tests/unit/piAgentReadTools.test.ts`**. |
| `listProjects.ts` | `dhee_list_projects` | Lists folders in `getProjectsDir()`. **Tested in `tests/unit/piAgentReadTools.test.ts`**. |
| `focusProject.ts` | `dhee_focus_project` | Invokes a host-supplied callback (Electron / TUI). Bridge target is the **host**, not ExecutorAgent. **Tested in `tests/unit/focusProjectTool.test.ts`**. |
| `newProject.ts` | `dhee_new` | Creates a project folder + bootstrap `project.json`. **Ported in-process; tested in `tests/unit/createProjectInProcess.test.ts` + `newProjectTool.test.ts`**. |
| `readArtifact.ts` | `dhee_read_artifact` | Reads a file from inside a project dir; rejects path traversal. **Tested in `tests/unit/piAgentReadTools.test.ts`**. |
| `renderSceneBundle.ts` | `dhee_render_scene_bundle` | Placeholder — NOT YET IMPLEMENTED. |
| `reset.ts` | `dhee_reset` | Clears project state from a given stage onwards. Mutates `project.json` in place; no executor invocation. **Ported in-process; tested in `tests/unit/resetProjectStage.test.ts` + `resetTool.test.ts`**. |
| `showAsset.ts` | `dhee_show_first_frame` / etc | Reads manifest entries and emits media events directly. Tested in `tests/unit/showAssetFromSchema.test.ts` + `showAssetTools.test.ts`. |
| `showShot.ts` | `dhee_show_shot` | Same as `showAsset` — manifest-only. Tested in `tests/unit/showShotTool.test.ts`. |
| `auditFidelity.ts` | `dhee_audit_fidelity` | Runs the VLM judge against a project's images. Calls into the calibration/audit pipeline, not the executor bridge. Untested. |

## Tools that are dev-only

| Tool file | Tool name | Why not in bridge suite |
|---|---|---|
| `runScript.ts` | `dhee_run_script` | Shells out to `pnpm exec tsx scripts/*.ts` — only works in dev/repo context, no-ops in the packaged desktop binary. The whole reason `runExecutor` exists is to replace this path; testing the legacy crutch isn't valuable. |

## Pure helpers (no tool surface)

| File | What it is | Why not in bridge suite |
|---|---|---|
| `parseAssetLines.ts` | Pure function used by `runTo` to parse asset event lines. | Has no agent or executor coupling; would be a unit-test target in its own right. |
| `index.ts` | Re-exports / barrel. | No behavior. |

## Out-of-scope for "bridge" testing

Things that are explicitly NOT what the bridge suite is for:

- **The real `ExecutorAgent`'s behavior** — covered in
  `tests/integration/` and other targeted suites. The bridge suite
  uses a stub agent and asserts on the wiring contract.
- **Real LLM / ComfyUI calls** — both are fully replaced via the
  agent stub. End-to-end runs against real providers belong in a
  separate live suite.
- **Pi-agent's LLM-driven tool selection** — i.e. "given user input
  X, does the LLM pick the right tool?" That's a model-quality
  concern, not a bridge concern.
- **Conversation flow above the tool layer** (`PiSessionAgent`,
  `translateEvent`) — this suite stops at the boundary between
  individual tool execution and the layer above. Translating an
  agent's stream of events into UI-bound websocket messages is its
  own contract.

## When to extend the bridge suite

Add a new test to the bridge suite when you:

- **Modify `runExecutor`** — its event wiring, signal handling, or
  result mapping. A new event subscription? Pin it.
- **Add or modify a pi-agent tool that invokes `runExecutor`** — the
  wiring and translation between tool params, runner opts, and
  response details is exactly what we test.
- **Change `RunExecutorOpts` / `RunExecutorAgent` / result shape** —
  these are the contract the bridge enforces.

Do **not** add a test here when:

- You're testing what ExecutorAgent does internally (use planner
  tests).
- You're testing what a tool does that doesn't go through
  `runExecutor` (use a tool-specific unit test).
- You're testing the chat UI's rendering of the tool's output (use
  the dhee-desktop e2e suite — `tests/e2e/` over there).
