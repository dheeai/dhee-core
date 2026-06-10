/**
 * dheeSystemPrompt — load the dhee agent's system prompt from the
 * packaged `skill/SKILL.md`.
 *
 * Why this exists: pi-coding-agent 0.70.6 only ever surfaces a loaded
 * skill's *body* to the model when the `read` builtin is in the tool
 * allowlist (it lists name + description + path and expects the agent
 * to read the file on demand). dhee removed `read` (replaced by the
 * project-scoped `dhee_read`, which refuses paths outside the project
 * dir), so the skill body never reached the model — the agent ran on
 * pi's stock "expert coding assistant" prompt instead of the dhee one.
 *
 * Fix: deliver the SKILL.md body directly as pi's system prompt via
 * `DefaultResourceLoader({ systemPromptOverride })` (see buildSession.ts).
 * SKILL.md stays the single source of truth — its frontmatter still
 * drives the skill listing; its body (frontmatter stripped) is the
 * always-on system prompt.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripFrontmatter } from '@mariozechner/pi-coding-agent';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The packaged skill markdown. In dev this is
 * `src/agent/pi/skill/SKILL.md`; in the tsup bundle the module is
 * inlined into `dist/index.js` (so `__dirname` is `dist/`) and tsup's
 * onSuccess copies the skill to `dist/skill/SKILL.md` — the same
 * relative layout, so this path resolves in both.
 */
const SKILL_MD_PATH = resolve(__dirname, 'skill', 'SKILL.md');

/**
 * Strip the YAML frontmatter off a SKILL.md and return the body that
 * becomes the system prompt. Pure (no fs) so it can be unit-tested.
 * Throws if stripping leaves nothing — an empty system prompt would
 * silently re-introduce the original bug.
 */
export function extractDheeSystemPrompt(rawSkillMd: string): string {
  const body = stripFrontmatter(rawSkillMd).trim();
  if (!body) {
    throw new Error(
      'dhee system prompt is empty after stripping SKILL.md frontmatter',
    );
  }
  return body;
}

let cached: string | undefined;

/**
 * The dhee system prompt body, read once from the packaged SKILL.md
 * and cached for the process lifetime.
 */
export function getDheeSystemPrompt(): string {
  if (cached === undefined) {
    cached = extractDheeSystemPrompt(readFileSync(SKILL_MD_PATH, 'utf-8'));
  }
  return cached;
}
