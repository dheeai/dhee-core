import { existsSync } from 'fs';
import { basename, extname, isAbsolute, join, relative } from 'path';
import type { ProjectInput } from '../../tasks/video/workflow/types.js';

export type CharacterReferenceMatchStrategy = 'metadata' | 'filename' | 'ordered_fallback';

export interface CharacterReferenceTarget {
  id: string;
  itemId?: string;
  displayName?: string;
}

export interface UploadedCharacterReferenceMatch {
  input: ProjectInput;
  relativePath: string;
  originalFilename: string;
  characterId: string;
  characterName: string;
  matchStrategy: CharacterReferenceMatchStrategy;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function normalizeCharacterReferenceKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function characterIdForTarget(target: CharacterReferenceTarget): string | null {
  return target.itemId ?? target.id.split(':')[1] ?? null;
}

function characterNameForTarget(target: CharacterReferenceTarget): string {
  const suffix = target.displayName?.split(': ').pop()?.trim();
  if (suffix && suffix !== target.displayName) return suffix;
  const itemId = characterIdForTarget(target) ?? target.id;
  return itemId
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function keysForTarget(target: CharacterReferenceTarget): Set<string> {
  const keys = new Set<string>();
  const characterId = characterIdForTarget(target);
  if (characterId) keys.add(normalizeCharacterReferenceKey(characterId));
  const name = characterNameForTarget(target);
  if (name) keys.add(normalizeCharacterReferenceKey(name));
  keys.add(normalizeCharacterReferenceKey(target.id));
  if (target.displayName) keys.add(normalizeCharacterReferenceKey(target.displayName));
  keys.delete('');
  return keys;
}

function inputRelativePath(projectDir: string, input: ProjectInput): string | null {
  const rawPath = input.processing.localPath ?? input.source.value;
  if (!rawPath) return null;

  if (!isAbsolute(rawPath)) return rawPath;

  const rel = relative(projectDir, rawPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel;
}

interface Candidate {
  input: ProjectInput;
  relativePath: string;
  originalFilename: string;
  filenameKey: string;
  explicitKeys: Set<string>;
}

function eligibleCandidates(projectDir: string, inputs: ProjectInput[] | undefined): Candidate[] {
  return (inputs ?? []).flatMap((input) => {
    if (input.purpose !== 'character_ref') return [];
    if (input.mediaType !== 'image') return [];
    if (input.processing.status !== 'completed') return [];

    const relativePath = inputRelativePath(projectDir, input);
    if (!relativePath) return [];
    if (!IMAGE_EXTENSIONS.has(extname(relativePath).toLowerCase())) return [];
    if (!existsSync(join(projectDir, relativePath))) return [];

    const originalFilename = input.metadata.originalFilename ?? basename(relativePath);
    const metadata = input.metadata as ProjectInput['metadata'] & {
      characterId?: string;
      characterName?: string;
    };
    const explicitKeys = new Set(
      [
        metadata.matchedCharacterId,
        metadata.matchedCharacterName,
        metadata.characterId,
        metadata.characterName,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(normalizeCharacterReferenceKey),
    );

    return [{
      input,
      relativePath,
      originalFilename,
      filenameKey: normalizeCharacterReferenceKey(basename(originalFilename, extname(originalFilename))),
      explicitKeys,
    }];
  });
}

function buildMatch(
  target: CharacterReferenceTarget,
  candidate: Candidate,
  matchStrategy: CharacterReferenceMatchStrategy,
): UploadedCharacterReferenceMatch | null {
  const characterId = characterIdForTarget(target);
  if (!characterId) return null;
  return {
    input: candidate.input,
    relativePath: candidate.relativePath,
    originalFilename: candidate.originalFilename,
    characterId,
    characterName: characterNameForTarget(target),
    matchStrategy,
  };
}

export function matchUploadedCharacterReferences(args: {
  projectDir: string;
  inputs?: ProjectInput[];
  targets: CharacterReferenceTarget[];
}): Map<string, UploadedCharacterReferenceMatch> {
  const targets = args.targets.filter((target) => characterIdForTarget(target));
  const candidates = eligibleCandidates(args.projectDir, args.inputs);
  const assignments = new Map<string, UploadedCharacterReferenceMatch>();
  const assignedInputs = new Set<string>();

  const assign = (
    target: CharacterReferenceTarget,
    candidate: Candidate | undefined,
    strategy: CharacterReferenceMatchStrategy,
  ): void => {
    if (!candidate || assignments.has(target.id) || assignedInputs.has(candidate.input.id)) return;
    const match = buildMatch(target, candidate, strategy);
    if (!match) return;
    assignments.set(target.id, match);
    assignedInputs.add(candidate.input.id);
  };

  for (const target of targets) {
    const targetKeys = keysForTarget(target);
    assign(
      target,
      candidates.find(
        (candidate) =>
          !assignedInputs.has(candidate.input.id) &&
          candidate.explicitKeys.size > 0 &&
          [...candidate.explicitKeys].some((key) => targetKeys.has(key)),
      ),
      'metadata',
    );
  }

  for (const target of targets) {
    const targetKeys = keysForTarget(target);
    assign(
      target,
      candidates.find(
        (candidate) =>
          !assignedInputs.has(candidate.input.id) &&
          candidate.filenameKey.length > 0 &&
          [...targetKeys].some(
            (key) =>
              candidate.filenameKey === key ||
              (candidate.filenameKey.length >= 3 &&
                (candidate.filenameKey.includes(key) || key.includes(candidate.filenameKey))),
          ),
      ),
      'filename',
    );
  }

  for (const target of targets) {
    assign(
      target,
      candidates.find((candidate) => !assignedInputs.has(candidate.input.id)),
      'ordered_fallback',
    );
  }

  return assignments;
}

export function matchUploadedCharacterReferenceForTarget(args: {
  projectDir: string;
  inputs?: ProjectInput[];
  targets: CharacterReferenceTarget[];
  target: CharacterReferenceTarget;
}): UploadedCharacterReferenceMatch | null {
  return matchUploadedCharacterReferences(args).get(args.target.id) ?? null;
}
