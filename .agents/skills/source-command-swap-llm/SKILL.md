---
name: "source-command-swap-llm"
description: "Toggle the active LLM in .env between Grok (x-ai/grok-4.1-fast) and DeepSeek (deepseek/deepseek-v4-flash) across HEAVY / MEDIUM / LIGHT tiers in lockstep."
---

# source-command-swap-llm

Use this skill when the user asks to run the migrated source command `swap-llm`.

## Command Template

Run the swap script and relay its output verbatim:

```bash
node /Users/ganaraj/Projects/kshana-ink/scripts/swap-llm.js
```

The script does the toggle in lockstep across the three tiers, validates that the .env is well-formed (each tier has one grok line + one deepseek line, exactly one uncommented, all three tiers in the same state), and refuses to write if anything looks off.

On success it prints one sentence (e.g. `Swapped grok → deepseek across HEAVY / MEDIUM / LIGHT tiers.`) — show that to the user. On failure it exits non-zero with a clear error message — show that too.

Do not start or restart any servers; the user is expected to reload their env.
