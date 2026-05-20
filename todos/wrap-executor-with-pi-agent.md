# Wrap ExecutorAgent in pi-coding-agent (control plane via npm dep)

## Status: HIGH PRIORITY — direction confirmed, pi evaluation done

## What this is

Concrete implementation of the parked
[wrap-executor-in-generic-agent.md](./wrap-executor-in-generic-agent.md)
TODO. Instead of writing our own GenericAgent control plane from scratch,
adopt [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
as the control plane and consume its SDK as a dependency.

## Why pi

Pi is a minimal terminal coding harness with an explicit SDK contract for
embedding. Evaluation done 2026-04-27:

- `npm install @mariozechner/pi-coding-agent` (or `@mariozechner/pi-agent-core`
  for the lower-level loop without sessions/auth)
- `createAgentSession({ noTools: 'all', customTools: dheeTools })` —
  disables pi's default 7 file/shell tools (`read`, `write`, `edit`,
  `bash`, `grep`, `find`, `ls`) and registers ours instead. Public API,
  no fork.
- `ResourceLoader.getSystemPrompt()` returns our orchestrator prompt
  verbatim — pi's coding-agent prompt is fully replaced. Date + cwd +
  project-context-files (`AGENTS.md` / `CLAUDE.md`) are auto-appended.
- Sibling package [`@mariozechner/pi-web-ui`](https://github.com/badlogic/pi-mono/tree/main/packages/web-ui)
  proves the surface area is right for embedding in custom UIs:
  reusable web components driven by `pi-agent-core` events.

## What we get for free

- streaming token output per assistant turn
- tool-call lifecycle events (started, streaming partial output,
  completed, errored) — the dhee executor's existing progress events
  map to these
- session management, branching, compaction
- multi-provider auth (Anthropic, OpenAI, Gemini, OpenRouter, xAI,
  Bedrock, Vertex, Mistral, Groq, etc.)
- slash commands, skills, prompt templates
- four runtime modes: interactive TUI, print, JSON, RPC for IPC, plus
  the SDK for in-process embedding

## What dhee exposes as tools

Each maps to existing scripts/functions; the LLM picks based on user intent:

- `dhee_new(name, style, duration, input)` → `scripts/new-project.ts`
- `dhee_run_to(project, stage)` → `scripts/run-to.ts` (long-running)
- `dhee_reset(project, stage)` → `scripts/reset-project.ts`
- `dhee_status(project)` → `scripts/project-status.ts`
- `dhee_audit_fidelity(project)` → `scripts/audit-fidelity.ts`
- `dhee_list_items(project, type)` → `scripts/list-items.ts`
- `dhee_read_artifact(project, path)` — safe read of project files
- `dhee_render_scene_bundle(project, scene)` — explicit prompt-relay
  scene render trigger

Long-running tools (`run_to`, `audit_fidelity`, `render_scene_bundle`)
emit progress via pi's tool-streaming events; the desktop UI renders
them as live progress in the chat surface. Cancellation maps to pi's
tool-cancellation contract.

## Desktop UI shape

User goal: a desktop app where the user talks to a dhee agent that
drives the executor. Three integration paths, ranked by effort:

| | path | tradeoff |
|---|---|---|
| A | embed `pi-web-ui` components in an Electron / Tauri shell | fastest — chat UI is done, just skin it |
| B | build custom UI on `pi-agent-core` directly (renderer + main-process agent over IPC) | full UX control, more code |
| C | run `pi-coding-agent` in **RPC mode** as a child process; desktop UI is the JSONL stdio client | strong process isolation, language-agnostic UI |

Pi's RPC mode (`packages/coding-agent/src/modes/rpc/rpc-types.ts`) is
explicitly built for path C.

## Effort estimate

End-to-end **1-2 weeks** for a working desktop app:

  - **~2 days** — npm-install pi, define the dhee tool surface,
    write the orchestrator system prompt, smoke-test in pi's
    interactive TUI mode (no UI yet).
  - **~3 days** — long-running tool plumbing: thread the executor's
    progress events through pi's tool-streaming events; cancellation;
    handle the prompt_relay scene-bundle case (one tool call covers
    N shots).
  - **~5-7 days** — desktop shell (Electron or Tauri), embedding pi
    via path A, B, or C, plus UX polish for the dhee-specific
    flows (project picker, asset previews, scene bundle progress).

Pi side stays small; the dhee-specific glue is the main work.

## Key decisions to make before starting

  1. **In-process vs out-of-process agent.** Run pi inside the
     desktop's main process (SDK) or as a child process (RPC)? In-
     process is simpler; out-of-process gives crash isolation and
     restart-without-app-restart. Probably out-of-process for safety
     given long renders.
  2. **Where the executor runs.** The dhee executor is currently
     sync(ish) within Node — long renders in the same process as
     the agent are fine if cancellable. If we move the agent
     out-of-process, the executor goes with it.
  3. **Web vs native shell.** `pi-web-ui` is web-based; using it
     means Electron or Tauri-with-webview. A native shell (Tauri
     with native widgets, Swift, etc.) means option B and rebuilding
     the chat UI.

## References

- [pi-mono repo](https://github.com/badlogic/pi-mono)
- [pi-coding-agent package](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- [pi-web-ui package](https://github.com/badlogic/pi-mono/tree/main/packages/web-ui)
- [pi-agent-core package](https://github.com/badlogic/pi-mono/tree/main/packages/agent)
- The parent TODO: [`wrap-executor-in-generic-agent.md`](./wrap-executor-in-generic-agent.md)
- pi SDK system-prompt seam:
  `coding-agent/src/core/system-prompt.ts:54` — `customPrompt`
  replaces default
- pi SDK tool seam:
  `coding-agent/src/core/sdk.ts` — `CreateAgentSessionOptions`
  exposes `noTools`, `tools`, `customTools`
