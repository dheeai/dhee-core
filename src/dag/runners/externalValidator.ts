/**
 * Pluggable post-generation validation for `llm.generate`.
 *
 * WHY THIS EXISTS. `llm.generate` already refuses to accept output it can prove
 * wrong: a JSON Schema failure and a `perItemEnums` id violation are both fed
 * back to the model and repaired by the retry loop. But a JSON Schema can only
 * state per-field facts. Every CROSS-FIELD rule — "shot start times must be
 * strictly increasing", "endTime must be <= duration", "a multi_cut scene needs
 * two shots", "exactWords must match a spokenLines entry" — is inexpressible,
 * so those rules ended up enforced in the RENDER runner instead, which is one
 * node too late: the authoring node has already succeeded and its output is
 * cached, so nothing can repair the document and the run just dies. Measured on
 * dhee-runner-minimax-h3: 36 distinct failure modes in one validator, ~12 of
 * them structurally impossible to express in JSON Schema.
 *
 * This closes that gap WITHOUT teaching the engine anything about any specific
 * bundle. A node names a validator; the engine imports it, runs it on the parsed
 * output, and treats a complaint exactly like a schema failure. The rule that a
 * renderer enforces and the rule the author is held to can now be THE SAME
 * FUNCTION, exported once by the runner that owns it and named by the bundle —
 * so the two cannot drift apart. That is the whole design goal: divergence
 * becomes impossible by construction rather than caught by a test afterwards.
 *
 * THE CONTRACT. `validateWith` is a module specifier in one of two forms:
 *
 *   "./validators/scene.mjs"      a path, resolved against the BUNDLE dir
 *   "dhee-runner-minimax-h3"      a package, resolved the way runners already are
 *
 * The package form is the one that matters — it lets the runner ship the
 * validator it also enforces at render time. The module must export `validate`
 * (or a default export) with the signature:
 *
 *   validate(value, info) => void | string | string[] | Promise<...>
 *
 * Returning nothing (or an empty array) means the document is good. Returning a
 * string, or an array of them, or throwing, means it is not — and the text is
 * handed straight back to the model, so write it as an instruction the model can
 * act on ("shots[1].startTime must be greater than shots[0].startTime"), not as
 * a stack trace.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** What a validator is told about the call it is judging. */
export interface ValidatorInfo {
  /** Collection item id, when the node is a collection. */
  itemId?: string;
  /** The node being generated. */
  nodeId: string;
  /** Absolute path to the bundle, for reading sibling schemas or fixtures. */
  bundleDir: string;
  /** Absolute path to the project, for reading a sibling node's output file. */
  projectDir: string;
}

export type ValidatorFn = (
  value: unknown,
  info: ValidatorInfo,
) => void | string | string[] | Promise<void | string | string[]>;

/**
 * Imported validators, keyed by resolved specifier. A collection node fans out
 * over every item and each item would otherwise re-import the same module; the
 * ESM loader caches internally too, but this keeps the resolve/branch cost off
 * the per-item path and makes the "loaded once" intent explicit.
 */
const validatorCache = new Map<string, ValidatorFn>();

/** A path (bundle-relative) rather than a bare package specifier? */
function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/**
 * Resolve and import `validateWith`. Throws with an actionable message when the
 * module is missing or exports the wrong shape — a validator that silently fails
 * to load would turn this feature into a no-op, which is worse than not having
 * it, because the pipeline would look protected while accepting anything.
 */
export async function loadValidator(specifier: string, bundleDir: string): Promise<ValidatorFn> {
  const cacheKey = isPathSpecifier(specifier) ? resolve(bundleDir, specifier) : specifier;
  const cached = validatorCache.get(cacheKey);
  if (cached) return cached;

  const target = isPathSpecifier(specifier) ? pathToFileURL(cacheKey).href : specifier;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(target)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `validateWith: cannot import '${specifier}'` +
        (isPathSpecifier(specifier) ? ` (resolved to ${cacheKey})` : ' (a package specifier — is the runner installed/symlinked?)') +
        ` — ${(err as Error).message}`,
    );
  }

  const fn = (mod['validate'] ?? mod['default']) as ValidatorFn | undefined;
  if (typeof fn !== 'function') {
    throw new Error(
      `validateWith: '${specifier}' must export a \`validate\` function (or a default export); ` +
        `got ${typeof fn}. Exports seen: ${Object.keys(mod).join(', ') || '(none)'}`,
    );
  }
  validatorCache.set(cacheKey, fn);
  return fn;
}

/**
 * Run a loaded validator and normalise every way it can complain into one
 * string, or null when the document passes.
 *
 * A THROW is treated as a complaint, not as a crash, and deliberately so: the
 * validators worth reusing here are the ones already written as assertions in a
 * render runner, and demanding they be rewritten to return values would be a
 * reason not to reuse them — which would defeat the point.
 */
export async function runValidator(
  fn: ValidatorFn,
  value: unknown,
  info: ValidatorInfo,
): Promise<string | null> {
  let result: void | string | string[];
  try {
    result = await fn(value, info);
  } catch (err) {
    return (err as Error).message || String(err);
  }
  if (!result) return null;
  const problems = (Array.isArray(result) ? result : [result]).filter((p) => typeof p === 'string' && p.trim());
  return problems.length ? problems.join('; ') : null;
}

/** Test seam: drop the module cache so a test can swap a validator. */
export function clearValidatorCache(): void {
  validatorCache.clear();
}
