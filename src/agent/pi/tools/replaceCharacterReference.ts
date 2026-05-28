import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { applyInvalidation } from "../../../core/planner/applyInvalidation.js";
import type { ExecutorState, ProjectFile } from "../../../core/project/projectTypes.js";
import {
  isAllowedReferenceImageFilename,
  uniqueFilename,
} from "../../../server/characterReferenceUploads.js";
import type { AssetInfo, ProjectInput } from "../../../tasks/video/workflow/types.js";
import { atomicWriteFileSync } from "../../../utils/atomicWrite.js";
import { getProjectsDir } from "../paths.js";
import { resolveProjectDir, ProjectDirNotFoundError } from "./resolveProjectDir.js";

const CHARACTER_UPLOAD_DIR = "assets/uploads/characters";
const REFERENCE_IMAGE_PURPOSES = new Set([
  "character_ref",
  "setting_ref",
  "reference_general",
]);

const Params = Type.Object({
  project: Type.String({ description: "Project name." }),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to the project folder. Pass when the host created the project outside the default projects directory.",
    }),
  ),
  character: Type.String({
    description:
      "Character name/id/alias to replace, e.g. 'Emna Aoyama', 'emna_aoyama', or 'female lead'.",
  }),
  referencePath: Type.String({
    description:
      "Project-relative or absolute path to the uploaded replacement image.",
  }),
});

export interface ReplaceCharacterReferenceDetails {
  status: "completed" | "failed";
  log: string;
  projectDir?: string;
  characterId?: string;
  characterName?: string;
  referencePath?: string;
  matchedShots: string[];
  invalidated: string[];
  notFound: string[];
}

type CharacterEntry = Record<string, unknown> & {
  id?: string;
  name?: string;
  referenceImageId?: string;
  referenceImagePath?: string;
};

type MutableProject = ProjectFile & {
  assets?: string[];
  characters?: CharacterEntry[];
  inputs?: ProjectInput[];
  executorState?: ExecutorState & { lastInvalidatedIds?: string[] };
  updatedAt?: number;
};

interface ResolvedCharacter {
  entry: CharacterEntry;
  id: string;
  name: string;
}

interface ResolvedReferencePath {
  relativePath: string;
  absolutePath: string;
  originalPath: string;
  originalFilename: string;
  mimeType?: string;
  size: number;
}

function failure(message: string): AgentToolResult<ReplaceCharacterReferenceDetails> {
  return {
    content: [{ type: "text", text: message }],
    details: {
      status: "failed",
      log: message,
      matchedShots: [],
      invalidated: [],
      notFound: [],
    },
  };
}

function posixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

function displayNameFromId(id: string): string {
  return id
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function safeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function mimeTypeForFilename(filename: string): string | undefined {
  const ext = extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return undefined;
}

function isInsideDirectory(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function projectRelativePath(projectDir: string, absolutePath: string): string | null {
  const rel = relative(resolve(projectDir), resolve(absolutePath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return posixPath(rel);
}

function characterSearchText(projectDir: string, entry: CharacterEntry): string {
  const id = typeof entry.id === "string" ? entry.id : "";
  const parts: string[] = [];
  for (const key of ["id", "name", "role", "description"]) {
    const value = entry[key];
    if (typeof value === "string") parts.push(value);
  }

  if (id) {
    const characterFile = join(projectDir, "characters", `${id}.md`);
    if (existsSync(characterFile)) {
      try {
        parts.push(readFileSync(characterFile, "utf-8"));
      } catch {
        // Ignore unreadable prose; project.json fields are still enough for exact matching.
      }
    }
  }

  return parts.join("\n");
}

function isFemaleAlias(query: string): boolean {
  const key = normalizeKey(query);
  return [
    "female",
    "femalelead",
    "femalecharacter",
    "girl",
    "girllead",
    "woman",
    "heroine",
    "leadgirl",
    "leadfemale",
  ].includes(key);
}

function isFemaleCharacterText(text: string): boolean {
  return /\b(girl|woman|female|heroine)\b/i.test(text);
}

function resolveCharacter(
  project: MutableProject,
  projectDir: string,
  query: string,
): ResolvedCharacter | { error: string } {
  const characters = (project.characters ?? [])
    .map((entry) => {
      const id = typeof entry.id === "string" && entry.id.trim()
        ? entry.id
        : typeof entry.name === "string"
          ? normalizeKey(entry.name)
          : "";
      if (!id) return null;
      return {
        entry,
        id,
        name:
          typeof entry.name === "string" && entry.name.trim()
            ? entry.name
            : displayNameFromId(id),
      };
    })
    .filter((entry): entry is ResolvedCharacter => entry !== null);

  if (characters.length === 0) {
    return { error: "No characters are registered in project.json." };
  }

  const queryKey = normalizeKey(query);
  const exact = characters.filter(
    (candidate) =>
      normalizeKey(candidate.id) === queryKey ||
      normalizeKey(candidate.name) === queryKey,
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    return {
      error: `Character '${query}' is ambiguous. Candidates: ${exact
        .map((candidate) => candidate.name)
        .join(", ")}.`,
    };
  }

  const partial = characters.filter((candidate) => {
    const idKey = normalizeKey(candidate.id);
    const nameKey = normalizeKey(candidate.name);
    return (
      queryKey.length >= 3 &&
      (idKey.includes(queryKey) || nameKey.includes(queryKey))
    );
  });
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    return {
      error: `Character '${query}' is ambiguous. Candidates: ${partial
        .map((candidate) => candidate.name)
        .join(", ")}.`,
    };
  }

  if (isFemaleAlias(query)) {
    const femaleCandidates = characters.filter((candidate) =>
      isFemaleCharacterText(characterSearchText(projectDir, candidate.entry)),
    );
    if (femaleCandidates.length === 1) return femaleCandidates[0]!;
    if (femaleCandidates.length > 1) {
      return {
        error: `Alias '${query}' is ambiguous. Candidates: ${femaleCandidates
          .map((candidate) => candidate.name)
          .join(", ")}.`,
      };
    }
  }

  return {
    error: `Character '${query}' was not found. Candidates: ${characters
      .map((candidate) => candidate.name)
      .join(", ")}.`,
  };
}

function resolveReferencePath(projectDir: string, referencePath: string): ResolvedReferencePath {
  const rawPath = referencePath.trim();
  if (!rawPath) throw new Error("referencePath is required.");

  const initialAbsolute = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(projectDir, rawPath);
  if (!existsSync(initialAbsolute) || !statSync(initialAbsolute).isFile()) {
    throw new Error(`Replacement reference image not found: ${referencePath}`);
  }
  if (!isAllowedReferenceImageFilename(initialAbsolute)) {
    throw new Error(`Unsupported replacement image type: ${referencePath}`);
  }

  const initialRelative = projectRelativePath(projectDir, initialAbsolute);
  const isAlreadyCharacterUpload =
    initialRelative?.startsWith(`${CHARACTER_UPLOAD_DIR}/`) ?? false;

  let finalAbsolute = initialAbsolute;
  let finalRelative = initialRelative;
  if (!isAlreadyCharacterUpload) {
    const targetDir = join(projectDir, CHARACTER_UPLOAD_DIR);
    mkdirSync(targetDir, { recursive: true });
    const finalName = uniqueFilename(targetDir, basename(initialAbsolute));
    finalAbsolute = join(targetDir, finalName);
    if (resolve(finalAbsolute) !== resolve(initialAbsolute)) {
      copyFileSync(initialAbsolute, finalAbsolute);
    }
    finalRelative = `${CHARACTER_UPLOAD_DIR}/${finalName}`;
  }

  if (!finalRelative || !isInsideDirectory(projectDir, finalAbsolute)) {
    throw new Error(`Replacement reference image must resolve inside the project: ${referencePath}`);
  }

  const stat = statSync(finalAbsolute);
  return {
    relativePath: posixPath(finalRelative),
    absolutePath: finalAbsolute,
    originalPath: initialAbsolute,
    originalFilename: basename(initialAbsolute),
    ...(mimeTypeForFilename(finalAbsolute) ? { mimeType: mimeTypeForFilename(finalAbsolute) } : {}),
    size: stat.size,
  };
}

function inputPath(input: ProjectInput): string | undefined {
  return posixPath(input.processing.localPath ?? input.source.value ?? "");
}

function upsertCharacterInput(args: {
  project: MutableProject;
  characterId: string;
  characterName: string;
  reference: ResolvedReferencePath;
  previousReferencePath?: string;
  now: number;
}): ProjectInput {
  const project = args.project;
  if (!Array.isArray(project.inputs)) project.inputs = [];
  const previous = args.previousReferencePath
    ? posixPath(args.previousReferencePath)
    : undefined;

  const existing =
    project.inputs.find(
      (input) =>
        input.mediaType === "image" &&
        REFERENCE_IMAGE_PURPOSES.has(input.purpose) &&
        input.metadata?.matchedCharacterId === args.characterId,
    ) ??
    project.inputs.find(
      (input) =>
        input.mediaType === "image" &&
        previous !== undefined &&
        inputPath(input) === previous,
    ) ??
    project.inputs.find(
      (input) =>
        input.mediaType === "image" &&
        inputPath(input) === args.reference.relativePath,
    );

  const input =
    existing ??
    ({
      id: uniqueInputId(project.inputs, args.characterId, args.now),
      source: {
        type: "local_path",
        value: args.reference.relativePath,
      },
      mediaType: "image",
      purpose: "character_ref",
      metadata: {
        addedAt: args.now,
      },
      processing: {
        status: "completed",
      },
      notes: "Uploaded from the desktop chat as a replacement character reference.",
    } as ProjectInput);

  input.source = {
    type: "local_path",
    value: args.reference.relativePath,
    originalValue: args.reference.originalPath,
  };
  input.mediaType = "image";
  input.purpose = "character_ref";
  input.metadata = {
    ...input.metadata,
    originalFilename: args.reference.originalFilename,
    ...(args.reference.mimeType ? { mimeType: args.reference.mimeType } : {}),
    fileSize: args.reference.size,
    addedAt: input.metadata?.addedAt ?? args.now,
    processedAt: args.now,
    referenceRole: "character",
    matchedCharacterId: args.characterId,
    matchedCharacterName: args.characterName,
    matchStrategy: "metadata",
  };
  input.processing = {
    ...input.processing,
    status: "completed",
    localPath: args.reference.relativePath,
  };
  input.notes = "Uploaded from the desktop chat as a replacement character reference.";

  if (!existing) project.inputs.push(input);

  for (const otherInput of project.inputs) {
    if (otherInput.id === input.id) continue;
    if (otherInput.metadata?.matchedCharacterId !== args.characterId) continue;
    delete otherInput.metadata.matchedCharacterId;
    delete otherInput.metadata.matchedCharacterName;
    delete otherInput.metadata.matchStrategy;
  }

  return input;
}

function uniqueInputId(inputs: ProjectInput[], characterId: string, now: number): string {
  const prefix = `character-ref-replacement-${now}-${safeToken(characterId)}`;
  let candidate = prefix;
  let counter = 2;
  const existing = new Set(inputs.map((input) => input.id));
  while (existing.has(candidate)) {
    candidate = `${prefix}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function replacementAssetId(
  character: ResolvedCharacter,
  input: ProjectInput,
): string {
  const existing = character.entry.referenceImageId;
  if (
    typeof existing === "string" &&
    existing.startsWith(`uploaded_charref_${safeToken(character.id)}`)
  ) {
    return existing;
  }
  return `uploaded_charref_${safeToken(character.id)}_${safeToken(input.id)}`;
}

function upsertManifestAsset(
  projectDir: string,
  asset: AssetInfo,
): void {
  const manifestPath = join(projectDir, "assets", "manifest.json");
  mkdirSync(join(projectDir, "assets"), { recursive: true });

  let manifest: { assets: AssetInfo[] } = { assets: [] };
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        assets?: AssetInfo[];
      };
      if (Array.isArray(parsed.assets)) manifest = { assets: parsed.assets };
    } catch {
      manifest = { assets: [] };
    }
  }

  const existingIndex = manifest.assets.findIndex((candidate) => candidate.id === asset.id);
  if (existingIndex >= 0) manifest.assets[existingIndex] = asset;
  else manifest.assets.push(asset);

  atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

function updateCharacterReference(args: {
  project: MutableProject;
  character: ResolvedCharacter;
  reference: ResolvedReferencePath;
  input: ProjectInput;
  assetId: string;
  now: number;
}): void {
  const assetMetadata = {
    source: "user_upload",
    inputId: args.input.id,
    originalFilename: args.reference.originalFilename,
    matchStrategy: "metadata",
    replacement: true,
  };

  args.character.entry.id = args.character.id;
  args.character.entry.name = args.character.name;
  args.character.entry["referenceImage"] = {
    path: args.reference.relativePath,
    createdAt: args.now,
    metadata: assetMetadata,
  };
  args.character.entry.referenceImageId = args.assetId;
  args.character.entry.referenceImagePath = args.reference.relativePath;

  if (!Array.isArray(args.project.assets)) args.project.assets = [];
  if (!args.project.assets.includes(args.assetId)) {
    args.project.assets.push(args.assetId);
  }

  const node = args.project.executorState?.nodes?.[`character_image:${args.character.id}`];
  if (node) {
    node.status = "completed";
    node.outputPath = args.reference.relativePath;
    node.error = undefined;
    node.startedAt = node.startedAt ?? args.now;
    node.completedAt = args.now;
    (node as typeof node & { artifactId?: string }).artifactId = args.assetId;
    node.metadata = {
      ...(node.metadata ?? {}),
      source: "user_upload",
      replacement: true,
    };
  }
}

function frameReferencesCharacter(frame: unknown, refId: string): boolean {
  if (!frame || typeof frame !== "object") return false;
  const references = (frame as { references?: unknown }).references;
  if (!Array.isArray(references)) return false;
  return references.some(
    (reference) =>
      reference &&
      typeof reference === "object" &&
      (reference as { refId?: unknown }).refId === refId,
  );
}

function promptHasVisibleCharacterRef(promptPath: string, refId: string): boolean {
  if (!existsSync(promptPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(promptPath, "utf-8")) as {
      frames?: Record<string, unknown>;
    };
    const frames = parsed.frames;
    if (!frames || typeof frames !== "object") return false;
    return Object.values(frames).some((frame) =>
      frameReferencesCharacter(frame, refId),
    );
  } catch {
    return false;
  }
}

function findVisibleShotIds(
  project: MutableProject,
  projectDir: string,
  characterNodeId: string,
): string[] {
  const nodes = project.executorState?.nodes ?? {};
  const matches: string[] = [];
  for (const node of Object.values(nodes)) {
    if (node.typeId !== "shot_image_prompt" || !node.itemId || !node.outputPath) {
      continue;
    }
    const promptPath = resolve(projectDir, node.outputPath);
    if (promptHasVisibleCharacterRef(promptPath, characterNodeId)) {
      matches.push(node.itemId);
    }
  }
  return [...new Set(matches)].sort((a, b) => a.localeCompare(b));
}

function invalidationSeedsForShots(
  project: MutableProject,
  shotIds: string[],
): string[] {
  const nodes = project.executorState?.nodes ?? {};
  const seeds: string[] = [];
  for (const shotId of shotIds) {
    const firstFrameId = `shot_image:${shotId}`;
    const lastFrameId = `shot_image_last_frame:${shotId}`;
    if (nodes[firstFrameId]) seeds.push(firstFrameId);
    if (nodes[lastFrameId]) seeds.push(lastFrameId);
  }
  return seeds;
}

export const dheeReplaceCharacterReference = defineTool({
  name: "dhee_replace_character_reference",
  label: "dhee replace character reference",
  description:
    "Replace an existing character reference image in a completed project, then invalidate only shot media whose saved shot image prompts visibly reference that character. Does not rewrite prompts or invalidate the character_image node.",
  parameters: Params,
  async execute(
    _id,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<ReplaceCharacterReferenceDetails>> {
    let projectDir: string;
    try {
      projectDir = resolveProjectDir({
        name: params.project,
        basePath: getProjectsDir(),
        ...(params.projectDir ? { projectDir: params.projectDir } : {}),
      });
    } catch (err) {
      if (err instanceof ProjectDirNotFoundError) return failure(err.message);
      throw err;
    }

    const projectJsonPath = join(projectDir, "project.json");
    if (!existsSync(projectJsonPath)) {
      return failure(`project.json not found in ${projectDir}`);
    }

    const project = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as MutableProject;
    if (!project.executorState || !project.executorState.nodes) {
      return failure("Cannot replace a character reference before the project has an executor graph.");
    }

    const character = resolveCharacter(project, projectDir, params.character);
    if ("error" in character) return failure(character.error);

    let reference: ResolvedReferencePath;
    try {
      reference = resolveReferencePath(projectDir, params.referencePath);
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }

    const now = Date.now();
    const input = upsertCharacterInput({
      project,
      characterId: character.id,
      characterName: character.name,
      reference,
      previousReferencePath:
        typeof character.entry.referenceImagePath === "string"
          ? character.entry.referenceImagePath
          : undefined,
      now,
    });
    const assetId = replacementAssetId(character, input);
    const asset: AssetInfo = {
      id: assetId,
      type: "character_ref",
      path: reference.relativePath,
      version: 1,
      createdAt: now,
      nodeId: `character_image:${character.id}`,
      metadata: {
        source: "user_upload",
        inputId: input.id,
        originalFilename: reference.originalFilename,
        matchStrategy: "metadata",
        replacement: true,
      },
    };
    upsertManifestAsset(projectDir, asset);
    updateCharacterReference({
      project,
      character,
      reference,
      input,
      assetId,
      now,
    });

    const characterNodeId = `character_image:${character.id}`;
    const matchedShots = findVisibleShotIds(project, projectDir, characterNodeId);
    const seeds = invalidationSeedsForShots(project, matchedShots);
    const invalidation =
      seeds.length > 0
        ? applyInvalidation(
            project as MutableProject & { executorState: ExecutorState & { lastInvalidatedIds?: string[] } },
            seeds,
            { cascade: true, cascadeOnlyCompleted: true },
          )
        : { invalidated: [], notFound: [] };

    project.updatedAt = now;
    atomicWriteFileSync(projectJsonPath, JSON.stringify(project, null, 2), "utf-8");

    const summary =
      `Replaced ${character.name} reference with ${reference.relativePath}. ` +
      (matchedShots.length > 0
        ? `Matched visible shots: ${matchedShots.join(", ")}. Invalidated ${invalidation.invalidated.length} node(s). Run dhee_run_to scope='last_invalidated' to regenerate them.`
        : "No visible shot prompt references matched this character, so no shot media was invalidated.");

    return {
      content: [{ type: "text", text: summary }],
      details: {
        status: "completed",
        log: summary,
        projectDir,
        characterId: character.id,
        characterName: character.name,
        referencePath: reference.relativePath,
        matchedShots,
        invalidated: invalidation.invalidated,
        notFound: invalidation.notFound,
      },
    };
  },
});
