# Project-less agent session for global tasks

**Status:** todo (deferred from `feat/comfyui-workflow-integration`)

## Context

The custom-workflow integration ships with the agent driving install/edit/delete via chat. The chat itself is project-scoped — every `ConversationManager` session today gets a project pinned via `configureSessionForProject` before tasks dispatch. That works for project-shaped tasks (generate this scene, regenerate that shot) but breaks down for **global** tasks the user might want to do *without* an open project. The first one we hit:

> User opens **Settings → Workflows**, wants to add a new ComfyUI workflow. Chat is the canonical install path (the agent drives validation, LLM analysis, variable mapping, save). But there's no chat surface in Settings, and no way to spin one up — sessions need a project.

The shipped v1 fix is option **(A)**: drop the "+ Add Workflow" button entirely, replace with text directing the user to "open any project, click 📎 in chat, attach the workflow JSON." That works but is a friction point. Users with no projects yet (fresh install) have to create one before they can install a workflow.

## What we want

A **project-less agent session** that exists for global tasks like workflow management, settings questions, "what can this app do," etc. The session is scoped to a narrower toolkit (no `dhee_run_to`, no scene/shot tools — those need a project) and a different skill set (`comfyui-workflow-integration`, eventually `app-help`, `account-management`, etc).

Concretely:

- **dhee-core**: a new session role `'global'` (alongside existing `'interactive' | 'background'`). When created, the session has no `projectDir` and stays that way; project-required tools are filtered out at registration time.
- **Skill loader**: load only the skills that don't depend on project state — `comfyui-workflow-integration` is the obvious first one.
- **Tool registration**: filter `dheeTools` to a subset whose `execute` doesn't depend on `projectDir` resolution. Or: tools that need a project assert and fail-soft with "this needs a project open."
- **dhee-desktop**: a small modal-or-drawer chat UI that mounts inside the Settings → Workflows tab when "+ Add Workflow" is clicked. Spawns a `'global'` session, runs the conversation, closes when the user is done. Uses the same `usedheeSession` hook + `MessageList` + `ChatInput` components, just with a different session role.
- **Restoring the button**: once the global session lands, put "+ Add Workflow" back, wire it to open the modal.

## Out of scope (do not bundle)

- A persistent "global chat" panel beyond the workflow flow. The modal is task-scoped — opens, finishes, closes. A persistent global chat is a separate feature with its own UX questions (where does it live in the layout? what does it persist between?).
- Fuller filesystem isolation. The global session can still read manifests from the workflows dir; the only thing missing is `projectDir`. No need to add a separate sandbox.

## Why this isn't urgent

- The "+ Add Workflow" pain only hits users who think to look in Settings first instead of in chat. Most users will discover the 📎 button in chat naturally.
- Custom workflows are an advanced-user feature; advanced users tolerate one extra step.
- The fix touches dhee-core's session lifecycle, which is load-bearing — better as a focused PR than tucked into the workflow PR.

## Effort

~1.5–2 days:
- 0.5d: dhee-core `'global'` role + tool filter + skill filter + tests
- 0.5d: dhee-desktop modal chat component (small reuse of existing chat components)
- 0.5d: wire up + e2e + put the button back
- 0.25d: docs
