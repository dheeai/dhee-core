/**
 * In-process project creator. Replaces the dev-only `pnpm new` shell-out
 * for hosts (pi-agent, packaged desktop) that don't have pnpm + tsx +
 * scripts/ available at runtime.
 *
 * The actual project-file scaffolding (folder structure, project.json,
 * template/phase wiring) lives in `tasks/video/workflow/ProjectManager`.
 * This module is the thin orchestration layer the CLI script also
 * implements: arg validation, style alias resolution, original_input
 * write, optional inputType override, title rewrite to match the
 * caller-supplied name.
 *
 * Used by:
 *   - pi-agent `dhee_new` tool (replaces runScript shell-out)
 *   - (future) HTTP endpoint or scripts/new-project.ts CLI
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setActiveProjectDir } from '../../tasks/video/workflow/activeProject.js';
import {
  createProject,
  setProjectInputType,
} from '../../tasks/video/workflow/ProjectManager.js';
import { initializeTemplates } from '../../templates/index.js';
import type { ProjectFile } from '../../tasks/video/workflow/types.js';
import type { InputType } from '../../tasks/video/workflow/types.js';

/**
 * Resolve user-friendly style aliases to canonical dhee style names.
 *
 *   live / live-action / realism / cinematic / photorealistic → cinematic_realism
 *   anime / animation / animated / cartoon / 2d → anime
 *
 * Mirrors `scripts/styleAlias.ts` so callers don't need to depend on
 * the scripts/ directory (which is absent from the packaged binary).
 */
export function resolveStyle(input: string): string | null {
  const lower = input.toLowerCase().trim();
  const liveAction = new Set([
    'live', 'live-action', 'live_action', 'liveaction',
    'realism', 'realistic', 'cinematic', 'cinematic_realism',
    'photorealistic', 'real',
  ]);
  const animation = new Set([
    'anime', 'animation', 'animated', 'cartoon', '2d', 'illustrated',
  ]);
  if (liveAction.has(lower)) return 'cinematic_realism';
  if (animation.has(lower)) return 'anime';
  return null;
}

export interface CreateProjectInProcessOpts {
  /** Folder will be `<basePath>/<name>.dhee`. */
  name: string;
  /** Story text or idea seeded into original_input.md. */
  input: string;
  /** Style alias (`live`, `anime`, etc) or canonical name. */
  style: string;
  /** Target video length in seconds. Required — no silent default. */
  duration: number;
  /** Where projects live. Defaults to the host's `getProjectsDir()` equivalent (caller passes it). */
  basePath: string;
  /** Template id (`narrative`, `infographic`, …). Defaults to `narrative`. */
  templateId?: string | undefined;
  /** Force input type, skipping content auto-detection. */
  inputType?: InputType | undefined;
  /**
   * Initialize into an existing project folder instead of creating one.
   *
   * The dhee-desktop new-project dialog pre-creates `<workspace>/<name>/`
   * with a stub `project.json`/asset manifest before the chat-embedded
   * wizard runs. With this flag, we treat the existing folder as the
   * target — the stub project.json is overwritten with dhee-core's
   * properly templated v2.0 file, and `original_input.md` is written
   * fresh. The folder name is used verbatim; no `.dhee` suffix is
   * appended.
   */
  existingDir?: string | undefined;
}

export interface CreateProjectInProcessResult {
  projectDir: string;
  project: ProjectFile;
  /** Canonical style after alias resolution, e.g. `cinematic_realism`. */
  resolvedStyle: string;
}

export class CreateProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreateProjectError';
  }
}

/**
 * Create a dhee project on disk in-process. Mirrors `pnpm new` but
 * callable from any host that has the dhee-core bundle loaded.
 *
 * Throws `CreateProjectError` for usage violations (unknown style,
 * non-positive duration, empty input, project already exists). Other
 * errors (fs failures, malformed templates) bubble up as-is.
 */
export function createProjectInProcess(
  opts: CreateProjectInProcessOpts,
): CreateProjectInProcessResult {
  // ── Validate inputs ──────────────────────────────────────────────
  if (!opts.name || !opts.name.trim()) {
    throw new CreateProjectError('Project name is required.');
  }
  if (!opts.input || !opts.input.trim()) {
    throw new CreateProjectError('Input content is required (story or idea).');
  }
  if (!Number.isFinite(opts.duration) || opts.duration <= 0) {
    throw new CreateProjectError(
      `Duration must be a positive number (got: ${opts.duration}).`,
    );
  }
  const canonicalStyle = resolveStyle(opts.style);
  if (!canonicalStyle) {
    throw new CreateProjectError(
      `Unknown style "${opts.style}". Pick one of: live, anime`,
    );
  }

  const projectDir = opts.existingDir ?? join(opts.basePath, `${opts.name}.dhee`);
  if (!opts.existingDir && existsSync(projectDir)) {
    throw new CreateProjectError(
      `Project directory already exists: ${projectDir}`,
    );
  }
  if (opts.existingDir && !existsSync(projectDir)) {
    throw new CreateProjectError(
      `existingDir was passed but the folder does not exist: ${projectDir}`,
    );
  }

  // ── Bootstrap ────────────────────────────────────────────────────
  // Without this the TemplateRegistry is empty and inputType detection
  // silently defaults to 'idea' for every project. Same defensive call
  // as scripts/new-project.ts.
  initializeTemplates();

  // setActiveProjectDir BEFORE createProject so it doesn't infer a name
  // from the input content. createProject reads getActiveProjectDir()
  // first; we need it to point at our chosen path.
  setActiveProjectDir(projectDir);

  mkdirSync(projectDir, { recursive: true });
  // Write the canonical input file. createProject will also write it
  // (via writeProjectText) but we want it present even if createProject
  // fails so the user can re-run without losing their input.
  writeFileSync(join(projectDir, 'original_input.md'), opts.input);

  // ── Build the project ────────────────────────────────────────────
  let project = createProject(
    opts.input,
    canonicalStyle,
    opts.basePath,
    opts.duration,
    opts.templateId,
  );

  // Optional inputType override (skip auto-detection).
  if (opts.inputType && opts.inputType !== project.inputType) {
    const updated = setProjectInputType(opts.inputType, opts.basePath);
    if (updated) project = updated;
  }

  // Override title to match the requested folder name. createProject
  // generates a title from input content (good for the UI), but the
  // user picked an explicit name — surface that.
  const projectJsonPath = join(projectDir, 'project.json');
  if (existsSync(projectJsonPath)) {
    try {
      const raw = readFileSync(projectJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed['title'] = opts.name;
      writeFileSync(projectJsonPath, JSON.stringify(parsed, null, 2));
      project.title = opts.name;
    } catch {
      // Title rewrite is cosmetic; project still works without it.
    }
  }

  return { projectDir, project, resolvedStyle: canonicalStyle };
}
