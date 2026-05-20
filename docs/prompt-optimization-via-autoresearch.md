# Optimizing a prompt with autoresearch + rubrics

A generic recipe for hill-climbing any prompt that drives a stochastic
LLM call. Pattern is what dhee-core uses for character image,
setting image, scene breakdown, motion directives, etc. — see
`scripts/autoresearch-*.ts` for working examples.

The loop is dirt simple:

```
                ┌────────────────────────────────────────────┐
                │                                            │
                ▼                                            │
   ┌─────────────────────┐                                   │
   │ 1. GENERATE         │  prompt-under-test + test inputs  │
   │  the LLM uses the   │  → candidate output               │
   │  current prompt     │                                   │
   └─────────────────────┘                                   │
              │                                              │
              ▼                                              │
   ┌─────────────────────┐                                   │
   │ 2. EVALUATE         │  binary rubric (judge LLM)        │
   │  score each Q       │  → score, list of failures        │
   │  YES / NO           │                                   │
   └─────────────────────┘                                   │
              │                                              │
              ▼                                              │
   ┌─────────────────────┐                                   │
   │ 3. PROPOSE          │  failures + current prompt        │
   │  rewrite the prompt │  → improved prompt                │
   │  to fix failures    │                                   │
   └─────────────────────┘                                   │
              │                                              │
              └──────── overwrite the prompt file ───────────┘
```

You stop when every test case scores 100%, or after a fixed iteration
budget — whichever comes first.

---

## Step 1 — pick a prompt and write it down

Identify the **single file** you want to optimize. It must be a static
piece of text the runtime loads (not a string built by code at call
time). In dhee-core these live under `prompts/skills/defaults/`,
`prompts/system/`, or `prompts/templates/<workflow>/`.

Constraints:

- **One prompt per autoresearch run.** Don't try to optimize two
  things at once — the gradient gets noisy.
- The prompt must be self-contained. If the runtime injects extra
  context (e.g. world style, character profile), the autoresearch
  generator needs to inject the *same* context the same way.

If the prompt is too long, autoresearch can stall — the proposer
struggles to make focused edits. Split into a "guide" + "skill" pair
first if that's the case.

---

## Step 2 — collect 4–6 real test cases

Test cases are **real inputs the prompt will see in production** —
not toy examples. Pull from existing `*.dhee` projects. Diversity
beats volume: 4 cases that span genres / tones / styles uncover more
failures than 20 near-duplicates.

For each case, capture the inputs the prompt depends on. Examples:

| What you're optimizing | Per-case inputs |
|---|---|
| Character image guide | character profile + world style |
| Scene breakdown guide | scene markdown + duration + style |
| Motion directive guide | shot images (first/last) + scene context |

Store cases as on-disk files under existing project dirs — your
script reads them as plain text. Don't fabricate fixtures: real inputs
expose real failure modes.

**Trap to avoid**: picking only "easy" cases. If every test case
already scores 100% on the first iteration, your rubric is too lax or
your test set is too narrow.

---

## Step 3 — author a binary rubric

Save under `tests/autoresearch/rubrics/<thing>-binary.json`:

```json
{
  "name": "Character Image Binary",
  "description": "Binary YES/NO checks on character image prompt quality.",
  "format": "binary",
  "phase": "img_prompts",
  "promptType": "character_image",
  "questions": [
    {
      "id": "ETHNICITY",
      "question": "Does the prompt specify or clearly imply the character's ethnicity/race/skin tone?"
    },
    {
      "id": "CLOTHING",
      "question": "Does the prompt describe specific clothing with colors and materials — not vague ('casual clothes') but concrete ('worn brown leather jacket')?"
    }
  ]
}
```

**Rubric design rules** (these are load-bearing):

1. **Binary, not scalar.** "Did the prompt mention X — yes or no?"
   beats "How well did it describe X — 1 to 5?". Scalars introduce
   judge variance that hides the signal.
2. **One concept per question.** "Does it specify hair color, length,
   AND style?" should be three questions.
3. **Concrete failure mode per question.** Each question should
   correspond to a thing you've seen go wrong in production. Don't
   add aspirational checks ("does it evoke wonder?") — the judge
   becomes noisy.
4. **Stable IDs.** The `id` field is your aggregation key over time.
   Renaming it loses history.
5. **Aim for 8–15 questions.** Too few and you have no gradient.
   Too many and the proposer can't address them all in one edit.
6. **Include negative checks.** "Does the prompt AVOID modern terms
   like 'jeans' or 't-shirt'?" — failure modes you've explicitly
   ruled out.

---

## Step 4 — write the autoresearch script

Copy `scripts/autoresearch-character-image.ts` as a starting template
and adapt the four functions:

```ts
const GUIDE_PATH  = 'prompts/skills/defaults/<your-prompt>.md';
const RUBRIC_PATH = 'tests/autoresearch/rubrics/<your-rubric>.json';
const OUTPUT_DIR  = 'test-output/autoresearch-<thing>';
```

The script has four moving parts:

### a. `findTestCases()` — load real inputs

Returns an array of `{ projectName, ...inputs }`. Don't include
projects that don't have all required inputs — silently skip them
with a warning. Bail out if zero cases load.

### b. `generate(guide, ...inputs)` — produce candidate output

Calls the production LLM (`LLMClient` from `src/core/llm/`) with the
prompt being optimized as the system message and the test inputs as
user content. **Use the same model + temperature you'd use in
production** — optimizing against a different model gives you a
prompt that's only good for the wrong model.

### c. `evaluate(output, inputs, rubric)` — score one case

Calls a judge LLM (the script uses `claude -p` via `execSync` for
strong evaluation; you can substitute another). Pass:
- the rubric questions enumerated
- the candidate output
- the source inputs (so the judge can verify factual claims)

Force structured output via JSON schema so you get a clean
`{ answers, score, total }` back. Returns the list of failed `id`s
so the proposer knows what to fix.

### d. `proposeImprovement(guide, evalResults)` — rewrite the prompt

Calls the judge LLM again, this time with:
- the current prompt
- per-case scores + failure ids
- the rubric question text for each failed id
- guidelines on what kinds of changes help

Returns the rewritten prompt. The script overwrites the file
in-place — git is your undo.

### Glue: the iteration loop

```ts
for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
  const evalResults = [];
  for (const tc of testCases) {
    const candidate = await generate(guide, tc);
    writeFileSync(`${OUTPUT_DIR}/iter-${iter}-${tc.projectName}.txt`, candidate);
    evalResults.push({ project: tc.projectName, ...evaluate(candidate, tc) });
  }
  if (evalResults.every(r => r.failures.length === 0)) break; // perfect — done
  if (iter < MAX_ITERATIONS) {
    guide = proposeImprovement(guide, evalResults);
    writeFileSync(GUIDE_PATH, guide);
    writeFileSync(`${OUTPUT_DIR}/iter-${iter}-guide.md`, guide);
  }
}
```

Persisting per-iteration artifacts to `test-output/` lets you diff
iterations later and recover from a regression.

---

## Step 5 — run it, watch the score

```bash
pnpm tsx scripts/autoresearch-<thing>.ts [iterations]
```

Default 3 iterations. First run, set it to 5–8 to give the proposer
room. Output looks like:

```
Found 4 test cases: noir_detective, lazarus_drive, ...
--- Iteration 1/5 ---
  noir_detective: 9/14 (failed: SIMPLE_POSE, ETHNICITY, CLOTHING, MATERIALS, AVOID_MODERN)
  lazarus_drive:  11/14 (failed: ETHNICITY, AGE, CLOTHING)
  ...
  Average: 9.5/14 (67.9%)
  Proposing improvement...
  Guide updated (4831 chars)
--- Iteration 2/5 ---
  noir_detective: 12/14 (failed: SIMPLE_POSE, AVOID_MODERN)
  ...
  Average: 12.5/14 (89.3%)
```

Healthy patterns:
- Score improves monotonically across iterations.
- Failure set shrinks AND shifts — early failures get fixed, new
  niche ones surface.
- One or two stubborn questions hold out — those are usually the
  hardest cases and signal where the prompt is brittle.

Sick patterns to abort and rethink:
- **Stuck at the same score for 3+ iterations.** The proposer is
  out of ideas; the rubric may be misaligned with what the prompt
  can plausibly produce.
- **Score oscillates.** The proposer is fixing one failure by
  introducing another. Tighten the proposer's instructions to
  preserve passing checks.
- **Goodharting.** Score climbs but the prompt gets weird (long
  filler clauses to satisfy a checkbox question). Add a regression
  test: render an actual image / video / asset and judge that
  end-product, not just the prompt.

---

## Step 6 — commit the winning prompt

When you're happy:

1. Diff the prompt against `main`. Read it like a human would —
   does it still feel coherent, or is it a salad of checklist
   clauses? If salad, manually reduce.
2. Run the eval one more time at higher iteration count to confirm
   the score is stable, not lucky.
3. Run a downstream end-to-end sanity check (generate the actual
   asset the prompt feeds — image, video, scene plan). Rubric scores
   are a proxy; the real artifact is the truth.
4. Commit the prompt file + the rubric (the rubric is the
   spec; keep them together).

---

## Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Same model judges itself | Rubric scores improve but real outputs don't | Use a *different* model for evaluation than for generation |
| Test cases too similar | Quick 100% score, real-world regressions | Add genre / language / period diversity |
| Rubric drift | Old prompt scores poorly today | Pin the rubric version with the prompt; re-baseline on intentional rubric changes |
| Prompt grows unboundedly | Length doubles after 5 iterations | Add a length budget to the proposer's instructions |
| Recipe overfit | Prompt is full of "MUST include" / "ALWAYS specify" stamps | The proposer is hill-climbing the rubric, not the goal — re-balance with positive examples instead of imperative checklists |

---

## Layout cheat-sheet

```
dhee-core/
├── prompts/skills/defaults/<your-prompt>.md       ← target file (modified by autoresearch)
├── tests/autoresearch/rubrics/<your-rubric>.json  ← rubric spec
├── scripts/autoresearch-<thing>.ts                ← iteration loop
└── test-output/autoresearch-<thing>/              ← per-iteration artifacts (gitignored)
    ├── iter-1-<project>.txt    candidate outputs
    ├── iter-1-results.json     scores + failures
    └── iter-1-guide.md         prompt snapshot
```

---

## When NOT to use this

- The output is **deterministic** (e.g. a JSON-shape transform).
  Write a unit test instead.
- You only have **one test case**. The whole point is generalization;
  one case = overfit machine.
- The failure mode is **structural** (the prompt's contract is
  wrong). Autoresearch can't redesign the I/O — it can only tune
  language. Fix the contract first, then optimize.
- The bottleneck is the **judge**. If your judge LLM can't reliably
  tell good from bad, no amount of iteration will help. Validate
  the judge against 10 hand-graded cases before trusting it.
