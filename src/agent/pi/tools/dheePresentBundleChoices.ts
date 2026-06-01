/**
 * dhee_present_bundle_choices — UI-signal tool.
 *
 * Server-side, this tool is mostly a no-op: it echoes its `bundleIds`
 * (deduped) + optional `question` back to the caller. The real work
 * happens in the desktop: when it sees a tool_call event with this
 * tool name, the chat panel renders the bundleIds as a row of
 * clickable cards. Clicking a card sends `Use <bundleId>` to the
 * agent as the next chatPrompt.
 *
 * Why a tool and not a chat-text convention? Because text parsing is
 * fragile and the bundle-pick decision is structurally important.
 * Making it a typed tool means the desktop can detect it reliably
 * and the agent can't accidentally hide the picker by forgetting a
 * markdown convention.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { getBundleSearchRoots } from '../../../dag/bundleSource.js';
import { titleizeBundleId, summaryOf } from '../../../dag/bundleDisplay.js';

const Params = Type.Object({
  bundleIds: Type.Array(
    Type.String({
      description: 'Bundle id from the dhee_list_bundles catalog (no "built-in:" prefix).',
    }),
    {
      description:
        'Ordered list of bundles to offer to the user. The desktop renders one card per id. Order is preserved.',
    },
  ),
  question: Type.Optional(
    Type.String({
      description:
        'Short, single-sentence prompt rendered above the cards. Defaults to "Which one do you want for this project?"',
    }),
  ),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

interface BundleMeta {
  id: string;
  displayName: string;
  summary: string;
}

/**
 * Look up a bundle's display metadata across the search roots. Mirrors
 * resolveBundleDir precedence — USER fork shadows APP shipped default.
 * Returns a meta with fallback fields filled in even when bundle.json
 * is missing or unreadable, so the picker always has SOMETHING to show
 * (titleized id + empty summary).
 */
function lookupBundleMeta(id: string): BundleMeta {
  const fallback: BundleMeta = { id, displayName: titleizeBundleId(id), summary: '' };
  for (const root of getBundleSearchRoots()) {
    const candidates = [join(root, id, 'bundle.json'), join(root, `${id}.json`)];
    for (const path of candidates) {
      try {
        if (!existsSync(path)) continue;
        if (!statSync(path).isFile()) continue;
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
          displayName?: string;
          summary?: string;
          description?: string;
        };
        const displayName =
          typeof parsed.displayName === 'string' && parsed.displayName.trim().length > 0
            ? parsed.displayName.trim()
            : titleizeBundleId(id);
        const summary = summaryOf({
          ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        });
        return { id, displayName, summary };
      } catch {
        // continue to next candidate / root
      }
    }
  }
  return fallback;
}

export function makePresentBundleChoicesTool() {
  return defineTool({
    name: 'dhee_present_bundle_choices',
    label: 'Present bundle choices',
    description:
      'Surface a clickable picker for the user to pick a bundle. Call this AFTER dhee_list_bundles when you want the user to choose. Pass the bundle ids you want offered. The desktop renders one clickable card per id; the user\'s click becomes their next chat message. Calling this tool does NOT pick a bundle on its own — wait for the user\'s reply.',
    parameters: Params,
    async execute(_id, params) {
      if (!Array.isArray(params.bundleIds) || params.bundleIds.length === 0) {
        return textResult('bundleIds is empty — at least one bundle is required to render the picker.', true);
      }
      const dedup: string[] = [];
      for (const id of params.bundleIds) {
        if (typeof id !== 'string' || id.length === 0) {
          return textResult(`bundleIds contains non-string or empty entry: ${JSON.stringify(id)}.`, true);
        }
        if (!dedup.includes(id)) dedup.push(id);
      }
      const bundles: BundleMeta[] = dedup.map((id) => lookupBundleMeta(id));
      const payload = {
        kind: 'bundle_choices' as const,
        // Keep `bundleIds` for back-compat with any consumer that
        // hasn't migrated; new `bundles` array carries the rich
        // metadata the picker uses to render display name + summary.
        bundleIds: dedup,
        bundles,
        ...(params.question ? { question: params.question } : {}),
      };
      return textResult(JSON.stringify(payload));
    },
  });
}

export const dheePresentBundleChoicesTool = makePresentBundleChoicesTool();
