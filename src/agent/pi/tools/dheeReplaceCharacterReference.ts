/**
 * dhee_replace_character_reference — deterministic character image
 * replacement for desktop-uploaded reference images.
 *
 * The desktop composer imports selected images into the project before
 * prompting the agent. This tool takes that project-local image and
 * writes it into the current DAG's `character_image:<itemId>` output,
 * using the same writeNodeContent core as inspector edits so downstream
 * invalidation stays event-sourced and per-instance.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { writeNodeContent, type WriteNodeContentInput } from '../../../dag/writeNodeContent.js';
import type { DagBundle } from '../../../dag/schema.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the dhee project directory.' }),
  characterId: Type.Optional(
    Type.String({
      description:
        "Existing character item id to replace, e.g. 'emna_aoyama'. Prefer this when the UI provides an exact target.",
    }),
  ),
  character: Type.Optional(
    Type.String({
      description:
        "Existing character name/id to replace when characterId is not known, e.g. 'Emna Aoyama'.",
    }),
  ),
  referencePath: Type.String({
    description:
      'Project-relative path to the imported reference image. Absolute paths are accepted only when they resolve inside projectDir.',
  }),
});

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

interface CharacterCandidate {
  id: string;
  name: string;
}

export interface ReplaceCharacterReferenceDeps {
  loadBundleForProject?: (projectDir: string) => DagBundle;
  writeNodeContent?: (input: WriteNodeContentInput) => ReturnType<typeof writeNodeContent>;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function displayNameFromId(id: string): string {
  return id
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function candidateFromObject(value: Record<string, unknown>): CharacterCandidate | null {
  const id =
    safeString(value['id']) ??
    safeString(value['characterId']) ??
    safeString(value['character_id']) ??
    safeString(value['slug']) ??
    safeString(value['key']) ??
    safeString(value['name']);
  if (!id) return null;
  const name =
    safeString(value['name']) ??
    safeString(value['characterName']) ??
    safeString(value['character_name']) ??
    displayNameFromId(id);
  return { id, name };
}

function collectCandidates(value: unknown, out: CharacterCandidate[], seen: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, out, seen);
    return;
  }

  const objectValue = value as Record<string, unknown>;
  const candidate = candidateFromObject(objectValue);
  if (candidate) {
    const key = normalizeKey(candidate.id);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(candidate);
    }
  }

  for (const nested of Object.values(objectValue)) {
    if (nested && typeof nested === 'object') {
      collectCandidates(nested, out, seen);
    }
  }
}

function loadCharacterPlanCandidates(projectDir: string): CharacterCandidate[] {
  const planPath = join(projectDir, 'plans', 'characters_plan.json');
  if (!existsSync(planPath)) return [];
  const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as unknown;
  const candidates: CharacterCandidate[] = [];
  collectCandidates(parsed, candidates, new Set());
  return candidates;
}

function resolveCharacterItemId(args: {
  projectDir: string;
  characterId?: string;
  character?: string;
}): { itemId: string; displayName: string } | { error: string } {
  const candidates = loadCharacterPlanCandidates(args.projectDir);
  const query = args.characterId ?? args.character;
  if (!query || !query.trim()) {
    return { error: 'characterId or character is required.' };
  }

  if (candidates.length === 0) {
    return { itemId: query.trim(), displayName: displayNameFromId(query.trim()) };
  }

  const queryKey = normalizeKey(query);
  const exact = candidates.filter(
    (candidate) =>
      normalizeKey(candidate.id) === queryKey ||
      normalizeKey(candidate.name) === queryKey,
  );
  if (exact.length === 1) {
    const match = exact[0]!;
    return { itemId: match.id, displayName: match.name };
  }
  if (exact.length > 1) {
    return {
      error: `Character '${query}' is ambiguous. Candidates: ${exact.map((candidate) => candidate.name).join(', ')}.`,
    };
  }

  const partial = candidates.filter((candidate) => {
    const idKey = normalizeKey(candidate.id);
    const nameKey = normalizeKey(candidate.name);
    return queryKey.length >= 3 && (idKey.includes(queryKey) || nameKey.includes(queryKey));
  });
  if (partial.length === 1) {
    const match = partial[0]!;
    return { itemId: match.id, displayName: match.name };
  }
  if (partial.length > 1) {
    return {
      error: `Character '${query}' is ambiguous. Candidates: ${partial.map((candidate) => candidate.name).join(', ')}.`,
    };
  }

  return {
    error: `Character '${query}' was not found. Candidates: ${candidates.map((candidate) => candidate.name).join(', ')}.`,
  };
}

function resolveProjectLocalImage(projectDir: string, referencePath: string): { abs: string; rel: string } {
  const trimmed = referencePath.trim();
  if (!trimmed) throw new Error('referencePath is required.');

  const projectAbs = resolve(projectDir);
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectAbs, trimmed);
  const rel = relative(projectAbs, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Replacement reference image must resolve inside the project: ${referencePath}`);
  }
  if (!existsSync(abs)) {
    throw new Error(`Replacement reference image not found: ${referencePath}`);
  }
  const ext = extname(abs).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported replacement image type: ${referencePath}`);
  }
  return { abs, rel: rel.replace(/\\/g, '/') };
}

export function makeReplaceCharacterReferenceTool(deps: ReplaceCharacterReferenceDeps = {}) {
  return defineTool({
    name: 'dhee_replace_character_reference',
    label: 'Replace character reference',
    description:
      "Replace an existing character_image item with an uploaded project-local image, then invalidate only downstream DAG instances for that character. Use this for desktop character reference replacement flows before calling dhee_start_run once.",
    parameters: Params,
    async execute(_id, params) {
      if (!existsSync(params.projectDir)) {
        return textResult(`projectDir not found: ${params.projectDir}`, true);
      }

      let target: { itemId: string; displayName: string } | { error: string };
      try {
        target = resolveCharacterItemId({
          projectDir: params.projectDir,
          ...(params.characterId ? { characterId: params.characterId } : {}),
          ...(params.character ? { character: params.character } : {}),
        });
      } catch (err) {
        return textResult(`Failed to read character plan: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      if ('error' in target) return textResult(target.error, true);

      let image: { abs: string; rel: string };
      try {
        image = resolveProjectLocalImage(params.projectDir, params.referencePath);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }

      const input: WriteNodeContentInput = {
        projectDir: params.projectDir,
        nodeId: 'character_image',
        itemId: target.itemId,
        content: readFileSync(image.abs),
        reason: `Uploaded replacement character reference for ${target.displayName} from ${image.rel}`,
        confirm: true,
        ...(deps.loadBundleForProject ? { loadBundleForProject: deps.loadBundleForProject } : {}),
      };
      const result = (deps.writeNodeContent ?? writeNodeContent)(input);

      if (!result.ok) return textResult(result.error, true);
      if (result.status === 'preview') return textResult(result.preview);
      return textResult(
        `Replaced character reference for ${target.displayName} (${target.itemId}) with ${image.rel}. ${result.message}`,
      );
    },
  });
}

export const dheeReplaceCharacterReferenceTool = makeReplaceCharacterReferenceTool();
