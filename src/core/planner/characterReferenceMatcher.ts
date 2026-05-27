import { existsSync } from 'fs';
import { basename, extname, isAbsolute, join, relative } from 'path';
import type { ProjectInput } from '../../tasks/video/workflow/types.js';

export type ReferenceMatchStrategy =
  | 'metadata'
  | 'filename'
  | 'ordered_fallback'
  | 'single_auto';
export type ReferenceTargetKind = 'character' | 'setting';
export type CharacterReferenceMatchStrategy = ReferenceMatchStrategy;

export interface CharacterReferenceTarget {
  id: string;
  itemId?: string;
  displayName?: string;
}

export interface UploadedReferenceTarget extends CharacterReferenceTarget {
  kind: ReferenceTargetKind;
}

export interface UploadedReferenceMatch {
  input: ProjectInput;
  relativePath: string;
  originalFilename: string;
  targetId: string;
  targetName: string;
  targetKind: ReferenceTargetKind;
  matchStrategy: ReferenceMatchStrategy;
}

export interface UploadedCharacterReferenceMatch extends UploadedReferenceMatch {
  characterId: string;
  characterName: string;
  targetKind: 'character';
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function normalizeCharacterReferenceKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function targetItemId(target: CharacterReferenceTarget): string | null {
  return target.itemId ?? target.id.split(':')[1] ?? null;
}

function targetDisplayName(target: CharacterReferenceTarget): string {
  const suffix = target.displayName?.split(': ').pop()?.trim();
  if (suffix && suffix !== target.displayName) return suffix;
  const itemId = targetItemId(target) ?? target.id;
  return itemId
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function keysForTarget(target: CharacterReferenceTarget): Set<string> {
  const keys = new Set<string>();
  const itemId = targetItemId(target);
  if (itemId) keys.add(normalizeCharacterReferenceKey(itemId));
  const name = targetDisplayName(target);
  if (name) keys.add(normalizeCharacterReferenceKey(name));
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
  purpose: ProjectInput['purpose'];
  explicitCharacterKeys: Set<string>;
  explicitSettingKeys: Set<string>;
}

function eligibleCandidates(projectDir: string, inputs: ProjectInput[] | undefined): Candidate[] {
  return (inputs ?? []).flatMap((input) => {
    if (
      input.purpose !== 'character_ref' &&
      input.purpose !== 'setting_ref' &&
      input.purpose !== 'reference_general'
    ) {
      return [];
    }
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
      settingId?: string;
      settingName?: string;
    };
    const explicitCharacterKeys = new Set(
      [
        metadata.matchedCharacterId,
        metadata.matchedCharacterName,
        metadata.characterId,
        metadata.characterName,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(normalizeCharacterReferenceKey),
    );
    const explicitSettingKeys = new Set(
      [
        metadata.matchedSettingId,
        metadata.matchedSettingName,
        metadata.settingId,
        metadata.settingName,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(normalizeCharacterReferenceKey),
    );

    return [{
      input,
      relativePath,
      originalFilename,
      filenameKey: normalizeCharacterReferenceKey(basename(originalFilename, extname(originalFilename))),
      purpose: input.purpose,
      explicitCharacterKeys,
      explicitSettingKeys,
    }];
  });
}

function candidateCanMatchTarget(
  candidate: Candidate,
  target: UploadedReferenceTarget,
): boolean {
  if (target.kind === 'character') {
    return candidate.purpose === 'character_ref' || candidate.purpose === 'reference_general';
  }
  return candidate.purpose === 'setting_ref' || candidate.purpose === 'reference_general';
}

function candidateIsTypedForTarget(
  candidate: Candidate,
  target: UploadedReferenceTarget,
): boolean {
  if (target.kind === 'character') return candidate.purpose === 'character_ref';
  return candidate.purpose === 'setting_ref';
}

function explicitKeysForTargetKind(
  candidate: Candidate,
  target: UploadedReferenceTarget,
): Set<string> {
  return target.kind === 'character'
    ? candidate.explicitCharacterKeys
    : candidate.explicitSettingKeys;
}

function filenameMatchesTarget(candidate: Candidate, target: UploadedReferenceTarget): boolean {
  if (candidate.filenameKey.length === 0) return false;
  const targetKeys = keysForTarget(target);
  return [...targetKeys].some(
    (key) =>
      candidate.filenameKey === key ||
      (candidate.filenameKey.length >= 3 &&
        (candidate.filenameKey.includes(key) || key.includes(candidate.filenameKey))),
  );
}

function buildReferenceMatch(
  target: UploadedReferenceTarget,
  candidate: Candidate,
  matchStrategy: ReferenceMatchStrategy,
): UploadedReferenceMatch | null {
  const id = targetItemId(target);
  if (!id) return null;
  return {
    input: candidate.input,
    relativePath: candidate.relativePath,
    originalFilename: candidate.originalFilename,
    targetId: id,
    targetName: targetDisplayName(target),
    targetKind: target.kind,
    matchStrategy,
  };
}

export function matchUploadedReferences(args: {
  projectDir: string;
  inputs?: ProjectInput[];
  targets: UploadedReferenceTarget[];
}): Map<string, UploadedReferenceMatch> {
  const targets = args.targets.filter((target) => targetItemId(target));
  const candidates = eligibleCandidates(args.projectDir, args.inputs);
  const assignments = new Map<string, UploadedReferenceMatch>();
  const assignedInputs = new Set<string>();

  const assign = (
    target: UploadedReferenceTarget,
    candidate: Candidate | undefined,
    strategy: ReferenceMatchStrategy,
  ): void => {
    if (!candidate || assignments.has(target.id) || assignedInputs.has(candidate.input.id)) return;
    if (!candidateCanMatchTarget(candidate, target)) return;
    const match = buildReferenceMatch(target, candidate, strategy);
    if (!match) return;
    assignments.set(target.id, match);
    assignedInputs.add(candidate.input.id);
  };

  for (const target of targets) {
    const targetKeys = keysForTarget(target);
    assign(
      target,
      candidates.find((candidate) => {
        if (assignedInputs.has(candidate.input.id)) return false;
        const explicitKeys = explicitKeysForTargetKind(candidate, target);
        return (
          explicitKeys.size > 0 &&
          [...explicitKeys].some((key) => targetKeys.has(key))
        );
      }),
      'metadata',
    );
  }

  for (const target of targets) {
    assign(
      target,
      candidates.find(
        (candidate) =>
          !assignedInputs.has(candidate.input.id) &&
          filenameMatchesTarget(candidate, target),
      ),
      'filename',
    );
  }

  for (const target of targets) {
    assign(
      target,
      candidates.find(
        (candidate) =>
          !assignedInputs.has(candidate.input.id) &&
          candidateIsTypedForTarget(candidate, target),
      ),
      'ordered_fallback',
    );
  }

  for (const candidate of candidates) {
    if (assignedInputs.has(candidate.input.id)) continue;
    if (candidate.purpose !== 'reference_general') continue;
    const plausibleTargets = targets.filter(
      (target) =>
        !assignments.has(target.id) &&
        candidateCanMatchTarget(candidate, target),
    );
    if (plausibleTargets.length === 1) {
      assign(plausibleTargets[0]!, candidate, 'single_auto');
    }
  }

  return assignments;
}

export function matchUploadedReferenceForTarget(args: {
  projectDir: string;
  inputs?: ProjectInput[];
  targets: UploadedReferenceTarget[];
  target: UploadedReferenceTarget;
}): UploadedReferenceMatch | null {
  return matchUploadedReferences(args).get(args.target.id) ?? null;
}

function asCharacterMatch(match: UploadedReferenceMatch | undefined): UploadedCharacterReferenceMatch | null {
  if (!match || match.targetKind !== 'character') return null;
  return {
    ...match,
    targetKind: 'character',
    characterId: match.targetId,
    characterName: match.targetName,
  };
}

export function matchUploadedCharacterReferences(args: {
  projectDir: string;
  inputs?: ProjectInput[];
  targets: CharacterReferenceTarget[];
}): Map<string, UploadedCharacterReferenceMatch> {
  const matches = matchUploadedReferences({
    projectDir: args.projectDir,
    inputs: args.inputs,
    targets: args.targets.map((target) => ({
      ...target,
      kind: 'character',
    })),
  });
  const characterMatches = new Map<string, UploadedCharacterReferenceMatch>();
  for (const [targetId, match] of matches) {
    const characterMatch = asCharacterMatch(match);
    if (characterMatch) characterMatches.set(targetId, characterMatch);
  }
  return characterMatches;
}

export function matchUploadedCharacterReferenceForTarget(args: {
  projectDir: string;
  inputs?: ProjectInput[];
  targets: CharacterReferenceTarget[];
  target: CharacterReferenceTarget;
}): UploadedCharacterReferenceMatch | null {
  return asCharacterMatch(
    matchUploadedReferenceForTarget({
      projectDir: args.projectDir,
      inputs: args.inputs,
      targets: args.targets.map((target) => ({
        ...target,
        kind: 'character',
      })),
      target: {
        ...args.target,
        kind: 'character',
      },
    }) ?? undefined,
  );
}
