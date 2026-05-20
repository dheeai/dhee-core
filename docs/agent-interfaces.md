# Driving dhee-core from external agents

If you're building an agent that needs to talk to dhee-core (Open Claw,
a custom Claude Code plugin, a CI script, your own automation), pick
the surface that matches your runtime and friction tolerance. Today
there are three live interfaces, with a fourth (MCP) on the roadmap.

| Interface | Best for | Ergonomics | Runtime requirements |
|---|---|---|---|
| [CLI scripts](#cli-scripts) | Shell scripts, CI, ad-hoc work, agents that already shell out | Lowest setup, text I/O | Repo + Node + pnpm + tsx |
| [HTTP REST](#http-rest-api) | Cross-process, cross-language, hosted dhee-core, anything not running on the same Node | JSON in/out, stable schema | Just an HTTP client |
| [Library import](#library-import) | Tightly coupled hosts (dhee-desktop is the prototype) | Typed, zero overhead, zero serialization | Node + npm install |
| [MCP server](#mcp-future) — *roadmap* | Agent-first integrations (Claude Code, Cursor, future MCP-aware agents) | Plug-and-play, no bespoke client code | TBD; see `todos/mcp-server.md` |

All four surfaces share the same in-process implementation under the
hood (`src/server/runners/*.ts`). Choosing a different interface
doesn't change *what* dhee-core does — only how you talk to it.

---

## CLI scripts

Defined in `package.json`. Each `pnpm <name>` invocation is a wrapper
around one of the in-process runners; the script file is a thin CLI
wrapper that delegates to `src/server/runners/*.ts`.

```bash
# Project lifecycle
pnpm new <name> --style live --duration 60 --text "..."
pnpm new <name> --style anime --duration 30 --input story.md
pnpm reset <project> <stage> [--clean]
pnpm status <project>
pnpm inspect <project>                # show-project: full project.json snapshot
pnpm nodes <project> [type] [status]  # list-items: filter the executor graph

# Drive the pipeline
pnpm run-to <project> [stage]         # run to completion, or pause at a stage / node id
pnpm regen <project> <node>           # invalidate + re-run a specific node
pnpm override <project> <alias> --from <file>   # paste user-edited content for a node
pnpm stop <project>                   # set the stop sentinel + cancel any in-flight job

# Quality / utilities
pnpm audit-fidelity <project>         # VLM judge over generated images (long-running)
pnpm calibrate-vlm
pnpm backfill-schema <project>
```

**When to use:** simplest possible integration. If your agent is
already happy shelling out and you have the dhee-core repo on the
same machine, CLI is the lowest-friction option. Output is text
(usually structured logs you can grep); exit code 0 = success.

**When NOT to use:** you don't have the repo. The packaged dhee
desktop binary doesn't include `scripts/`, so CLI scripts only work
in the dev/repo context.

---

## HTTP REST API

Registered by `registerAgentRoutes()` in `src/server/agentRoutes.ts`.
All endpoints under the configured prefix (default `/api/v1`).

The server is started by `pnpm start` (which runs `src/server/cli.ts`).
Default port is read from env or defaults baked into `cli.ts`. Auth
via `ApiKeyAuth` (`src/server/auth.ts`) when an API key is configured.

### Read endpoints

| Verb + path | What it returns |
|---|---|
| `GET /api/v1/projects/:name/status` | `StatusSummary` — counts, current phase, failed-node list |
| `GET /api/v1/projects/:name/nodes/:alias` | Per-node detail (status, deps, error, output paths) |

### Mutation endpoints

| Verb + path | Body | What it does |
|---|---|---|
| `POST /api/v1/projects/:name/regen` | `{ aliases: string[], cascade?: boolean }` | Invalidate one or more nodes (and optionally everything downstream). Returns `{ changed, notFound }`. |
| `POST /api/v1/projects/:name/override` | `{ alias: string, content?: string, fromPath?: string }` | Replace a node's content with user-provided text. |
| `POST /api/v1/projects/:name/stop` | — | Write `.executor.stop` sentinel + cancel any in-flight job. Returns `{ status, sentinel, cancelledJobId? }`. |

### Run jobs (async, polled)

| Verb + path | Body | Behavior |
|---|---|---|
| `POST /api/v1/projects/:name/run-to` | `{ stage?, nodeId?, skipMedia? }` | Kicks off a run. Returns `{ jobId, status, target }` immediately. JobManager serializes per-project — duplicate calls return 409 with `existingJobId`. |
| `GET /api/v1/projects/:name/run-to` | — | Latest job for the project. 404 if no runs yet. |
| `GET /api/v1/projects/:name/run-to/:jobId` | — | Specific job by id. Includes `status`, `target`, timestamps. |

### Streaming

The HTTP API itself is request/response. For event streams (`tool_call`,
`tool_result`, `media_generated`, `notification`, etc.) connect to the
WebSocket endpoint registered by `WebSocketHandler` in
`src/server/WebSocketHandler.ts`. Same wire shape as
`dheeEventName` in `dhee-desktop/src/shared/dheeIpc.ts`.

### Example: run a project to completion

```bash
# Kick off
JOBID=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{}' http://localhost:8001/api/v1/projects/noir/run-to \
  | jq -r .jobId)

# Poll
while true; do
  STATUS=$(curl -s "http://localhost:8001/api/v1/projects/noir/run-to/$JOBID" | jq -r .status)
  echo "  $STATUS"
  [[ "$STATUS" == "completed" || "$STATUS" == "failed" || "$STATUS" == "cancelled" ]] && break
  sleep 2
done
```

For richer streaming, open a WebSocket alongside and listen for
`tool_call` / `media_generated` / `notification` events. They fire as
the run progresses.

**When to use:** any time the agent isn't on the same Node process as
dhee-core. Cross-machine, cross-language, hosted dhee-core, batch
automation that doesn't want to install dev deps.

---

## Library import

If your agent IS in Node and you want zero overhead + full TypeScript
types, link dhee-core as a dependency and import the runners
directly:

```ts
import {
  runExecutor,
  type RunExecutorOpts,
  type RunExecutorResult,
} from 'dhee-core/server/runners';

import {
  resetProjectStage,
  type ResetProjectStageOpts,
  type ResetProjectStageResult,
  ResetProjectError,
} from 'dhee-core/server/runners/resetProjectStage';

import {
  createProjectInProcess,
  resolveStyle,
  CreateProjectError,
} from 'dhee-core/server/runners/createProjectInProcess';

import {
  ConversationManager,
} from 'dhee-core/server/manager';
```

Live entry points (the embed barrels — Fastify-free, safe to bundle
into Electron / a worker / etc.):

- `src/server/manager.ts` — `ConversationManager` + `loadDevEnv`
- `src/server/runners/index.ts` — `runExecutor` + helpers
- `src/server/runners/resetProjectStage.ts` — `resetProjectStage`
- `src/server/runners/createProjectInProcess.ts` — `createProjectInProcess`
- `src/agent/pi/index.ts` — pi-agent extension factory

The dhee-desktop app is the canonical example consumer
(`dhee-core: file:../dhee-core` in its package.json).

**When to use:** Node-native agents that want maximum performance and
typed APIs. Tightly coupled hosts where shipping dhee-core in the
same bundle makes sense.

---

## MCP — *future*

The roadmap is to expose the same operations as a Model Context
Protocol server so any MCP-aware agent (Claude Code, Cursor, future
agents) can drive dhee-core without writing client code.

See `todos/mcp-server.md` for the scope, open questions, and
estimated effort.

---

## Which interface should pi-agent use?

The pi-agent (the chat panel inside dhee-desktop) uses **library
import** — it imports `runExecutor`, `resetProjectStage`,
`createProjectInProcess` directly because it ships in the same Node
process as the embedded ConversationManager. See
`src/agent/pi/tools/*.ts`.

External agents should not try to talk to the pi-agent. The pi-agent
is a chat orchestration layer, not an integration boundary. Pick CLI,
HTTP, or library based on your runtime.

---

## Tested coverage

For per-tool / per-runner test coverage, see
`docs/pi-agent-bridge-coverage.md`. The HTTP routes have their own
tests in `tests/server/`.
