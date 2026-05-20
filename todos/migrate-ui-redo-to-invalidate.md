# TODO: Migrate UI "Redo this shot" button onto `dhee_invalidate`

## Background

The unified `dhee_invalidate` + `dhee_run_to scope='last_invalidated'`
pair (commits `f00c7bc` + `f1c0f8e`) collapsed pi-agent's `dhee_regen`
and `dhee_reset` into one operation. The LLM-driven path is migrated
and the dead-code source is deleted.

The UI's "Redo this shot" button still goes through the pre-refactor
`cm.redoNode` chain:

```
UI button click
  → IPC channel REDO_NODE
  → dheeCoreManager.redoNode(sessionId, nodeId, opts)
  → ConversationManager.redoNode(...)
  → either:
      (a) agent.redoNode() + runTask('')   ← legacy live-ExecutorAgent path
      (b) runRegenSubprocess(...)          ← spawn scripts/regen-node.ts
```

Both branches predate the BackgroundTaskRunner. (b) literally spawns a
child Node process that re-imports dhee-core via tsx. (a) is dead
code in the Pi era — `PiSessionAgent` has no `redoNode` method, so
the `'redoNode' in session.agent` check always falls through to (b).

## Why parked, not done

While reading the chain I noticed a likely-existing bug in the IPC
plumbing — `dheeCoreManager.redoNode` passes a single options object
as the **third positional argument** of `cm.redoNode`, but
`cm.redoNode`'s declared signature is positional
(`events?, editedPrompt?, frame?, scope?`). The cast at the call site
papers over it with `as unknown as { ... }`. That suggests the button
may not be working as intended today either.

Bundling that fix with the regen→invalidate migration would have
muddled the diff and risked masking either issue. Splitting it out.

## What needs to happen

1. **Refactor `cm.redoNode` to a single-options-object signature.** Match
   the calling convention `dheeCoreManager.redoNode` already assumes:
   ```ts
   redoNode(sessionId: string, nodeId: string, opts: {
     events?: ConversationEvents;
     editedPrompt?: Record<string, unknown>;
     frame?: 'first_frame' | 'mid_frame' | 'last_frame';
     scope?: 'prompt' | 'image_only';
   }): Promise<{ ok: boolean; ... }>
   ```

2. **Reimplement on top of the unified path.**
   - If `editedPrompt` was supplied: `saveEditedPrompt(...)` first
     (preserved from existing behavior).
   - Compute the invalidation set:
     - `scope: 'prompt'` → invalidate the prompt node + its image node
       (`shot_image_prompt:X` + `shot_image:X`)
     - `scope: 'image_only'` → invalidate just the image node, with the
       frame surgery `agent.redoNode` already supports
     - default (no scope) → invalidate the targeted node, optionally
       cascade to dependents
   - Call `applyInvalidation(project, ids)` — same helper the LLM path
     uses. Persists `lastInvalidatedIds`.
   - Dispatch `kind: 'run_to'` on the BackgroundTaskRunner with
     `params: { scope: 'last_invalidated', sessionId }` so the run
     executes detached and progress streams back to the UI through
     ConversationManager's runner subscription. Chat stays
     interactive — same UX win the LLM path got.

3. **Preserve the frame-level / image-only / prompt scope semantics**
   that `executor.invalidateNode`'s graph-aware path provides. The new
   `applyInvalidation` is coarser today (no per-frame `outputPaths`
   surgery). Two ways to bridge:
   - Extend `applyInvalidation` to accept the same scope/frame opts
     and call into the right granularity.
   - Or, when scope is set, route through `invalidateNode`'s in-memory
     path against a transient `DependencyGraphExecutor` reconstructed
     from `project.executorState.nodes` (avoids duplicating the logic).
   The first option keeps the disk-mutation path uniform.

4. **Delete `runRegenSubprocess` and `scripts/regen-node.ts`** once
   `cm.redoNode` no longer references them. The HTTP `/regen` route
   and `pnpm regen` CLI keep `regenNodes`. The `pnpm reset` CLI keeps
   `resetProjectStage`.

5. **Update the desktop wrapper** (`dheeCoreManager.redoNode` in
   dhee-desktop) to match the new signature — drops the cast hack.

6. **Tests**: pin the redo-from-button path against the new chain.
   - Click Redo → IPC → cm.redoNode → applyInvalidation persists
     `lastInvalidatedIds` → runner dispatched with `scope='last_invalidated'`
     → executor's `redoOnlyNodes` is set to that whitelist.
   - frame=`last_frame` invalidates the per-frame entry without
     touching the first frame (preserve the current behavior).
   - editedPrompt path: file written before invalidation; prompt
     node NOT invalidated (so the LLM doesn't overwrite the user's
     edits); only the image node is.

## Out of scope here, in scope for the parent feature

- Type-level redo from the UI ("redo all shot prompts" button). The
  primitive (`dhee_invalidate type=...`) exists; just no button yet.
- A "run only invalidated" affordance next to the timeline's Run
  button so the user can choose between "continue from here" and
  "run only what I just redid" — currently only the LLM can
  pick this scope.

## Acceptance

- Clicking Redo doesn't lock the chat for the duration of the redo.
- The redo path runs the `applyInvalidation` + runner-dispatch chain,
  not the `agent.redoNode` + `runTask('')` chain or the
  `runRegenSubprocess` child process.
- `runRegenSubprocess` and `scripts/regen-node.ts` deleted.
- Existing redo behavior (frame-level, prompt-edit, image_only)
  preserved end-to-end.
