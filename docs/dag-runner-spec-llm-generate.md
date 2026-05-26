# `llm.generate` Runner — Specification

**Status:** Spec only — not implemented. Companion to `docs/dag-bundles-sketch.md`.

**Purpose:** The `llm.generate` runner is the bundle-architecture replacement for **every LLM-driven stage** in the existing `DependencyGraphExecutor`. Once this runner exists, the entire LLM half of the pipeline (plot, story, story_essence, characters, settings, scenes, world_style, scene_shot_plan, shot_breakdown, scene_video_prompt, shot_image_prompt, shot_motion_directive) becomes expressible as bundle nodes — no executor branching, no hardcoded stage progressions.

This is the first of three runners (`llm.generate`, `comfy.image`, `state.diff`) needed to bring the entire pipeline under the bundle architecture. See `docs/dag-bundles-sketch.md` "Sharing model" + "Backward walker" sections for the broader context.

---

## What it replaces in the existing executor

| Existing executor stage | Existing implementation | Becomes `llm.generate` node with config |
|---|---|---|
| plot | `executePlotNode` calls `LLMClient.generate` with `prompts/templates/plot.md` | `promptTemplate: 'prompts/templates/plot.md'`, `outputFormat: 'markdown'` |
| story | similar | `promptTemplate: 'prompts/templates/story.md'`, format: md |
| story_essence | `extractStoryEssence` calls structured LLM + Zod validation | `outputFormat: 'json'`, `responseSchema: 'schemas/story_essence.json'` |
| character (collection) | per-character LLM call | collection node with `llm.generate` runner |
| setting (collection) | same | same |
| scene (collection) | same | same |
| scene_shot_plan / shot_breakdown / scene_video_prompt | hierarchical multi-stage extraction | three collection nodes, each `llm.generate`, with sequential deps |
| shot_image_prompt | per-shot composition prompt | collection node |
| shot_motion_directive | per-shot motion description | collection node |
| world_style | bible | single stage |

The runner is the **transport**; the per-stage shaping lives in the **prompt templates** (which already exist) and the bundle's variable bindings.

---

## Why one runner for all LLM work

Every LLM stage today does the same five things:
1. Load a prompt template from disk
2. Resolve variables (upstream artifact contents, project metadata, per-item context)
3. Choose an LLM provider/model (via the purpose-routing system)
4. Call the LLM
5. Parse the response (markdown passthrough, or JSON with optional schema validation), write to disk

The differences between stages live entirely in the prompt template and the input bindings. Making this one runner — rather than `llm.plot`, `llm.story`, `llm.character` — is the same discipline as the existing `prompts/templates/` directory: the template is the per-stage code, the runner is the engine.

---

## Config schema

```ts
interface LlmGenerateConfig {
  /**
   * Path to the prompt template file. Relative paths resolve against
   * the kshana-core repo root (where `prompts/templates/` lives).
   * Uses the existing `src/core/prompts/loader.ts` for template loading
   * and variable interpolation, so syntax matches what's already in
   * production prompts.
   */
  promptTemplate: string;

  /**
   * Variable bindings for the template. Values are either literal
   * strings/numbers OR template expressions resolved by the walker
   * before the runner is called:
   *
   *   "{{input.story}}"          → contents of the 'story' input node's outputPath
   *   "{{input.story.field}}"    → JSONPath into upstream JSON output
   *   "{{project.style}}"        → project.json field
   *   "{{project.duration}}"     → project.json field
   *   "{{item.id}}"              → for collection nodes, current item id
   *   "{{item.name}}"            → for collection nodes, current item's display name
   *
   * Walker resolves all expressions to concrete values before
   * dispatching, so the runner only sees strings/numbers/objects.
   */
  variables?: Record<string, string | number | boolean>;

  /**
   * Output format determines how the LLM response is parsed and
   * written.
   *
   *   'markdown' (default) — write response as-is to outputPath
   *   'json'              — JSON.parse the response (with code-fence
   *                         stripping), validate against responseSchema
   *                         if present, write pretty-printed
   *   'text'              — same as markdown but without the .md extension
   *                         implication
   */
  outputFormat?: 'markdown' | 'json' | 'text';

  /**
   * Optional Zod / JSON Schema reference for outputFormat=json. When
   * present, the runner validates the parsed JSON and fails the node
   * (rather than silently writing malformed JSON) on schema mismatch.
   *
   * Path resolves against the repo root. Use existing schemas from
   * src/core/planner/schemas.ts where applicable.
   */
  responseSchema?: string;

  /**
   * Purpose-based LLM routing — feeds into the existing
   * src/core/llm/router.ts. Determines which provider/tier handles
   * the call (HEAVY for cinematic prose, MEDIUM for structured
   * extraction, LIGHT for short tags). Defaults to 'generic.medium'.
   *
   * Recognized purposes: see src/core/llm/purposes.ts (38 entries).
   * The router falls back to LLM_TIER_MEDIUM_* env if the purpose
   * isn't registered.
   */
  purpose?: string;

  /**
   * Explicit provider/model override — used when the bundle wants to
   * pin a specific model (e.g. always use Claude for character writing).
   * When set, bypasses purpose-routing. Otherwise undefined → router
   * picks from purpose + env.
   */
  providerOverride?: {
    provider: 'openai' | 'anthropic' | 'google' | 'openrouter' | string;
    model: string;
    baseUrl?: string;
    apiKey?: string;  // typically pulled from env via the provider name
  };

  /**
   * Generation parameters. Defaults are conservative.
   */
  temperature?: number;       // default: from purpose default, else 0.7
  maxTokens?: number;         // default: from purpose default, else 4000

  /**
   * Retry policy. Defaults: 3 retries with exponential backoff for
   * transient errors (rate limit, timeout, empty response). Permanent
   * errors (auth, invalid model) don't retry.
   */
  retries?: number;           // default 3
  retryBackoffMs?: number;    // default 1000 (then 2000, 4000)

  /**
   * Optional cache key derivation. When set, the runner content-
   * addresses outputs by hashing (template + resolved variables +
   * model + temperature). Subsequent calls with identical inputs
   * skip the LLM and reuse the prior output. Off by default — most
   * LLM calls are run-once, not invocation-stable.
   *
   * Independent of the DAG_BUNDLE_FORCE_RERENDER global override.
   */
  cache?: 'content_addressed' | 'output_exists' | 'never';
}
```

---

## Variable resolution rules (walker concern, not runner)

The walker resolves `variables` expressions BEFORE dispatching to the runner. Resolution happens in this order:

1. **`{{project.field}}`** — read from `<projectDir>/project.json`. Common fields: `style`, `duration`, `title`, `templateId`. Walker errors loudly on unknown fields.

2. **`{{input.NODE_ID}}`** — read the upstream node's output file contents. For markdown/text outputs, returns the raw string. For JSON outputs, returns the parsed object.

3. **`{{input.NODE_ID.path.into.json}}`** — JSONPath into a JSON output. E.g. `{{input.story_essence.throughline}}` returns the `throughline` field of `story_essence.json`.

4. **`{{item.id}}` / `{{item.field}}`** — for collection nodes, the current item's id and metadata. Source depends on how the collection's `itemSource` is configured (separate concern, see "Open questions" below).

5. **Literal strings/numbers** pass through unchanged.

After resolution, `variables` is a flat `Record<string, string | number | object>` that the prompt template engine consumes.

**The runner sees only resolved values** — never the raw expressions. This keeps the runner stateless and side-effect-free.

---

## Output handling

The runner writes to `<projectDir>/<node.outputs.pattern>` (pattern already resolved by the walker — e.g. `characters/aria.md`).

| `outputFormat` | Response handling | File extension hint |
|---|---|---|
| `'markdown'` | Trim leading/trailing whitespace. Strip surrounding code fences if present. Write as-is. | `.md` |
| `'json'` | Strip code fences (`\`\`\`json ... \`\`\``). `JSON.parse`. If `responseSchema` set, validate (Zod). Write `JSON.stringify(parsed, null, 2)`. | `.json` |
| `'text'` | Trim. Write as-is. | `.txt` or as-pattern |

On validation failure for JSON: **fail the node**. Caller (walker) decides retry vs. terminal-fail based on `retries` config.

On empty response from LLM: **fail with retryable error** ("LLM returned empty response"). This matches the existing executor's behavior (see `retryOnEmptyLLMResponse.ts`).

On streamed response: collect to buffer, then process as above. Streaming is internal — no streaming output to caller in v1.

---

## Retry policy

| Failure mode | Retry? | Detection |
|---|---|---|
| Rate limit (HTTP 429) | Yes, exponential backoff | Provider-specific status / message |
| Timeout | Yes | Promise timeout |
| Empty response | Yes | `content.trim().length === 0` |
| Schema validation fail | Yes (1 retry only — LLM may produce different output) | Zod validation throws |
| Auth error (401/403) | No — permanent | Provider status |
| Invalid model | No — permanent | Provider status |
| Network error (DNS, refused) | Yes | fetch reject |

Retries respect `retries` config (default 3). After exhaustion, node fails with the last error message.

---

## Self-description

```ts
function describe(): RunnerDescription {
  return {
    id: 'llm.generate',
    displayName: 'LLM text/JSON generation',
    description: 'Calls an LLM with a prompt template + variable bindings; writes markdown or JSON output. Replaces every LLM stage in the existing executor.',
    capabilities: ['text_generation', 'structured_json_generation'],
    modalities: { input: ['text'], output: ['text'] },
    configSchema: { /* JSON Schema mirroring LlmGenerateConfig */ },
    costHint: 'paid_api',  // covers all LLM tier configurations
  };
}
```

---

## What it does NOT do (anti-scope)

- **No vision input.** Image-capable LLM calls (VLM describe-image) belong in a separate `llm.describe_image` runner. Keeps `llm.generate` text-only and unambiguous.
- **No tool calling.** If a node needs to invoke tools (e.g. function calling), that's a different runner (`llm.agent` or similar).
- **No streaming to caller.** Internal streaming to assemble response buffer is fine; runner returns a single string.
- **No template authoring.** The runner consumes templates — it doesn't author them. Template editing stays in `prompts/templates/`.
- **No project state mutation.** Runner reads input artifacts and project.json, writes to its declared outputPath, period. Anything that changes project structure (adding nodes, materializing collection items) is the walker's job.

---

## Open questions / decisions deferred

1. **Collection item materialization for LLM-driven collections.** When the `story` node produces character names that should become `character` collection items, who extracts them? Options:
   - (a) A separate `state.diff` or `extract.items` runner that reads upstream and emits an items list
   - (b) Walker has built-in JSONPath extraction for `itemSource` (e.g. `itemSource: { from: 'story', extract: '$.characters[*].id' }`)
   - (c) The LLM call itself writes an items file in a known format the walker reads

   **Lean toward (b)** — simplest, no extra runner, fits the bundle's declarative shape.

2. **Where do prompt templates live?** Today: `prompts/templates/` in the kshana-core repo. For shared bundles, templates need to ship with the bundle. Either (a) inline in the bundle JSON, (b) sibling files in `bundles/<bundle-id>/templates/`, or (c) reference repo paths and require the consumer to have them.

   **Lean toward (b)** — bundles are self-contained, templates ship alongside. Consistent with the "complete graphs only" principle.

3. **Streaming UI feedback.** For long generations (story, scene_video_prompt), the existing executor streams partial output to the desktop UI. The bundle architecture has no equivalent today. Either we add streaming callbacks to the runner contract, or accept that bundles are "fire and forget" with progress only on completion.

   **Lean toward "add later"** — proves the architecture without streaming first, adds streaming when desktop integration needs it.

4. **Cost telemetry.** Runner could emit `{ promptTokens, completionTokens, costUsd }` metadata. Useful for the NFR-3 cost estimator. Not blocking the runner but the metadata shape is worth pinning down now.

---

## Migration plan (when this lands)

1. **Build runner** (~1 day). Wrap existing `LLMClient` + `prompts/loader.ts`. Test against fixtures, no real project yet.
2. **Author a tiny test bundle** `bundles/llm_test_essence.json` that does only `plot → story → story_essence` with `llm.generate` runners. Run on the existing astronaut project. Compare output to what the executor would produce.
3. **Once parity verified**, build `comfy.image` (the next runner).
4. **Author `narrative_full.json`** — the full pipeline as a bundle. Run side-by-side against the existing executor on a real project. This is the parity bar.
5. **Deprecate the LLM-stage branches in `DependencyGraphExecutor`** only after step 4 passes for at least 3 different projects.

Estimated end-to-end: 3-5 days for the LLM half of the migration. The Klein/Z-Image half (`comfy.image` runner) is similar effort. Final assembly + state diff are smaller. Total bundle-takes-over-everything: ~7-10 days of focused work.

---

## Why this spec, not implementation, today

The astronaut comparison run is still in flight (Path B upstream completing as I write this). Once that lands and the A/B is documented, the bundle architecture has its quality validation locked in. Then this spec becomes the input to the next session's implementation. Spec-first keeps the work auditable and prevents the runner from drifting into "whatever I felt like building."
