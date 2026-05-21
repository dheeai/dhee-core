# RL-train a small LLM on shot_image_prompt using the orientation-ab grader

## Status: PROPOSED — 2026-05-21

## Why this is tractable (not just a research idea)

Three rare conditions all hold simultaneously:

1. **A calibrated ground-truth reward exists.** `pnpm audit-fidelity` + VLM
   judge (Grok-4.1-fast) at 96% agreement with Claude on rendered Klein
   output. See `todos/proper-fidelity-evals.md`.
2. **A cheap proxy reward exists, and is empirically correlated to the
   ground truth.** `scripts/orientation-ab/` — Layer A pattern checks on
   prose. The diagnostic in `WINNING_PATTERNS.md` proved: when Layer A
   passes, Klein renders correctly. When it fails, Klein produces the
   face-to-face / identity-bleed / hallucination bugs.
3. **The current small model has a persistent failure mode that prompt
   engineering cannot fix.** DeepSeek v4-flash consistently trusts the
   upstream `shotDescription` prose over the system-prompt guide rules.
   Guide v1 → v2 → v3 escalation made zero difference (0/3 on
   scene-2-shot-1 across all guide versions). That's a weights problem,
   not a prompt problem.

The third point is what makes RL the right hammer. If a smarter system
prompt could fix it, RL would be overkill. We've established it can't.

## The reward stack we already have

Look at `scripts/orientation-ab/`:

- **Layer A (project-agnostic prose grader).** Pure-function pattern
  checks on prose. `FACE_VOCAB`, `BACK_VOCAB`, `WEASEL_VOCAB`,
  length bounds, inline-hook regex. Microseconds per sample.
  Deterministic. Generalizes across projects.
- **Layer B (per-shot checks, currently Ruby-V3-specific).**
  `correctedFixtures.ts:CHECKS_BY_SHOT` — e.g. "lead with Ruby in
  s4-shot-5", "owner's face required in s2-shot-9 OTS", "no Ruby face
  in s4-shot-11 POV". These look project-specific but aren't really —
  they're deterministic functions of `(purpose × cameraWork ×
  focalSubject × slotted[])`. Can be generalized into a checks
  generator (see below).
- **Klein render + VLM judge (slow truth reward).**
  `renderPrompts.ts` + visual diff against `results/renders/*_hand_v1.png`.
  Already wired against the zrok local Comfy instance.

Composite reward formula (proposed):

```
reward(prose, brief) =
    1.0 * layerA_pass_rate(prose)
  + 2.0 * layerB_generated_pass_rate(prose, brief)
  + 5.0 * (vlm_klein_score(render(prose)) if periodic_eval else 0)
```

## What needs to be built before training

### 1. Brief synthesizer (~2-5k varied shot briefs)

Use Claude or Grok to generate structured shot briefs varying:
- `purpose ∈ {meet_character, set_arrival, OTS_robbery, close_up,
  vehicle_interior, action_impact, conversation, …}`
- `cameraWork ∈ {back-to-camera, OTS, close-up, wide, medium, low-angle, …}`
- `characterCount ∈ {1, 2, 3+}`
- `focalSubject ∈ {primary char, secondary char, environment, object, …}`
- `genre ∈ {noir, period-drama, cosmic-horror, ensemble, fantasy, …}`

Ruby V3's 5 shots are not enough surface. Without genre/structural
variety, the trained model will regress on anything outside that
distribution.

### 2. Layer B generalization — `generateChecksFromShotBrief(brief)`

The Ruby-V3-specific checks in `correctedFixtures.ts:76-135` are
deterministic functions of brief structure. Extract the templates:

| Brief property                          | Generated check                                                   |
|------------------------------------------|-------------------------------------------------------------------|
| `purpose=approach_beat`                  | ban face vocab attached to slotted characters; require back vocab |
| `cameraWork=OTS`, `focal=person_C`       | require C's face/expression; ban A/B face vocab                   |
| `framing=close_up`, `focal=person_X`     | length ≤ 130 words; require X inline-hook with identity descriptors |
| any character with reference slot        | require inline visual hook on first mention                        |
| `purpose=POV_of_X`, focal=Y on ground    | ban X face mentions (X is the camera)                              |
| `subject_in_vehicle`                     | require "lead with focal" — subject mentioned before vehicle       |

Output: same shape as `CHECKS_BY_SHOT[shotId]` — an array of `{name,
test, required}` records that runs per generated prose.

### 3. Held-out Klein eval set

50-100 briefs from the synthesizer, locked away from training. Render
via Klein every checkpoint, judge with VLM. If Layer A score climbs but
held-out Klein score flatlines or drops, **stop — the model is
reward-hacking the lexical patterns**.

### 4. Decide the candidate model — and host *before* you train

DeepSeek's models are open-weights (V3, R1, V3.2-Exp all shipped under
permissive licenses), so fine-tuning DeepSeek Flash is on the table —
this is NOT a closed-API trap. But "fine-tunable" doesn't mean
"trivially hostable." The hosting decision must happen *before* a
single GPU-hour is spent on training, because hosting constrains which
base model is viable.

#### Decision tree

```
1. Pull the DeepSeek Flash model card. Confirm active parameter count.

2. If dense and ≤30B params (i.e., "flash" is a distilled smaller variant):
   - Train LoRA on it directly.
   - Preferred hosting: Fireworks / Together / Hyperbolic with custom
     LoRA on top of their DeepSeek Flash deployment — IF they support
     LoRAs on this specific base. Verify before training, not after.
   - Fallback: self-host vLLM on 1-2× A100/H100 (~$1-3/hr on RunPod /
     Lambda). vLLM supports multi-LoRA hot-swap, so per-genre LoRAs
     later are free infra-wise.
   - OpenRouter still usable as the router — point a tier in
     `.llm-routing.json` at the Fireworks/Together endpoint.

3. If MoE / large (DeepSeek V3-class is 671B total / ~37B active —
   needs an 8×H100 node, ~$15-25/hr, ~$11-18k/mo pinned 24/7):
   - Check Hyperbolic / Fireworks / Together / DeepInfra for
     custom-LoRA support specifically on this base. Vendor-specific
     and hit-or-miss — "they host the base" ≠ "they support your LoRA".
   - If no provider supports LoRAs on it, switch the RL-target base
     to an open dense model: Qwen 2.5-7B, Llama 3.1-8B, Phi-3.5-mini.
     Keep DeepSeek Flash as the default for every other LLM call;
     route ONLY `shot_image_prompt` to the new endpoint via
     `.llm-routing.json`'s per-purpose routing. This is one config
     edit, not a rewrite.

4. If hosting cost shape is still ugly after (2)/(3):
   - Co-locate on the existing ComfyUI cloud GPU. Idle between Klein
     renders; marginal cost ≈ 0. Risk: render-vs-LLM contention under
     load (renders are the long pole, so contention probably hurts).
   - Or Modal/RunPod serverless. Cold-start 10-30s but
     `shot_image_prompt` runs in tight bursts of ~50 calls per project,
     so the cold-start amortizes. Likely cheapest per-project for our
     current volume.
```

#### Cost shape (back-of-envelope)

A project = ~50 `shot_image_prompt` calls. A 7-30B dense LoRA on vLLM
serves each in <1s. Per-project hosting cost:

| Option                                | Cost per project | Best when             |
|----------------------------------------|------------------|------------------------|
| Fireworks/Together (per-token, custom LoRA) | $0.05-0.20    | Volume <1k projects/mo |
| Self-host vLLM dedicated ($0.40-1/hr)  | $290-720/mo flat | Volume >1.5k/mo        |
| Serverless (Modal/RunPod)              | $0.01-0.05      | Bursty / spiky load    |
| Co-located on Comfy GPU                | ~$0 marginal    | Low contention with renders |

For current volume, Fireworks/Together via OpenRouter is the obvious
default — *provided* they ship LoRA support for whatever base we pick.

#### Other training-choice considerations

- DPO/GRPO tooling maturity for the base architecture (HuggingFace TRL
  covers Qwen / Llama / Mistral / Phi cleanly; DeepSeek-specific
  recipes exist but less polished).
- Model size vs reward signal strength — a 3B model may not have
  enough capacity to internalize the full Layer A + Layer B contract
  across genres; a 30B might be overkill.
- Single-stage specialist vs joint multi-stage training. Cheapest first
  cut is one LoRA for `shot_image_prompt` only. Later, jointly train
  `shot_image_prompt` + `motion_directive` + `scene_breakdown_shot`
  using their respective binary rubrics from
  `todos/prompt-optimization.md` — same reward shape, larger scope.

#### Action: do this BEFORE anything else

Write `scripts/rl-train/checkHostingViability.ts`:
1. Fetch DeepSeek Flash model card — confirm param count.
2. Probe Fireworks, Together, Hyperbolic, DeepInfra API listings for
   the model.
3. For each provider that hosts it, check whether their custom-LoRA /
   fine-tuning product supports it as a base.
4. Output a one-page report: "viable hosting paths for RL'd
   shot_image_prompt model."

Without this report, all training plans below are speculative.

## Training plan

### Stage 1 — DPO (cheap, no env loop)

1. For each brief in training set, sample N=8 candidates from base model
   (temperature 0.7-0.9 for diversity).
2. Score each with `layerA + generated layerB`.
3. Take top-2 vs bottom-2 as preference pairs.
4. Run DPO on base model.
5. Repeat with the trained model as the new sampler — iterative DPO.

Cost: trivial. No render calls. Pattern grading is microseconds.

**Stop condition:** held-out Klein eval (50 briefs) reaches parity with
Claude/Grok-as-prompt-writer baseline.

### Stage 2 — GRPO with Klein+VLM reward (only if Stage 1 plateaus)

Outcome-grounded RL. Each rollout:
1. Sample prose from policy.
2. Render via Klein.
3. VLM judge → terminal reward.
4. GRPO update.

Cost: each sample is one Klein render (~30-60s on zrok local) + one VLM
call. Roughly $X per sample depending on render cost. Only justify if
DPO plateau is meaningful.

### Stage 3 — Production rollout

Replace DeepSeek v4-flash in the `shot_image_prompt` slot. Keep the
existing `shotImagePipeline.ts` pipeline (deterministic normalizers,
canonical-refs enforcement, multi-turn refinement) — the trained model
is just a drop-in for the generation call.

## Risks

1. **Reward hacking on Layer A.** Lexical patterns are gameable. Model
   could write malformed prose stuffed with `"from behind"` and
   parenthetical hooks. The held-out Klein eval is the only defense.
2. **Distribution narrow.** Training only on Ruby-V3-flavor briefs will
   degrade other genres. Brief synthesizer must span the full project
   distribution we ship.
3. **Identity slot leakage.** A trained model may overfit to inline-hook
   patterns and miss when a character HAS no reference slot (then no
   hook is needed). The Layer B generator must encode this.
4. **Coupling to current Klein-Flux2 weights.** If we change image
   models (Nunchaku Flux-2, future LTX variants — see
   `project_nunchaku_flux2_pending` memory), the prose contract may
   shift and the trained model needs re-validation.
5. **Multi-stage interactions.** `shot_image_prompt` reads from
   `shotDescription` which is produced by an earlier LLM stage. If
   upstream prose has banned face vocab (Tier 1 fix from
   `WINNING_PATTERNS.md`), the downstream task is easier. Training the
   downstream model on outputs of a NOT-fixed upstream produces a model
   that depends on upstream being broken. Train against the corrected
   distribution.

## Connection to existing roadmap

- Generalizes `scripts/orientation-ab/` from a one-off regression
  harness into a permanent training reward.
- Complements `todos/prompt-optimization.md` (autoresearch) — that's
  one-shot prompt tuning of the *system prompt*; this is policy training
  of the *small model itself*.
- Provides empirical answer to a parked question in
  `todos/proper-fidelity-evals.md` ("how do we improve weak shots") —
  the answer becomes "the prompt LLM gets better at writing them".
- Subsumes parts of `todos/shot-image-prompt-split.md` (PARKED) — if the
  small model is RL-trained to satisfy the contract, the multi-call
  split becomes less necessary.

## Immediate next step (if we decide to do this)

Write `scripts/rl-train/synthesizeBriefs.ts` — generate 50 varied briefs,
hand-validate 10 of them, confirm the Layer A grader fires sensibly on
each. That's the cheapest possible test of whether the reward-shape
generalizes off Ruby V3. If 10/10 briefs produce sensible Layer A
verdicts when graded against hand-crafted prose, the bigger
infrastructure is worth building. If the grader misfires on >2/10, the
generalization story is weaker than the Ruby-V3 data suggests, and
Layer B needs more careful template extraction first.

## References

- `scripts/orientation-ab/WINNING_PATTERNS.md` — empirical patterns, diagnostic that proved prose-level fixes flow through to Klein render
- `scripts/orientation-ab/correctedFixtures.ts` — Layer A vocab lists + Layer B per-shot checks (the templates)
- `scripts/orientation-ab/generateAndGrade.ts` — current grading harness
- `scripts/orientation-ab/renderPrompts.ts` — Klein render + visual diff
- Commit `bed16e1` — full context for why DeepSeek v4-flash failed all guide-prompt escalations
- `todos/proper-fidelity-evals.md` — VLM judge calibration
- `todos/prompt-optimization.md` — autoresearch (orthogonal: system-prompt tuning vs this todo's policy training)
