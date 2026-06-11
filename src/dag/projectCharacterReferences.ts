import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { RunnerResult } from './schema.js';

type CharacterReferenceStrategy =
  | 'explicit_id'
  | 'explicit_name'
  | 'filename'
  | 'single_reference_first_character';

interface ProjectInputLike {
  id?: unknown;
  source?: {
    value?: unknown;
  };
  mediaType?: unknown;
  purpose?: unknown;
  metadata?: {
    originalFilename?: unknown;
    replacementCharacterId?: unknown;
    replacementCharacterName?: unknown;
    targetCharacterId?: unknown;
    targetCharacterName?: unknown;
  };
  processing?: {
    status?: unknown;
    localPath?: unknown;
  };
}

interface CharacterCandidate {
  id: string;
  name: string;
}

interface CharacterReferenceInput {
  inputId: string;
  localPath: string;
  absPath: string;
  originalFilename?: string;
  replacementCharacterId?: string;
  replacementCharacterName?: string;
}

export interface CharacterReferenceBinding {
  inputId: string;
  characterId: string;
  sourceRel: string;
  sourceAbs: string;
  strategy: CharacterReferenceStrategy;
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

function loadCharacterCandidates(projectDir: string): CharacterCandidate[] {
  const planPath = resolve(projectDir, 'plans', 'characters_plan.json');
  if (!existsSync(planPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as { characters?: unknown };
    if (!Array.isArray(parsed.characters)) return [];
    return parsed.characters
      .map((raw): CharacterCandidate | null => {
        if (!raw || typeof raw !== 'object') return null;
        const record = raw as Record<string, unknown>;
        const id = safeString(record['id']);
        if (!id) return null;
        return { id, name: safeString(record['name']) ?? id };
      })
      .filter((candidate): candidate is CharacterCandidate => Boolean(candidate));
  } catch {
    return [];
  }
}

function loadCharacterReferenceInputs(projectDir: string): CharacterReferenceInput[] {
  return loadProjectInputs(projectDir)
    .filter((input) => input.mediaType === 'image' && input.purpose === 'character_ref')
    .filter((input) => input.processing?.status === undefined || input.processing.status === 'completed')
    .flatMap((input): CharacterReferenceInput[] => {
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
        ...(safeString(input.metadata?.replacementCharacterId ?? input.metadata?.targetCharacterId)
          ? { replacementCharacterId: safeString(input.metadata?.replacementCharacterId ?? input.metadata?.targetCharacterId) }
          : {}),
        ...(safeString(input.metadata?.replacementCharacterName ?? input.metadata?.targetCharacterName)
          ? { replacementCharacterName: safeString(input.metadata?.replacementCharacterName ?? input.metadata?.targetCharacterName) }
          : {}),
      }];
    });
}

function characterKeys(characterId: string, candidates: CharacterCandidate[]): Set<string> {
  const keys = new Set<string>([normalizeKey(characterId)]);
  const match = candidates.find((candidate) => normalizeKey(candidate.id) === normalizeKey(characterId));
  if (match) {
    keys.add(normalizeKey(match.id));
    keys.add(normalizeKey(match.name));
  }
  return keys;
}

function filenameKeys(input: CharacterReferenceInput): Set<string> {
  const values = [
    input.originalFilename,
    basename(input.localPath),
  ].filter((value): value is string => Boolean(value));
  return new Set(values.map((value) => normalizeKey(value)).filter(Boolean));
}

function pickUniqueMatch(
  refs: CharacterReferenceInput[],
  strategy: CharacterReferenceStrategy,
  predicate: (input: CharacterReferenceInput) => boolean,
): { input: CharacterReferenceInput; strategy: CharacterReferenceStrategy } | null {
  const matches = refs.filter(predicate);
  return matches.length === 1 ? { input: matches[0]!, strategy } : null;
}

export function resolveCharacterReferenceBinding(args: {
  projectDir: string;
  characterId: string;
}): CharacterReferenceBinding | null {
  const refs = loadCharacterReferenceInputs(args.projectDir);
  if (refs.length === 0) return null;

  const candidates = loadCharacterCandidates(args.projectDir);
  const keys = characterKeys(args.characterId, candidates);

  const explicitId = pickUniqueMatch(
    refs,
    'explicit_id',
    (input) => safeString(input.replacementCharacterId) !== undefined &&
      keys.has(normalizeKey(input.replacementCharacterId!)),
  );
  if (explicitId) return toBinding(explicitId.input, args.characterId, explicitId.strategy);

  const explicitName = pickUniqueMatch(
    refs,
    'explicit_name',
    (input) => safeString(input.replacementCharacterName) !== undefined &&
      keys.has(normalizeKey(input.replacementCharacterName!)),
  );
  if (explicitName) return toBinding(explicitName.input, args.characterId, explicitName.strategy);

  const filename = pickUniqueMatch(
    refs,
    'filename',
    (input) => [...filenameKeys(input)].some((key) => keys.has(key)),
  );
  if (filename) return toBinding(filename.input, args.characterId, filename.strategy);

  const firstCharacter = candidates[0];
  if (
    refs.length === 1 &&
    firstCharacter &&
    normalizeKey(firstCharacter.id) === normalizeKey(args.characterId)
  ) {
    return toBinding(refs[0]!, args.characterId, 'single_reference_first_character');
  }

  return null;
}

function toBinding(
  input: CharacterReferenceInput,
  characterId: string,
  strategy: CharacterReferenceStrategy,
): CharacterReferenceBinding {
  return {
    inputId: input.inputId,
    characterId,
    sourceRel: input.localPath,
    sourceAbs: input.absPath,
    strategy,
    ...(input.originalFilename ? { originalFilename: input.originalFilename } : {}),
  };
}

export function writeCharacterReferenceBindingOutput(args: {
  projectDir: string;
  outputPath: string;
  binding: CharacterReferenceBinding;
}): RunnerResult {
  const output = pathInsideProject(args.projectDir, args.outputPath);
  if (!output) {
    return { ok: false, error: `character reference outputPath escapes project: ${args.outputPath}` };
  }
  const ext = extname(args.binding.sourceAbs).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
    return { ok: false, error: `unsupported character reference image type: ${args.binding.sourceRel}` };
  }
  mkdirSync(dirname(output.abs), { recursive: true });
  copyFileSync(args.binding.sourceAbs, output.abs);
  return {
    ok: true,
    outputPath: output.rel,
    metadata: {
      generationTool: 'project.character_reference',
      userSupplied: true,
      characterReference: {
        inputId: args.binding.inputId,
        sourcePath: args.binding.sourceRel,
        strategy: args.binding.strategy,
        ...(args.binding.originalFilename ? { originalFilename: args.binding.originalFilename } : {}),
      },
    },
  };
}
