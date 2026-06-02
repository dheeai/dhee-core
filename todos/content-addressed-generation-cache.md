# Content-Addressed Generation Cache — Replay Without Recompute

## Problem

The current cache is **path-based**: `llmGenerate.ts` and `comfyImage.ts` skip a
node when an output file already exists at `cfg.outputPath` (see the
`// ── Cache hit? ──` paths). `comfyLtxDirector.ts` even comments that it's a
"content-addressed cache (no upstream-change detection)" — i.e. it is *not*
keyed on inputs.

Two consequences fall out of this:

1. **A generation can only be found by its location, never by its inputs.**
   Change a prompt and re-run → the new artifact overwrites the same path. The
   prior generation is unrecoverable, and an identical request elsewhere
   (another project, another branch, a re-run) recomputes from scratch.
2. **Invalidation is structural, not content-aware.** `computeCascadeImpact()`
   knows what is *downstream* of a change, but not whether a downstream node's
   *resolved inputs actually changed*. So editing an upstream node forces a bad
   choice: invalidate everything downstream (destructive full recompute) **or**
   leave downstream artifacts stale and inconsistent with the change.

For a pipeline where ~80% of cost is GPU/model compute (image + video
generation), paying to recompute work whose inputs didn't change — or that was
already produced once — is the dominant waste.

## Feature

A **content-addressed store (CAS)** keyed on the *resolved inputs* of a node
invocation. Before running, the walker/runner computes a stable hash of
everything that determines the output; on a hit, it links/copies the cached
artifact instead of calling Comfy/LLM; on a miss, it runs and stores the result
under the hash. This makes any previously-produced generation reusable and
reproducible by its inputs — across re-runs, branches, and projects.

## Cache Key

```typescript
interface GenerationCacheKey {
  tool: string;              // runner tool name, e.g. 'comfy.image'
  toolVersion: string;       // runner version (semver) — bust cache on runner change
  inputsHash: string;        // sha256 of resolved inputs (FILE CONTENTS, not paths)
  configHash: string;        // sha256 of the node's runner.config block
  seed?: number | string;    // generation seed — REQUIRED in key for nondeterministic runners
}
// store key = sha256(stableStringify(GenerationCacheKey))
```

Critical correctness rules:

- **Hash input file *contents*, not paths.** The walker passes resolved inputs
  via `RunnerContext.inputs` (often file paths). Two different runs can have the
  same path with different bytes; hash the bytes.
- **Pin the seed into the key.** Generative models are nondeterministic — replay
  is only meaningful when the seed is fixed and part of the key. A node with a
  random/unpinned seed must either be pinned at first run (record the seed) or
  marked non-cacheable.
- **Version-bust on runner change.** `toolVersion` in the key so upgrading a
  runner doesn't serve stale artifacts.

## CAS Store

```typescript
interface GenerationCache {
  get(key: GenerationCacheKey): Promise<CacheEntry | null>;
  put(key: GenerationCacheKey, artifactPath: string, metadata: Record<string, unknown>): Promise<CacheEntry>;
}
interface CacheEntry {
  storePath: string;                       // absolute path in the CAS
  metadata: Record<string, unknown>;       // includes original model, seed, cost, timing
}
```

- Store lives outside any single project dir (so it's shared across projects),
  e.g. `~/.kshana/cache/<hash[0:2]>/<hash>.<ext>`.
- On hit: link (hardlink) or copy the artifact to the node's `outputPath` and
  return `{ ok: true, outputPath, metadata: { cached: true, ... } }` — the
  `metadata.cached` hook already exists in `walkState.ts`.
- Content-addressed ⇒ immutable entries, trivially safe to share/concurrent-read.

## Use Cases Unlocked (impossible today)

1. **Edit upstream, rebuild only what truly changed — consistently.** Change a
   character's hair color → only that character's shots recompute; every shot
   they're absent from is a cache hit. Today: destructive full recompute *or*
   stale inconsistency. (Requires the cache key to be content-aware so the
   walker can recompute exactly the nodes whose resolved inputs changed.)
2. **Cross-branch / cross-project reuse.** A reusable brand bundle run for 10
   customers renders shared infographic frames *once*. A forked timeline reuses
   its unchanged prefix for free. Today: every project/run recomputes from zero.
3. **Reproducibility / audit.** "Rebuild exactly this clip" returns the same
   artifact without recompute (seed-pinned). Today: re-runs re-roll; a result
   you loved is unreproducible the moment anything changes.
4. **(With fork/versions — see `non-destructive-fork-and-versions.md`) free
   replay of a forked prefix**, which is what makes affordable best-of-N at
   scale possible.

## Touch Points

- `src/dag/runners/llmGenerate.ts` — replace path-based skip with CAS lookup.
- `src/dag/runners/comfyImage.ts` — same.
- `src/dag/runners/comfyLtxDirector.ts` — same (it already flags the gap).
- **New:** `src/dag/cache/GenerationCache.ts` — the CAS + key hashing.
- `src/dag/walker.ts` (walker) — compute resolved-inputs hash at dispatch; pass
  to runner / consult cache; make invalidation content-aware (only recompute
  nodes whose key changed) rather than purely structural.

## Non-Goals (this doc)

- Versioning / forks / keeping multiple alternates — see
  `non-destructive-fork-and-versions.md` (concept ②).
- Full event-sourcing — separate, deferred.
- A network/shared remote cache — local CAS first; remote is a later extra.

## Open Questions

- Seed policy: auto-pin-on-first-run vs require bundles to declare a seed vs
  mark unpinned nodes non-cacheable. Default: pin-and-record at first run.
- Cache eviction / size cap for video artifacts (could grow large fast).
- How to hash "aggregate" inputs (lists of upstream items) stably.

## Estimated Effort

**~1–2 weeks.** Localized to the runner-invocation path + one new module; no
state-model or persistence-format change. Highest ROI of the concept-steal set
— do this first.
