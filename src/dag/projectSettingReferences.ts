import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { RunnerResult } from './schema.js';

type SettingReferenceStrategy =
  | 'explicit_id'
  | 'explicit_name'
  | 'filename'
  | 'single_reference_first_setting';

interface ProjectInputLike {
  id?: unknown;
  source?: {
    value?: unknown;
  };
  mediaType?: unknown;
  purpose?: unknown;
  metadata?: {
    originalFilename?: unknown;
    replacementSettingId?: unknown;
    replacementSettingName?: unknown;
    targetSettingId?: unknown;
    targetSettingName?: unknown;
  };
  processing?: {
    status?: unknown;
    localPath?: unknown;
  };
}

interface SettingCandidate {
  id: string;
  name: string;
}

interface SettingReferenceInput {
  inputId: string;
  localPath: string;
  absPath: string;
  originalFilename?: string;
  replacementSettingId?: string;
  replacementSettingName?: string;
}

export interface SettingReferenceBinding {
  inputId: string;
  settingId: string;
  sourceRel: string;
  sourceAbs: string;
  strategy: SettingReferenceStrategy;
  originalFilename?: string;
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function pathInsideProject(projectDir: string, candidate: string): { abs: string; rel: string } | null {
  const projectAbs = resolve(projectDir);
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(projectAbs, candidate);
  const rel = relative(projectAbs, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return { abs, rel: rel.replace(/\\/g, '/') };
}

function loadProjectInputs(projectDir: string): ProjectInputLike[] {
  const projectJsonPath = resolve(projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) return [];
  try {
    const project = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as { inputs?: unknown };
    return Array.isArray(project.inputs) ? (project.inputs as ProjectInputLike[]) : [];
  } catch {
    return [];
  }
}

function loadSettingCandidates(projectDir: string): SettingCandidate[] {
  const planPath = resolve(projectDir, 'plans', 'settings_plan.json');
  if (!existsSync(planPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as { settings?: unknown };
    if (!Array.isArray(parsed.settings)) return [];
    return parsed.settings
      .map((raw): SettingCandidate | null => {
        if (!raw || typeof raw !== 'object') return null;
        const record = raw as Record<string, unknown>;
        const id = safeString(record['id']);
        if (!id) return null;
        return { id, name: safeString(record['name']) ?? id };
      })
      .filter((candidate): candidate is SettingCandidate => Boolean(candidate));
  } catch {
    return [];
  }
}

function loadSettingReferenceInputs(projectDir: string): SettingReferenceInput[] {
  return loadProjectInputs(projectDir)
    .filter((input) => input.mediaType === 'image' && input.purpose === 'setting_ref')
    .filter((input) => input.processing?.status === undefined || input.processing.status === 'completed')
    .flatMap((input): SettingReferenceInput[] => {
      const localPath = safeString(input.processing?.localPath) ?? safeString(input.source?.value);
      if (!localPath) return [];
      const projectPath = pathInsideProject(projectDir, localPath);
      if (!projectPath || !existsSync(projectPath.abs)) return [];
      return [{
        inputId: safeString(input.id) ?? projectPath.rel,
        localPath: projectPath.rel,
        absPath: projectPath.abs,
        ...(safeString(input.metadata?.originalFilename)
          ? { originalFilename: safeString(input.metadata?.originalFilename) }
          : {}),
        ...(safeString(input.metadata?.replacementSettingId ?? input.metadata?.targetSettingId)
          ? { replacementSettingId: safeString(input.metadata?.replacementSettingId ?? input.metadata?.targetSettingId) }
          : {}),
        ...(safeString(input.metadata?.replacementSettingName ?? input.metadata?.targetSettingName)
          ? { replacementSettingName: safeString(input.metadata?.replacementSettingName ?? input.metadata?.targetSettingName) }
          : {}),
      }];
    });
}

function settingKeys(settingId: string, candidates: SettingCandidate[]): Set<string> {
  const keys = new Set<string>([normalizeKey(settingId)]);
  const match = candidates.find((candidate) => normalizeKey(candidate.id) === normalizeKey(settingId));
  if (match) {
    keys.add(normalizeKey(match.id));
    keys.add(normalizeKey(match.name));
  }
  return keys;
}

function filenameKeys(input: SettingReferenceInput): Set<string> {
  const values = [
    input.originalFilename,
    basename(input.localPath),
  ].filter((value): value is string => Boolean(value));
  return new Set(values.map((value) => normalizeKey(value)).filter(Boolean));
}

function pickUniqueMatch(
  refs: SettingReferenceInput[],
  strategy: SettingReferenceStrategy,
  predicate: (input: SettingReferenceInput) => boolean,
): { input: SettingReferenceInput; strategy: SettingReferenceStrategy } | null {
  const matches = refs.filter(predicate);
  return matches.length === 1 ? { input: matches[0]!, strategy } : null;
}

export function resolveSettingReferenceBinding(args: {
  projectDir: string;
  settingId: string;
}): SettingReferenceBinding | null {
  const refs = loadSettingReferenceInputs(args.projectDir);
  if (refs.length === 0) return null;

  const candidates = loadSettingCandidates(args.projectDir);
  const keys = settingKeys(args.settingId, candidates);

  const explicitId = pickUniqueMatch(
    refs,
    'explicit_id',
    (input) => safeString(input.replacementSettingId) !== undefined &&
      keys.has(normalizeKey(input.replacementSettingId!)),
  );
  if (explicitId) return toBinding(explicitId.input, args.settingId, explicitId.strategy);

  const explicitName = pickUniqueMatch(
    refs,
    'explicit_name',
    (input) => safeString(input.replacementSettingName) !== undefined &&
      keys.has(normalizeKey(input.replacementSettingName!)),
  );
  if (explicitName) return toBinding(explicitName.input, args.settingId, explicitName.strategy);

  const filename = pickUniqueMatch(
    refs,
    'filename',
    (input) => [...filenameKeys(input)].some((key) => keys.has(key)),
  );
  if (filename) return toBinding(filename.input, args.settingId, filename.strategy);

  const firstSetting = candidates[0];
  if (
    refs.length === 1 &&
    firstSetting &&
    normalizeKey(firstSetting.id) === normalizeKey(args.settingId)
  ) {
    return toBinding(refs[0]!, args.settingId, 'single_reference_first_setting');
  }

  return null;
}

function toBinding(
  input: SettingReferenceInput,
  settingId: string,
  strategy: SettingReferenceStrategy,
): SettingReferenceBinding {
  return {
    inputId: input.inputId,
    settingId,
    sourceRel: input.localPath,
    sourceAbs: input.absPath,
    strategy,
    ...(input.originalFilename ? { originalFilename: input.originalFilename } : {}),
  };
}

export function writeSettingReferenceBindingOutput(args: {
  projectDir: string;
  outputPath: string;
  binding: SettingReferenceBinding;
}): RunnerResult {
  const output = pathInsideProject(args.projectDir, args.outputPath);
  if (!output) {
    return { ok: false, error: `setting reference outputPath escapes project: ${args.outputPath}` };
  }
  const ext = extname(args.binding.sourceAbs).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
    return { ok: false, error: `unsupported setting reference image type: ${args.binding.sourceRel}` };
  }
  mkdirSync(dirname(output.abs), { recursive: true });
  copyFileSync(args.binding.sourceAbs, output.abs);
  return {
    ok: true,
    outputPath: output.rel,
    metadata: {
      generationTool: 'project.setting_reference',
      userSupplied: true,
      settingReference: {
        inputId: args.binding.inputId,
        sourcePath: args.binding.sourceRel,
        strategy: args.binding.strategy,
        ...(args.binding.originalFilename ? { originalFilename: args.binding.originalFilename } : {}),
      },
    },
  };
}
