/**
 * Classify a JSON-output validation error so the executor can pick a
 * recovery path. Three classes:
 *
 *   - `truncated`  — the LLM hit max-tokens mid-output. The content
 *                    that exists is fine; what's MISSING is the issue.
 *                    Sending the partial bytes to `json_repair` is the
 *                    wrong move: repair has no scene-script, no
 *                    available_refs, no output-contract context, so it
 *                    just AUTHORS plausible filler to satisfy the
 *                    schema. We've seen Stage A's plan get turned into
 *                    `{ sceneTitle: "Default scene", shotPlan: [{...
 *                    "Default shot." }] }` by this path. Truncation
 *                    routes to a FULL retry — same prompt, full
 *                    context, hopefully fewer tokens (or a larger
 *                    budget) on the second attempt.
 *
 *   - `structural` — the JSON is mostly there but malformed in a
 *                    fix-able way: trailing comma, unquoted property,
 *                    schema-shape mismatch ("shots: Required"). The
 *                    `json_repair` LLM CAN plausibly patch these
 *                    without inventing content because the body is
 *                    largely intact.
 *
 *   - `semantic`   — the JSON parses and matches the schema but
 *                    violates a project rule (hallucinated refIds,
 *                    OTS-with-single-character, shotNumber mismatch).
 *                    Skip json_repair entirely — the syntax is fine,
 *                    only the content needs another roll. Goes to a
 *                    full retry with the validator's error injected
 *                    into the system prompt as corrective guidance.
 *
 * Pure — string in, label out.
 */

export type ValidationErrorClass = 'structural' | 'semantic' | 'truncated';

/**
 * Mid-output cutoff signatures. When ANY of these match, the upstream
 * output was definitely truncated and json_repair must NOT see it —
 * repair authors filler from broken input and corrupts the project.
 */
const TRUNCATION_PATTERNS: RegExp[] = [
  /Unexpected end of JSON/i,
  /Unterminated string/i,
];

/**
 * Patterns that indicate a JSON-syntax or schema-shape failure where
 * the content is largely intact and a syntax-repair pass can plausibly
 * help. Truncation is EXCLUDED — it has its own class above.
 */
const STRUCTURAL_PATTERNS: RegExp[] = [
  /^JSON parse error/i,
  /SyntaxError:/i,
  /Unexpected token/i,
  /Expected double-quoted property name/i,
  // Zod-level "field is missing" / "expected type X, received Y" —
  // these are about JSON SHAPE, which a structural fix can address.
  /: Required$/m,
  /^Required$/m,
  /Expected \w+, received \w+/i,
  /Invalid input/i,
  /must contain at least/i,
];

/**
 * Classify a validation error string.
 *
 * Defaults to 'semantic' for unrecognised errors. That's the safe
 * choice: a semantic classification skips one LLM call (json_repair)
 * and goes directly to the full retry — the retry still has the same
 * shot at fixing things, just one call cheaper.
 *
 * Truncation is checked BEFORE structural because the raw parser
 * tends to report "JSON parse error: Unexpected end of JSON input" —
 * the structural-error regex would match the prefix and route the
 * call to json_repair if we let it.
 */
export function classifyValidationError(error: string): ValidationErrorClass {
  if (!error) return 'semantic';
  for (const pattern of TRUNCATION_PATTERNS) {
    if (pattern.test(error)) return 'truncated';
  }
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (pattern.test(error)) return 'structural';
  }
  return 'semantic';
}

/**
 * Build the system-prompt suffix to use for a retry attempt.
 *
 *   - `structural`: short reminder that the output must be valid JSON.
 *     The schema in the system prompt is what guides the shape; the
 *     specific error usually isn't actionable for the model.
 *   - `semantic` and `truncated`: inject the validator's error message
 *     verbatim plus a short directive. Targeted guidance ("you forgot
 *     character X" / "your prior attempt was cut off — keep the
 *     description concise") beats "make sure it's valid JSON" every
 *     time.
 */
export function buildRetrySystemSuffix(
  errorClass: ValidationErrorClass,
  error: string,
): string {
  if (errorClass === 'structural') {
    return '\n\nCRITICAL: Your output MUST be valid JSON. Do not include markdown, backticks, or any text outside the JSON object.';
  }
  if (errorClass === 'truncated') {
    return `\n\nCRITICAL: Your previous attempt was CUT OFF mid-output (likely too long). The parser saw:\n\n${error}\n\nKeep each \`oneLineSummary\` / \`description\` field SHORT — under 120 characters. Do NOT pad with prose. Emit only the valid JSON object and STOP.`;
  }
  // Semantic — inject the error verbatim, plus a short directive to
  // address it specifically. The error messages from validators are
  // already user-facing prose (e.g. "No reference to any known
  // character / setting / object found in the imagePrompt or
  // references[]. Expected at least one of: character_image:protagonist.")
  // so they read well in the prompt.
  return `\n\nCRITICAL: Your previous attempt was REJECTED for the following reason — fix it and try again:\n\n${error}\n\nOutput ONLY valid JSON.`;
}
