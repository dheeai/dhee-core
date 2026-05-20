/**
 * Session role.
 *
 * Originally introduced to strip long-running tools from interactive
 * sessions, on the (mistaken) assumption that any dhee_run_to
 * call meant a multi-hour full-pipeline run. In reality dhee_run_to
 * is also used for many shorter operations (running to a single
 * stage, a single shot, etc.), and dhee_regen / dhee_render_*
 * are similarly "long-ish but legitimate from chat" jobs. Stripping
 * them broke the user's natural-language workflow.
 *
 * The current implementation is a no-op pass-through (every session
 * gets every tool) until we replace it with a proper background
 * task runner — see the architecture note in the chat panel header
 * comments. We keep the type + helper around so the upcoming
 * refactor (dispatch-style tools that delegate to the runner) has a
 * clean integration point.
 */

export type SessionRole = 'interactive' | 'background';

interface NamedTool {
  name: string;
}

export function selectToolsForRole<T extends NamedTool>(
  tools: ReadonlyArray<T>,
  _role: SessionRole | undefined,
): T[] {
  return [...tools];
}
