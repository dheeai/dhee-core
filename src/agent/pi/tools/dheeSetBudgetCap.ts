/**
 * dhee_set_budget_cap — raise, lower, or clear a project's paid-spend
 * cap (`features.budgetCapUsd`) from chat.
 *
 * This is the action the agent takes when a run paused on the budget
 * backstop and the user says "raise it to $20" (or "turn the cap off").
 * The Settings UI only sets the GLOBAL DEFAULT for NEW projects — it
 * does NOT touch a project that has already paused. This tool edits the
 * live project so a `dhee_start_run` afterward resumes past the halt.
 *
 * Safe + scoped: it does a read-modify-write of ONLY
 * `features.budgetCapUsd`, preserving walkState / bundleSource /
 * everything else. It is the ONLY sanctioned way to change the cap
 * (dhee_set_project_field is restricted to bundle inputs and rejects
 * feature flags).
 *
 *   - capUsd > 0  → sets the cap to that many USD.
 *   - capUsd <= 0 → removes the cap entirely (the project runs uncapped).
 *
 * Changing the cap does NOT itself resume the run. After raising it,
 * call dhee_start_run to continue from where the walk paused (completed
 * work is cache-skipped; spend is seeded from the event log, so the new,
 * higher cap is what the walker checks against).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the dhee project directory.' }),
  capUsd: Type.Number({
    description:
      'The new paid-spend ceiling in USD for this project. A number > 0 sets the cap (e.g. 20 for $20). 0 (or negative) removes the cap entirely so the project runs uncapped. Only raise the cap on explicit user instruction.',
  }),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeSetBudgetCapTool() {
  return defineTool({
    name: 'dhee_set_budget_cap',
    label: 'Set budget cap',
    description:
      "Change THIS project's paid-spend cap (features.budgetCapUsd). Use it when a run paused on the budget backstop and the user asks to raise the cap (or turn it off). capUsd > 0 sets the cap; capUsd <= 0 removes it. This does NOT resume the run — call dhee_start_run afterward to continue past the halt. Only change the cap when the user explicitly asks; never raise it on your own to push a run through.",
    parameters: Params,
    async execute(_id, params) {
      const pjPath = join(params.projectDir, 'project.json');
      if (!existsSync(pjPath)) {
        return textResult(`project.json missing at ${pjPath}.`, true);
      }

      let pj: Record<string, unknown>;
      try {
        pj = JSON.parse(readFileSync(pjPath, 'utf8')) as Record<string, unknown>;
      } catch (e) {
        return textResult(`project.json is malformed: ${e instanceof Error ? e.message : String(e)}`, true);
      }

      const features =
        pj['features'] && typeof pj['features'] === 'object' && !Array.isArray(pj['features'])
          ? (pj['features'] as Record<string, unknown>)
          : {};

      const cap = params.capUsd;
      let message: string;
      if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) {
        features['budgetCapUsd'] = cap;
        message =
          `Budget cap for this project set to $${cap.toFixed(2)}. ` +
          `Call dhee_start_run to resume — the walk continues from where it paused (completed work is reused), ` +
          `and it will run until spend reaches the new cap.`;
      } else {
        // 0 / negative / non-finite → remove the cap (uncapped).
        delete features['budgetCapUsd'];
        message =
          `Budget cap removed — this project will now run uncapped. ` +
          `Call dhee_start_run to resume. (You can re-add a cap any time by calling this tool with a positive amount.)`;
      }

      pj['features'] = features;
      try {
        writeFileSync(pjPath, JSON.stringify(pj, null, 2), 'utf8');
      } catch (e) {
        return textResult(`Failed to write project.json: ${e instanceof Error ? e.message : String(e)}`, true);
      }

      return textResult(message);
    },
  });
}

export const dheeSetBudgetCapTool = makeSetBudgetCapTool();
