/**
 * Markdown prompt loader with lightweight templating.
 *
 * Template syntax (subset, Claude-SDK style):
 * - {{var}}: string interpolation
 * - {{#if var}} ... {{/if}}: conditional block (truthy check)
 * - {{#if_eq var "value"}} ... {{else}} ... {{/if_eq}}: equality check with else support
 * - {{#each list}} ... {{/each}}: loop over array of objects
 *
 * Notes:
 * - This intentionally avoids bringing in external deps (no runtime install).
 * - Designed for system prompt and tool description composition from separate .md files.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir =
  typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));

function resolvePromptsDir(): string {
  const candidates = [
    // Bundled runtime: dist/server/index.cjs -> ../../prompts
    join(currentDir, '..', '..', 'prompts'),
    // Source/runtime from src/core/prompts -> ../../../prompts
    join(currentDir, '..', '..', '..', 'prompts'),
    // Fallback when launched from package root
    join(process.cwd(), 'prompts'),
  ];

  const resolved = candidates.find((candidate) => existsSync(candidate));
  return resolved ?? candidates[0]!;
}

const PROMPTS_DIR = resolvePromptsDir();

const templateCache = new Map<string, string>();

export type PromptContext = Record<string, unknown>;

export function loadMarkdown(relativePathFromPromptsDir: string): string {
  const filePath = join(PROMPTS_DIR, relativePathFromPromptsDir);
  if (!existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }
  const cached = templateCache.get(filePath);
  if (cached !== undefined) return cached;
  const content = readFileSync(filePath, 'utf-8');
  templateCache.set(filePath, content);
  return content;
}

function getPathValue(context: PromptContext, path: string): unknown {
  // Support dotted paths: a.b.c
  const parts = path.split('.').map(p => p.trim()).filter(Boolean);
  let cur: unknown = context;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function renderInterpolations(template: string, context: PromptContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = getPathValue(context, String(key));
    if (v === undefined || v === null) return '';
    return String(v);
  });
}

function renderIfBlocks(template: string, context: PromptContext): string {
  return template.replace(/\{\{#if\s+([a-zA-Z0-9_.-]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, key, body) => {
    const v = getPathValue(context, String(key));
    return v ? String(body) : '';
  });
}

/**
 * Find the matching closing tag for an opening tag, accounting for nesting.
 * Returns the index of the closing tag, or -1 if not found.
 */
function findMatchingClose(template: string, openTag: RegExp, closeTag: string, startIndex: number): number {
  let depth = 1;
  let i = startIndex;

  while (i < template.length && depth > 0) {
    // Check for closing tag first (longer match wins for ambiguous cases)
    if (template.slice(i).startsWith(closeTag)) {
      depth--;
      if (depth === 0) return i;
      i += closeTag.length;
      continue;
    }

    // Check for nested opening tag
    const remaining = template.slice(i);
    const openMatch = remaining.match(openTag);
    if (openMatch && openMatch.index === 0) {
      depth++;
      i += openMatch[0].length;
      continue;
    }

    i++;
  }

  return -1;
}

/**
 * Find the top-level {{else}} within a block body (not nested inside other blocks).
 */
function findTopLevelElse(body: string): number {
  let depth = 0;
  let i = 0;

  while (i < body.length) {
    // Check for any block-opening tags that might nest
    const remaining = body.slice(i);

    // Check for {{else}} at depth 0
    if (depth === 0 && remaining.startsWith('{{else}}')) {
      return i;
    }

    // Track nesting for {{#if ...}}
    if (remaining.match(/^\{\{#if\s/)) {
      depth++;
      i += 4; // Skip past "{{#i"
      continue;
    }
    if (remaining.match(/^\{\{#if_eq\s/)) {
      depth++;
      i += 7; // Skip past "{{#if_e"
      continue;
    }
    if (remaining.startsWith('{{/if}}')) {
      depth--;
      i += 7;
      continue;
    }
    if (remaining.startsWith('{{/if_eq}}')) {
      depth--;
      i += 10;
      continue;
    }

    i++;
  }

  return -1;
}

/**
 * Render {{#if_eq var "value"}} ... {{else}} ... {{/if_eq}} blocks.
 * Supports equality comparison with string literals and nested blocks.
 */
function renderIfEqBlocks(template: string, context: PromptContext): string {
  const openTagRegex = /\{\{#if_eq\s+([a-zA-Z0-9_.-]+)\s+"([^"]*)"\s*\}\}/;
  const closeTag = '{{/if_eq}}';

  let result = template;
  let match;

  // Process from left to right, handling one block at a time
  while ((match = result.match(openTagRegex)) !== null) {
    const fullOpenTag = match[0];
    const key = match[1];
    const compareValue = match[2];
    const openStart = match.index!;
    const bodyStart = openStart + fullOpenTag.length;

    // Find the matching close tag
    const closeStart = findMatchingClose(result, /\{\{#if_eq\s+[a-zA-Z0-9_.-]+\s+"[^"]*"\s*\}\}/, closeTag, bodyStart);
    if (closeStart === -1) {
      // No matching close tag found, skip this match to avoid infinite loop
      break;
    }

    const body = result.slice(bodyStart, closeStart);

    // Evaluate the condition
    const v = getPathValue(context, String(key));
    const actualValue = v === undefined || v === null ? '' : String(v);
    const isEqual = actualValue === compareValue;

    // Find top-level {{else}} in body
    const elseIndex = findTopLevelElse(body);
    let trueBranch: string;
    let falseBranch: string;

    if (elseIndex !== -1) {
      trueBranch = body.slice(0, elseIndex);
      falseBranch = body.slice(elseIndex + 8); // 8 = length of '{{else}}'
    } else {
      trueBranch = body;
      falseBranch = '';
    }

    const replacement = isEqual ? trueBranch : falseBranch;
    result = result.slice(0, openStart) + replacement + result.slice(closeStart + closeTag.length);
  }

  return result;
}

function renderEachBlocks(template: string, context: PromptContext): string {
  return template.replace(/\{\{#each\s+([a-zA-Z0-9_.-]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m, key, body) => {
    const v = getPathValue(context, String(key));
    if (!Array.isArray(v)) return '';
    return v
      .map(item => {
        const itemCtx: PromptContext =
          item && typeof item === 'object'
            ? { ...context, ...(item as Record<string, unknown>) }
            : { ...context, this: item };
        // Allow nested substitutions inside loop body
        return renderTemplate(String(body), itemCtx);
      })
      .join('');
  });
}

export function renderTemplate(template: string, context: PromptContext): string {
  // Order matters: render blocks first, then interpolations
  let out = template;
  out = renderEachBlocks(out, context);
  out = renderIfEqBlocks(out, context);  // Must come before renderIfBlocks
  out = renderIfBlocks(out, context);
  out = renderInterpolations(out, context);
  return out;
}

export function loadAndRenderMarkdown(relativePathFromPromptsDir: string, context: PromptContext): string {
  const template = loadMarkdown(relativePathFromPromptsDir);
  return renderTemplate(template, context);
}

export function clearPromptTemplateCache(): void {
  templateCache.clear();
}

// =============================================================================
// Remotion Skills Loading
// =============================================================================

export interface LoadRemotionSkillsOptions {
  /** If set, only load these rule files (without .md). Otherwise load all rules/*.md. */
  ruleSubset?: string[];
}

export function loadRemotionSkills(options?: LoadRemotionSkillsOptions): string {
  const skillsDir = join(PROMPTS_DIR, 'remotion-skills');
  if (!existsSync(skillsDir)) {
    return '';
  }
  const parts: string[] = [];
  const fundamentalsMd = join(skillsDir, 'REMOTION-FUNDAMENTALS.md');
  if (existsSync(fundamentalsMd)) {
    parts.push('## Remotion Fundamentals\n\n', readFileSync(fundamentalsMd, 'utf-8'));
  }
  const skillMd = join(skillsDir, 'SKILL.md');
  if (existsSync(skillMd)) {
    parts.push('\n## SKILL\n\n', readFileSync(skillMd, 'utf-8'));
  }
  const rulesDir = join(skillsDir, 'rules');
  if (!existsSync(rulesDir)) {
    return parts.join('');
  }
  const subset = options?.ruleSubset;
  let names: string[] = readdirSync(rulesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
  if (subset && subset.length > 0) {
    const set = new Set(subset);
    names = names.filter((n) => set.has(n));
  }
  names.sort();
  for (const name of names) {
    const p = join(rulesDir, `${name}.md`);
    if (existsSync(p)) {
      parts.push(`\n### rules/${name}.md\n\n`, readFileSync(p, 'utf-8'));
    }
  }
  return parts.join('');
}

// =============================================================================
// Content-Type Skill Loading
// =============================================================================

export interface SkillResolutionContext {
  providerId?: string;
  workflowName?: string;
}

/**
 * Build the list of candidate filenames for a content-type skill resolution.
 */
function buildSkillCandidates(contentType: string, context?: SkillResolutionContext): string[] {
  const candidates: string[] = [
    `${contentType}.md`,
  ];
  if (context?.providerId) {
    candidates.push(`${contentType}.${context.providerId}.md`);
    if (context.workflowName) {
      candidates.push(`${contentType}.${context.providerId}.${context.workflowName}.md`);
    }
  }
  return candidates;
}

interface LoadedSkillFile {
  filename: string;
  content: string;
}

/**
 * Load skill files from a single directory using the candidate filenames.
 * Returns array of loaded files with their filenames.
 */
function loadSkillsFromDir(dir: string, candidates: string[]): LoadedSkillFile[] {
  if (!existsSync(dir)) return [];
  const loaded: LoadedSkillFile[] = [];
  for (const filename of candidates) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      loaded.push({ filename, content: readFileSync(filePath, 'utf-8') });
    }
  }
  return loaded;
}

export interface ContentTypeSkillsResult {
  /** Concatenated skill content (empty string if none found). */
  content: string;
  /** Filenames of loaded skill files (for UI notifications). */
  loadedFiles: string[];
}

/**
 * Load content-type-specific skill files using a 3-level resolution convention.
 *
 * Looks for files under `prompts/skills/content-type/` in this order (additive):
 *   1. `{contentType}.md`                              — base skill
 *   2. `{contentType}.{providerId}.md`                 — provider-level
 *   3. `{contentType}.{providerId}.{workflowName}.md`  — most specific
 *
 * If `projectDir` is provided, also scans `{projectDir}/skills/content-type/`
 * using the same candidate filenames. Project-level skills are appended after
 * built-in skills (additive), allowing users to layer their own prompt guides.
 *
 * Missing files are silently skipped. Returns content and list of loaded filenames.
 */
export function loadContentTypeSkills(
  contentType: string,
  context?: SkillResolutionContext,
  projectDir?: string,
): ContentTypeSkillsResult {
  const candidates = buildSkillCandidates(contentType, context);

  // Load built-in skills from prompts/skills/content-type/
  const builtinDir = join(PROMPTS_DIR, 'skills', 'content-type');
  const loaded = loadSkillsFromDir(builtinDir, candidates);

  // Load project-level skills from {projectDir}/skills/content-type/
  if (projectDir) {
    const projectSkillDir = join(projectDir, 'skills', 'content-type');
    const projectLoaded = loadSkillsFromDir(projectSkillDir, candidates);
    for (const f of projectLoaded) {
      loaded.push({ filename: `project:${f.filename}`, content: f.content });
    }
  }

  return {
    content: loaded.map(f => f.content).join('\n\n'),
    loadedFiles: loaded.map(f => f.filename),
  };
}

/**
 * Resolve a prompt guide for a given guide name.
 *
 * The default guide (`prompts/skills/defaults/{guideName}.md`) is ALWAYS included
 * as the base layer — it contains universal rules (no narrative contamination,
 * photographic anchoring, etc.). If a more specific skill file exists, it is
 * appended after the default to layer model-specific guidance on top.
 *
 * Skill resolution order (most specific wins):
 *   1. Project-level: `{projectDir}/skills/content-type/{contentType}.{provider}.{workflow}.md`
 *   2. Built-in:      `prompts/skills/content-type/{contentType}.{provider}.{workflow}.md`
 *   3. Built-in:      `prompts/skills/content-type/{contentType}.{provider}.md`
 *   4. Built-in:      `prompts/skills/content-type/{contentType}.md`
 *
 * Returns: default guide + most specific skill (concatenated), or just default, or empty.
 */
export function resolveGuide(
  guideName: string,
  contentType: string,
  context?: SkillResolutionContext,
  projectDir?: string,
): { content: string; source: string } {
  // Always load the default guide as the base layer
  const defaultPath = join(PROMPTS_DIR, 'skills', 'defaults', `${guideName}.md`);
  const defaultContent = existsSync(defaultPath) ? readFileSync(defaultPath, 'utf-8') : '';

  // Try skill files (most specific first — reverse the candidates)
  const candidates = buildSkillCandidates(contentType, context).reverse();

  // Check project-level skills first
  if (projectDir) {
    const projectSkillDir = join(projectDir, 'skills', 'content-type');
    for (const filename of candidates) {
      const filePath = join(projectSkillDir, filename);
      if (existsSync(filePath)) {
        const skillContent = readFileSync(filePath, 'utf-8');
        const combined = defaultContent
          ? `${defaultContent}\n\n---\n\n${skillContent}`
          : skillContent;
        return { content: combined, source: `project:${filename}` };
      }
    }
  }

  // Check built-in skills
  const builtinDir = join(PROMPTS_DIR, 'skills', 'content-type');
  for (const filename of candidates) {
    const filePath = join(builtinDir, filename);
    if (existsSync(filePath)) {
      const skillContent = readFileSync(filePath, 'utf-8');
      const combined = defaultContent
        ? `${defaultContent}\n\n---\n\n${skillContent}`
        : skillContent;
      return { content: combined, source: filename };
    }
  }

  // No skill found — return default only
  if (defaultContent) {
    return { content: defaultContent, source: `default:${guideName}.md` };
  }

  return { content: '', source: 'none' };
}

export type InfographicType = 'bar_chart' | 'line_chart' | 'diagram' | 'statistic' | 'list';

export interface InfographicSkillSelection {
  content: string;
  selectedRules: string[];
  selectedExamples: string[];
}

const INFOGRAPHIC_GENERATION_GUARDRAILS = `
### dhee-required-infographic-guardrails

- NEVER render \`{prompt}\` or \`{infographicType}\` as visible text. Extract a short, meaningful title from the prompt topic and use \`data\` fields for display content.
- If \`data\` is provided and non-empty, render at least one label/value derived from \`data\`.
- Do not use CSS \`animation\`, \`transition\`, or \`@keyframes\`.
- Use Remotion frame-driven motion only: \`spring\`, \`interpolate\`, \`Sequence\`, \`Series\`, or \`TransitionSeries\`.
- Do not use remote URLs for assets.
- Do not use \`Math.random()\`; use deterministic Remotion patterns.
`.trim();

const BASE_INFOGRAPHIC_RULES = [
  'animations',
  'timing',
  'sequencing',
  'text-animations',
  'compositions',
];

const THREE_D_KEYWORDS = [
  '3d', 'extruded', 'depth', 'isometric', 'orbit', 'rotating', 'spatial', 'particle', 'particles',
];

const TRANSITION_HINT_KEYWORDS = [
  'step', 'steps', 'phase', 'phases', 'timeline', 'before', 'after',
  'sequence', 'stages', 'compare', 'comparison',
];

function hasAnyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
    return pattern.test(lower);
  });
}

function inferRulesForInfographicType(type: InfographicType, promptText: string): string[] {
  const selected = new Set<string>(BASE_INFOGRAPHIC_RULES);
  if (type === 'bar_chart' || type === 'line_chart') {
    selected.add('charts');
  }
  if ((type === 'list' || type === 'diagram') && hasAnyKeyword(promptText, TRANSITION_HINT_KEYWORDS)) {
    selected.add('transitions');
  }
  if (hasAnyKeyword(promptText, THREE_D_KEYWORDS)) {
    selected.add('3d');
  }
  return Array.from(selected).sort();
}

function inferExamplesForInfographicType(type: InfographicType, promptText: string): string[] {
  const selected = new Set<string>(['multi-beat-sequence']);
  if (type === 'bar_chart' || type === 'line_chart') {
    selected.add('3d-extruded-bar-chart');
    selected.add('data-story');
  }
  if (type === 'statistic') {
    selected.add('kinetic-typography');
    selected.add('cinematic-statistic');
  }
  if (type === 'list') {
    selected.add('transition-series-demo');
    selected.add('elegant-timeline');
  }
  if (type === 'diagram') {
    selected.add('elegant-timeline');
  }
  if (hasAnyKeyword(promptText, THREE_D_KEYWORDS)) {
    selected.add('3d-rotating-cube');
  }
  if (promptText.toLowerCase().includes('particle')) {
    selected.add('particle-effects');
  }
  if (hasAnyKeyword(promptText, ['milestone', 'achievement', 'growth', 'revenue', 'total', 'record'])) {
    selected.add('cinematic-statistic');
  }
  if (hasAnyKeyword(promptText, ['timeline', 'history', 'historical', 'treaty', 'era', 'century', 'year', 'date', 'chronolog'])) {
    selected.add('elegant-timeline');
  }
  return Array.from(selected).sort();
}

function loadRemotionExamples(exampleSubset: string[]): string {
  const examplesDir = join(PROMPTS_DIR, 'remotion-skills', 'examples');
  if (!existsSync(examplesDir) || exampleSubset.length === 0) {
    return '';
  }
  const parts: string[] = [];
  const selected = new Set(exampleSubset);
  let names = readdirSync(examplesDir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => f.slice(0, -4))
    .filter((name) => selected.has(name));
  names = names.sort();
  for (const name of names) {
    const p = join(examplesDir, `${name}.tsx`);
    if (existsSync(p)) {
      parts.push(`\n### examples/${name}.tsx\n\n`, readFileSync(p, 'utf-8'));
    }
  }
  return parts.join('');
}

/**
 * Load Remotion skills tailored to a specific infographic type.
 * Selects relevant rules and examples based on the type and prompt content.
 */
export function loadRemotionSkillsForInfographicType(
  type: InfographicType,
  promptText: string,
): InfographicSkillSelection {
  const selectedRules = inferRulesForInfographicType(type, promptText);
  const selectedExamples = inferExamplesForInfographicType(type, promptText);
  const skillsContent = loadRemotionSkills({ ruleSubset: selectedRules });
  const examplesContent = loadRemotionExamples(selectedExamples);
  const content = [skillsContent, examplesContent, INFOGRAPHIC_GENERATION_GUARDRAILS]
    .filter(Boolean)
    .join('\n\n');

  return {
    content,
    selectedRules,
    selectedExamples,
  };
}
