---
name: test-loop
version: 1.0.0
description: |
  Add tests for dhee-core runners, pi-agent tools, or in-process ports.
  Use when the user wants to "test X", "add coverage for Y", "pin the
  contract for Z", or "port script-N in-process and test it." Walks
  through the three established loops we use here: bridge-contract
  (Vitest + injected stubs), tool-on-disk (Vitest + temp dirs), and
  port-then-test (extract logic to src/, swap consumers, write tests
  against the new function).
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
---

# dhee-core test loop

This skill exists so future Claude doesn't reinvent the test patterns
we already established. Read these notes BEFORE writing test code.

The wider integration story (CLI / HTTP / library / planned MCP) lives
in `docs/agent-interfaces.md`. The pi-agent tool inventory + per-tool
test status lives in `docs/pi-agent-bridge-coverage.md`. Both are good
context before adding new tests.

## When to use this skill

The user said something like:

- "Add a test for the runExecutor wiring."
- "Pin the regen tool's contract."
- "Cover the read tools."
- "Port `pnpm <foo>` in-process and write tests."
- "Make sure auditFidelity actually runs the right thing."

If the request is about UI rendering / chat-panel behavior, that
testing loop lives in dhee-desktop (`.claude/skills/test-loop/`
over there). This skill is for everything below the IPC boundary.

## Three loops, pick one

### Loop A — Bridge-contract test

**Use when:** testing how a pi-agent tool maps params → runExecutor
opts, how runExecutor wires events → callbacks, how a tool translates
a runner result into a response shape.

**Pattern:**

1. Stub the layer you're not testing.
   - For `runExecutor` itself: pass `agentFactory` to inject a stub
     `RunExecutorAgent` that emits scripted events.
   - For pi-agent tools (`runTo`, `regen`, etc.): `vi.mock` the
     runner module and assert on the call args.
2. Assert on the **shape of the call**, not the side effects.
3. Cover validation paths, happy path, error mapping, cancellation.

**Reference implementations:**

- `tests/unit/runExecutorBridge.test.ts` — 16 tests against
  runExecutor, agent injected via `agentFactory`. Pattern: stub agent
  with on/run/stop/getStopReason, fire scripted events from the test,
  assert callback shapes.
- `tests/unit/piAgentBridgeTools.test.ts` — 19 tests against
  `runTo` + `regen`. Pattern: `vi.mock('../../src/server/runners/runExecutor.js')`,
  mock returns scripted result, assert tool calls runExecutor with
  the right opts and translates events to onUpdate correctly.

**Tells you about:** wiring bugs, params drift, callback contract
breakage. Does NOT tell you about whether the underlying agent
behavior is correct.

### Loop B — Tool-on-disk test

**Use when:** testing a pi-agent tool that reads or writes
`project.json`, file system state, or the executor graph.

**Pattern:**

1. `mkdtempSync(join(tmpdir(), 'dhee-...'))` per test, set
   `process.env.dhee_PROJECTS_DIR` to that.
2. Build project fixtures via `mkdirSync` + `writeFileSync` directly
   — don't go through the production project loaders unless the test
   IS about the loader.
3. Call `tool.execute('id', params, signal, onUpdate, ctx)` directly.
4. Assert on the tool's return value AND read back the project.json
   from disk to verify side effects.
5. Tear down the temp dir in `afterEach`.

**Reference implementations:**

- `tests/unit/piAgentReadTools.test.ts` — 28 tests for status /
  listItems / listProjects / readArtifact. Pure read; no disk
  mutation assertions, just response-shape checks against scripted
  fixtures.
- `tests/unit/createProjectInProcess.test.ts` — 17 tests including
  on-disk side-effect assertions (folder created, project.json
  schema, original_input.md exact match).
- `tests/unit/resetProjectStage.test.ts` — 15 tests on the graph
  mutation. After each call, reads the persisted project.json back
  and asserts on the resulting node states / removed entries.

**Tells you about:** real schema bugs, real file-write regressions,
real side effects. SLOWER than Loop A but catches a different bug
class.

### Loop C — Port-then-test

**Use when:** the user asks to port a `pnpm <verb>` script in-process
(typical sign: a pi-agent tool currently calls `runScript('scripts/foo.ts', ...)`
and the user wants it to work in the packaged desktop binary).

**The recipe** (this is the pattern the recent runTo/regen/newProject/
reset ports followed):

1. **Read the script's `main()`.** Find what it actually does
   (validation, IO, work, output formatting). The work usually
   wraps something already in `src/` — locate that.
2. **Extract a function** at `src/server/runners/<name>.ts`. Take
   structured opts, throw a custom Error class on usage violations,
   return a structured result, accept an optional `onLog` for
   streaming progress. NEVER `process.exit` or `console.log`
   directly — those are CLI concerns.
3. **Update the script** to delegate. Keep arg parsing, stdin
   reading, exit code mapping in the script; everything else moves
   to the runner. Gate `main()` with `isDirectExecution` so the
   script can be safely imported without triggering the CLI.
4. **Update the pi-agent tool** to call the runner directly (drop
   `runScript`). Use `getProjectsDir()` for `basePath`, pipe `onLog`
   through to `onUpdate` for chat streaming.
5. **Write tests** against the runner function (Loop B style) AND
   against the tool wrapper (Loop A style).
6. **Verify the CLI still works** end-to-end with a tmpdir smoke
   test before committing — this is a load-bearing user surface.

**Reference implementations:**

- `src/server/runners/createProjectInProcess.ts` (+ its test) +
  `scripts/new-project.ts` (CLI wrapper) +
  `src/agent/pi/tools/newProject.ts` (pi-agent wrapper).
- `src/server/runners/resetProjectStage.ts` (+ its test) +
  `scripts/reset-project.ts` + `src/agent/pi/tools/reset.ts`.
- `src/server/runners/runExecutor.ts` (+ its bridge test).

**Tells you about:** that the port preserves the CLI contract AND
that the pi-agent now works in the packaged desktop. Both matter.

## How to actually run the loop

```bash
# Single test file, fast iteration
pnpm vitest run tests/unit/<file>.test.ts

# Watch mode while you write
pnpm vitest tests/unit/<file>.test.ts

# Full suite before committing
pnpm test
```

The full suite is currently around 1466 tests / ~20s. If something
unrelated breaks, you probably touched a shared module — back out
the change and figure out why.

## File-naming conventions

| Test target | Test file location | Example |
|---|---|---|
| In-process runner (`src/server/runners/X.ts`) | `tests/unit/X.test.ts` | `resetProjectStage.test.ts` |
| Pi-agent tool wrapper (`src/agent/pi/tools/X.ts`) | `tests/unit/<X>Tool.test.ts` | `resetTool.test.ts`, `newProjectTool.test.ts` |
| Group of related tools | `tests/unit/piAgent<Group>Tools.test.ts` | `piAgentBridgeTools.test.ts`, `piAgentReadTools.test.ts` |

Stick to the existing pattern; don't introduce a new naming
convention without a reason.

## Anti-patterns — DO NOT do these

- **Test by grep'ing source files.** Per CLAUDE.md: "Never write
  tests that grep/search for text strings in source code files."
  Tests must exercise behavior — call the function, read the
  resulting file, assert on the value. If you find yourself
  importing `readFileSync` to read a `.ts` source file, stop.
- **Mock the world.** If you're stubbing more than the one boundary
  you're testing, you've drifted into Loop A by accident. Pick the
  layer and stub only at that line.
- **Test on the user's real `~/dhee` projects directory.** Always
  set `dhee_PROJECTS_DIR` to a `mkdtempSync` directory and tear
  down in `afterEach`.
- **Test the implementation, not the contract.** "Calls
  `setActiveProjectDir` once" is implementation. "After this, the
  project's `currentPhase` is `shot_image`" is a contract. Pin
  contracts.
- **Skip the failing-test-first step for production code.** Per
  user-memory: "every implementation must follow TDD: write
  failing tests first, then implement." Probe scripts (`scripts/probe-*.ts`)
  are exempt; production code is not.
- **Bundle a "wip" test that's expected to fail.** If a test
  surfaces a real bug, fix the bug. If you can't fix it now, drop
  the test and add a `todos/` entry — don't leave a known-failing
  test sitting in the suite.
- **Add a regression test without naming the bug.** When you fix
  something, the test description should mention the symptom or
  bug class so a future reader knows why it exists. Example:
  "streaming → done → agent_response: exactly ONE assistant bubble
  (regression pin for duplicate-bubble bug)."

## Counter-test pattern (when in doubt)

If your assertion uses a tricky locator / regex / count, write a
**counter-test** in the same file that proves the assertion would
fail under the wrong condition. Example:
`streaming-no-duplicate.spec.ts` has a test that pins "exactly 1
bubble" and a sibling test that fires a second `agent_response`
manually and asserts "now there are 2." If the first assertion
were trivially passing, the second couldn't pass too.

This caught a real test-shape bug during the dhee-desktop e2e
work.

## Always run before reporting "done"

1. `pnpm test` — full suite green.
2. If you ported a script: a tmpdir smoke run of the CLI, e.g.
   `dhee_PROJECTS_DIR=$(mktemp -d) tsx scripts/<name>.ts <args>`
   and `cat <tmp>/<name>.dhee/project.json | head` (or the
   relevant artifact).
3. Update `docs/pi-agent-bridge-coverage.md` if you changed the
   tested-tools list.

## Pointers

- `docs/pi-agent-bridge-coverage.md` — current tool coverage map.
- `docs/agent-interfaces.md` — CLI / HTTP / library / MCP surfaces.
- `todos/mcp-server.md` — future MCP work.
- `tests/unit/runExecutorBridge.test.ts` — Loop A canonical example.
- `tests/unit/createProjectInProcess.test.ts` — Loop B canonical example.
- `src/server/runners/` — where ported runners live.

## When you should NOT add a test

- The change is a probe script (`scripts/probe-*.ts`) — those are
  exploratory and don't TDD.
- The change is a doc, a comment, a typo fix, or a `package.json`
  cosmetic update.
- The behavior is already pinned by another test and you'd be
  adding a near-duplicate. Check
  `docs/pi-agent-bridge-coverage.md` first.

For everything else: write the test first, watch it fail, then make
it pass.
