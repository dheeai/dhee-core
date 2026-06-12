---
name: "source-command-iterate-agent"
description: "Tight loop for changing the dhee pi-agent (skill MD, custom tools, allowlist) — drive the agent via the pnpm drive CLI, read what it actually says/does, iterate. Use whenever the user asks you to change agent behavior, prompts, or tool surface."
---

# source-command-iterate-agent

Use this skill when the user asks to run the migrated source command `iterate-agent`.

## Command Template

You are iterating on the pi-agent's behavior. The drive CLI (kshana-core `pnpm drive`) lets you talk to the agent turn-by-turn from Bash and capture text deltas + tool calls. Do not finish an agent change without driving the agent at least once and reading what it produced.

## When this applies

- You edited `src/agent/pi/skill/SKILL.md` (the agent's brain).
- You edited or added a custom tool under `src/agent/pi/tools/`.
- You changed the allowlist in `src/agent/pi/buildSession.ts`.
- You changed the dhee pi-agent's prompt/tool wiring in any way.

Do **not** use this loop for changes that don't affect agent behavior (purely-renderer UI work — use `/iterate-ui`).

## Prerequisites

`pi-coding-agent` must be authed for a provider on this machine. Drive CLI uses pi's default model picker, so a working auth is required:

```bash
pnpm exec pi auth          # if not done already
```

The drive CLI is **tsx-run** — no `pnpm tsup` rebuild is needed for agent code changes (the CLI reads source directly). One exception: if the change is to **kshana-core** files imported by buildSession itself (e.g. paths.ts), and the kshana-desktop is also expected to pick up the agent, rebuild `dist`:

```bash
cd /Users/ganaraj/Projects/kshana-core && pnpm tsup    # only if desktop must see the change too
```

## The loop

For each iteration:

### 1. Make the change

Edit the file. Save.

### 2. Start (or continue) a session

If the change can be tested fresh, start a new session each time so prior turns don't pollute behavior:

```bash
cd /Users/ganaraj/Projects/kshana-core
pnpm drive start
# {"ok":true,"sessionId":"<id>","sessionFile":"..."}
```

Capture the sessionId from the JSON.

If the change is about how the agent **builds on prior context** (e.g. memory of earlier choices), reuse a session via `pnpm drive list`.

### 3. Send a probe prompt

Pick a single prompt that exercises exactly what you changed. Don't bundle multiple concerns — bundled prompts give bundled signal.

```bash
pnpm drive send <id> "Create a project named 'probe' using narrative_qwen_chain_relay"
```

The JSON envelope includes:
- `assistant_text` — the model's reply.
- `tool_calls` — every tool the model decided to invoke this turn.

Read both. Specifically:
- Did the agent call the **right tool**? (e.g. dhee_create_project, not just text).
- Did the **arguments** match what your change should produce?
- If text-only, does the reply demonstrate the new behavior you intended?

### 4. Decide

- **Behavior matches intent** — run unit tests if the change had test coverage, then commit + push.
- **Behavior is wrong** — diagnose:
  - Wrong tool called → check the tool's `description` field; the model picks by description.
  - No tool called when one was expected → check the allowlist (`DHEE_TOOL_NAMES`) and that the tool is registered (`registerDheeTools`).
  - Tool call args malformed → check the TypeBox params; remember Vertex landmines (no union literals, no patternProperties).
  - Skill instruction ignored → SKILL.md might be too long or the rule too buried. Tighten the relevant section.

### 5. Re-probe

Edit, then **same probe prompt against a fresh session** so the result is comparable to the previous iteration.

## Reading transcripts later

Sessions persist as JSONL at `~/.dhee/pi-sessions/_drive/<sessionId>.jsonl`. Each line is a `message` event with role: user / assistant / toolResult. Useful for diffing two iterations:

```bash
ls ~/.dhee/pi-sessions/_drive/ | tail -5
```

## Notes

- The drive CLI awaits `session.prompt(msg)` to completion before printing. A `dhee_run_bundle` tool call inside a turn will block for minutes — that's expected when iterating on long-running flows. Use a probe prompt that exercises the tool surface **without** running an end-to-end bundle if you only care about the agent's decision.
- If a turn hangs >5 min with no output, kill the process: `pkill -TERM -f "drive.ts send"`. Most common cause: the agent picked a model whose provider is unauthed.
- **You're not done until you've driven the agent once and read what it produced.** Unit tests verify code; persona-style probes verify behavior.
