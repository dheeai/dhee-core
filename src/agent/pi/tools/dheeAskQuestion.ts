/**
 * dhee_ask_question — UI-signal tool. Renders an inline question +
 * clickable option cards in the chat panel so the user picks instead
 * of typing. Same pattern as dhee_present_bundle_choices but generic
 * over any choice the agent wants to surface.
 *
 * When to use (and when NOT to):
 *
 *   USE:
 *     - "Which characters need new reference images?" (multi-select)
 *     - "Want to use Klein or Qwen for shot 3?" (single-select)
 *     - "Cinematic, anime, watercolor, noir?" (style picker)
 *     - "Run end-to-end now, or stop after the storyboard?" (path fork)
 *
 *   DON'T USE:
 *     - Open-ended creative requests ("describe the protagonist")
 *     - Yes/no the user can answer in a word (just ask in prose; one
 *       round trip via the picker is heavier than letting them type
 *       "yes")
 *
 * Server-side this is a no-op: the tool echoes its parameters back as
 * a structured payload. The desktop detects the tool_call by name and
 * renders the picker; the user's click becomes the next chatPrompt
 * (selected ids joined with ", " for multi-select).
 */
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

const OptionShape = Type.Object({
  id: Type.String({
    description:
      'Stable identifier the agent will see in the user\'s reply. Use a short slug (e.g. "klein", "skip", "yes"). The picker echoes the id(s) the user clicked back into chat.',
  }),
  label: Type.String({
    description:
      'Short display label for the card (e.g. "Klein", "Skip storyboard"). Up to ~30 chars; longer fits but wraps awkwardly.',
  }),
  description: Type.Optional(
    Type.String({
      description:
        'One-sentence subtitle (≤120 chars) shown under the label. Use to disambiguate options or set expectations ("Faster but less coherent", "Adds a manual review step").',
    }),
  ),
});

const Params = Type.Object({
  question: Type.String({
    description:
      'The single-sentence question rendered above the cards. End with a "?" so it reads as a prompt.',
  }),
  options: Type.Array(OptionShape, {
    description:
      'Ordered list of options the user can pick from. Order is preserved in the picker.',
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        'When true, the user can pick multiple options and confirms with a "Done" button. Default false (single-select; clicking an option immediately submits).',
    }),
  ),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeAskQuestionTool() {
  return defineTool({
    name: 'dhee_ask_question',
    label: 'Ask user question',
    description:
      'Surface a clickable picker for the user — single-select (default) or multi-select. Always prefer this over asking the question in text when the answer is a discrete choice: the user clicks instead of typing. Pass an `id` you can match against in the user\'s reply, a short `label` for the card, and optional `description`. Multi-select renders a "Done" confirmation button; the user\'s reply joins selected ids with ", ". Use sparingly — open-ended creative input should still be free-form. CRITICAL: calling this tool does NOT answer the question — it only posts the picker. After you call it, END YOUR TURN immediately: do not write more text, do not pick an option yourself, and do not take any action that assumes an answer. The user\'s click arrives as your next message; act only then.',
    parameters: Params,
    async execute(_id, params) {
      if (!params.question || !params.question.trim()) {
        return textResult('question is empty — provide a single-sentence prompt.', true);
      }
      if (!Array.isArray(params.options) || params.options.length === 0) {
        return textResult('options is empty — at least one option is required.', true);
      }
      const seen = new Set<string>();
      const normalized: Array<{ id: string; label: string; description?: string }> = [];
      for (const opt of params.options) {
        const id = typeof opt.id === 'string' ? opt.id.trim() : '';
        const label = typeof opt.label === 'string' ? opt.label.trim() : '';
        if (!id || !label) {
          return textResult(
            `Each option needs a non-empty id and label. Got: ${JSON.stringify(opt)}`,
            true,
          );
        }
        if (seen.has(id)) {
          return textResult(`Duplicate option id: ${id}. Ids must be unique within a question.`, true);
        }
        seen.add(id);
        normalized.push({
          id,
          label,
          ...(typeof opt.description === 'string' && opt.description.trim().length > 0
            ? { description: opt.description.trim() }
            : {}),
        });
      }
      const payload = {
        kind: 'question_choices' as const,
        question: params.question.trim(),
        options: normalized,
        multiSelect: params.multiSelect === true,
        // Directive read by the model from the tool result. The desktop
        // ignores unknown fields (it reads kind/question/options/
        // multiSelect only), but the model sees this and must STOP rather
        // than answer its own question — the turn-continuation bug where
        // it picked "skip" for the user instead of waiting.
        _agentDirective:
          'QUESTION POSTED to the user as a clickable picker. END YOUR TURN NOW. Do NOT answer this question yourself, do NOT call more tools, do NOT take any action that assumes a choice. Wait for the user — their selection arrives as your next message.',
      };
      return textResult(JSON.stringify(payload));
    },
  });
}

export const dheeAskQuestionTool = makeAskQuestionTool();
