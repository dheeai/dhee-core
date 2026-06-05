# Driving dhee-core from external agents

If you're building an agent (Claude Code, a CI script, your own
automation) that needs to drive dhee-core, pick the surface that matches
your runtime. After the **bundle-architecture migration** there are two
live interfaces; a third (MCP) is on the roadmap.

| Interface | Best for | Ergonomics | Runtime requirements | Status |
|---|---|---|---|---|
| [CLI (`pnpm dhee`)](#cli-pnpm-dhee) | Shell scripts, CI, agents that shell out (Claude Code) | Lowest setup, text I/O | Repo + Node + pnpm + tsx | **Live** |
| [Library import](#library-import) | Node hosts that bundle dhee-core (dhee-desktop) | Typed, zero serialization | Node + install | **Live** |
| [HTTP REST + WS](#http-rest--removed) | Cross-process / cross-language | JSON in/out | An HTTP client | **Removed** |
| [MCP server](#mcp--roadmap) | Agent-first integrations | Plug-and-play | TBD | Roadmap |

Both live surfaces share the same in-process implementation: the bundle
**walker** (`src/dag/walker.ts`) driven by `runProjectViaBundle`
(`src/server/runners/`), project bootstrap via `initializeProject`
(`src/dag/initializeProject.ts`), and the `dhee_*` pi-agent tools
(`src/agent/pi/tools/*`). Choosing an interface changes *how* you talk to
dhee-core, not *what* it does.

> **History:** the pre-migration CLI exposed a `pnpm <verb>` script per
> operation (`pnpm new`, `pnpm status`, `pnpm run-to`, …) wrapping a
> legacy executor, plus an HTTP server via `pnpm start`. Both were removed
> when the project moved to the bundle / DAG-walker model. `src/index.ts`
> is now a library barrel, not a CLI dispatcher. The current CLI is a
> single `pnpm dhee <verb>` entry point (`scripts/dhee-cli.ts`).

---

## CLI (`pnpm dhee`)

The lowest-friction surface for an agent on the same machine with the
repo. `scripts/dhee-cli.ts` is a thin wrapper that calls
`initializeProject`, `runProjectViaBundle`, and the `dhee_*` tools
directly — so it can't drift from the desktop chat agent.

```bash
# Create (story via --story <file>, --text "...", or stdin). Lands in
# ~/dhee-studios/<name> (override: $dhee_PROJECTS_DIR or --dir <abs>).
pnpm dhee new <name> --story story.txt --style live --duration 60 \
    [--aspect 16:9|9:16] [--resolution 720|1080] [--bundle <id>] [--style-guide <f>]

# Inspect (read-only)
pnpm dhee status  <project>                       # node status counts + failures
pnpm dhee nodes   <project> [--status s] [--grep r]
pnpm dhee inspect <project> <nodeId> [--item <itemId>]
pnpm dhee bundles                                 # list available pipelines

# Drive
pnpm dhee run    <project> [--to <nodeId>] [--only id,id]
pnpm dhee run-to <project> [<nodeId>]
pnpm dhee stop   <project>                        # writes .dhee.stop; a running `run` halts

# Edit
pnpm dhee regen    <project> <nodeId> [--item <itemId>]   # invalidate + re-run (cascades)
pnpm dhee override <project> <nodeId> --from <file> [--item ..] [--reason ..] [--confirm]
```

`<project>` is a name (resolved under `$dhee_PROJECTS_DIR`, else
`~/dhee-studios/<name>`, else cwd / `<name>.dhee`) or an explicit path.
`run` streams per-node progress to stdout; Ctrl-C or `pnpm dhee stop`
aborts before the next node. Exit code 0 = success.

The `.claude/skills/dhee/SKILL.md` skill is the agent-facing companion to
this CLI (decision tree, node ids, the edit→cascade contract).

**When NOT to use:** you don't have the repo. The packaged desktop binary
doesn't ship `scripts/`, so the CLI is dev/repo-context only.

---

## Library import

For a Node host that bundles dhee-core (dhee-desktop is the canonical
consumer), import the primitives directly:

```ts
import { initializeProject } from 'dhee-core/dag/initializeProject'; // or deep path src/dag/...
import { runProjectViaBundle } from 'dhee-core/runners';

// 1. Create the project dir + project.json pinned to a bundle.
const init = initializeProject({
  projectDir,                       // an existing, empty dir
  name: 'my_film',
  bundleId: 'narrative_prompt_relay',
  inputs: { story_input, style_guide, style: 'anime', aspect: '16:9', resolution: 720, targetDuration: 90 },
});

// 2. Walk the DAG (optionally stop at a node; pass a signal to cancel).
const r = await runProjectViaBundle({ projectDir, stopAt: 'shot_image', log: console.log });
```

`runProjectViaBundle` is re-exported from the `dhee-core/runners` barrel
(`src/server/runners/index.ts`). The `dhee_*` tool instances
(`src/agent/pi/tools/index.ts`) wrap the read/edit operations (status,
inspect, regen, override, …) and are safe to call directly —
`tool.execute('id', params, signal?)` returns
`{ content: [{ type:'text', text }], details, isError? }`.

**Working examples:** `scripts/dhee-cli.ts` (the CLI itself) and
`scripts/style-seep-test.ts` (a bespoke driver) both use exactly this
pattern. dhee-desktop links dhee-core via `file:../dhee-core`.

**When to use:** Node-native hosts wanting typed APIs and zero
serialization overhead.

---

## HTTP REST — *removed*

The pre-migration HTTP/WebSocket surface (`registerAgentRoutes`,
`WebSocketHandler`, `ApiKeyAuth`, started via `pnpm start` →
`src/server/cli.ts`) **no longer exists** — those modules and the `start`
script were removed in the bundle migration. There is currently **no
runnable HTTP server**. If you need a cross-process / cross-language
surface today, drive the CLI as a subprocess. A REST/MCP server over the
bundle runners is future work (see MCP below).

---

## MCP — *roadmap*

Expose the same bundle operations as a Model Context Protocol server so any
MCP-aware agent (Claude Code, Cursor) can drive dhee-core without bespoke
client code. This would wrap the same `initializeProject` /
`runProjectViaBundle` / `dhee_*` primitives the CLI and library use. Not
yet built.

---

## Which interface does the desktop pi-agent use?

**Library import.** The chat panel inside dhee-desktop ships in the same
Node process and imports `runProjectViaBundle` + the `dhee_*` tools
directly (see `src/agent/pi/tools/*` and the desktop's `dheeCoreManager`).
External agents should not try to talk to the pi-agent — it's a chat
orchestration layer, not an integration boundary. Pick the CLI or library.
