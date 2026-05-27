import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { atomicWriteFileSync } from '../utils/atomicWrite.js';
import type { ProjectInput } from '../tasks/video/workflow/types.js';

export type ProjectReferenceImagePurpose =
  | 'character_ref'
  | 'setting_ref'
  | 'reference_general';
export type ProjectReferenceImageRole = 'auto' | 'character' | 'setting';

export interface StagedCharacterReferenceImage {
  name: string;
  path: string;
  url?: string;
  mimeType?: string;
  size?: number;
}

export interface StagedReferenceImage extends StagedCharacterReferenceImage {
  purpose?: ProjectReferenceImagePurpose;
  referenceRole?: ProjectReferenceImageRole;
}

export interface CopiedReferenceImage {
  /** Final project-local filename after sanitization/collision handling. */
  name: string;
  /** User-selected filename before any sanitization/collision handling. */
  originalFilename?: string;
  sourcePath: string;
  relativePath: string;
  purpose: ProjectReferenceImagePurpose;
  referenceRole: ProjectReferenceImageRole;
  mimeType?: string;
  size: number;
}

export interface CopiedCharacterReferenceImage extends CopiedReferenceImage {
  purpose: 'character_ref';
  referenceRole: 'character';
}

export interface ProjectLocalReferenceImage {
  /** Final project-local filename to show in prompts. */
  name: string;
  /** Durable project-relative path, e.g. assets/uploads/settings/field.png. */
  relativePath: string;
  purpose?: ProjectReferenceImagePurpose;
  referenceRole?: ProjectReferenceImageRole;
  /** Original user-selected absolute path, when available. */
  sourcePath?: string;
  /** User-selected filename before any sanitization/collision handling. */
  originalFilename?: string;
  mimeType?: string;
  size?: number;
}

export type ProjectLocalCharacterReferenceImage = Omit<
  ProjectLocalReferenceImage,
  'purpose' | 'referenceRole'
> & {
  purpose?: 'character_ref';
  referenceRole?: 'character';
};

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const CHARACTER_UPLOAD_DIR = 'assets/uploads/characters';
const SETTING_UPLOAD_DIR = 'assets/uploads/settings';
const GENERAL_REFERENCE_UPLOAD_DIR = 'assets/uploads/references';

export function isAllowedCharacterImageFilename(filename: string): boolean {
  return isAllowedReferenceImageFilename(filename);
}

export function isAllowedReferenceImageFilename(filename: string): boolean {
  return ALLOWED_IMAGE_EXTENSIONS.has(extname(filename).toLowerCase());
}

export function sanitizeUploadFilename(filename: string): string {
  const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return safeName || `upload-${Date.now()}`;
}

export function uniqueFilename(directory: string, filename: string): string {
  const safeName = sanitizeUploadFilename(filename);
  const ext = extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let candidate = safeName;
  let counter = 2;

  while (existsSync(join(directory, candidate))) {
    candidate = `${stem}-${counter}${ext}`;
    counter++;
  }

  return candidate;
}

function isInsideDirectory(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isReferenceRole(value: unknown): value is ProjectReferenceImageRole {
  return value === 'auto' || value === 'character' || value === 'setting';
}

function isReferencePurpose(value: unknown): value is ProjectReferenceImagePurpose {
  return (
    value === 'character_ref' ||
    value === 'setting_ref' ||
    value === 'reference_general'
  );
}

export function purposeForReferenceRole(
  role: ProjectReferenceImageRole,
): ProjectReferenceImagePurpose {
  if (role === 'character') return 'character_ref';
  if (role === 'setting') return 'setting_ref';
  return 'reference_general';
}

export function roleForReferencePurpose(
  purpose: ProjectReferenceImagePurpose | undefined,
): ProjectReferenceImageRole {
  if (purpose === 'character_ref') return 'character';
  if (purpose === 'setting_ref') return 'setting';
  return 'auto';
}

function normalizeReferenceRole(
  image: { purpose?: unknown; referenceRole?: unknown },
  fallback: ProjectReferenceImageRole = 'auto',
): ProjectReferenceImageRole {
  if (isReferenceRole(image.referenceRole)) return image.referenceRole;
  if (isReferencePurpose(image.purpose)) return roleForReferencePurpose(image.purpose);
  return fallback;
}

function uploadDirForRole(role: ProjectReferenceImageRole): string {
  if (role === 'character') return CHARACTER_UPLOAD_DIR;
  if (role === 'setting') return SETTING_UPLOAD_DIR;
  return GENERAL_REFERENCE_UPLOAD_DIR;
}

function sectionForPurpose(purpose: ProjectReferenceImagePurpose): string {
  if (purpose === 'character_ref') return 'Attached character reference images:';
  if (purpose === 'setting_ref') return 'Attached setting reference images:';
  return 'Attached reference images:';
}

function inputIdPrefixForPurpose(purpose: ProjectReferenceImagePurpose): string {
  if (purpose === 'character_ref') return 'character-ref';
  if (purpose === 'setting_ref') return 'setting-ref';
  return 'reference-image';
}

export function copyReferenceImagesToProject(args: {
  projectDir: string;
  stagedUploads?: StagedReferenceImage[];
  uploadsDir?: string;
}): CopiedReferenceImage[] {
  const uploads = args.stagedUploads ?? [];
  if (uploads.length === 0) return [];

  const uploadsDir = resolve(args.uploadsDir ?? join(process.cwd(), 'uploads'));

  return uploads.map((upload) => {
    if (!isAllowedReferenceImageFilename(upload.name)) {
      throw new Error(`Unsupported reference image type: ${upload.name}`);
    }

    const sourcePath = resolve(upload.path);
    if (!isInsideDirectory(uploadsDir, sourcePath)) {
      throw new Error(`Reference image is not in the upload staging directory: ${upload.name}`);
    }
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      throw new Error(`Reference image upload not found: ${upload.name}`);
    }

    const referenceRole = normalizeReferenceRole(upload);
    const purpose = purposeForReferenceRole(referenceRole);
    const uploadDir = uploadDirForRole(referenceRole);
    const targetDir = join(args.projectDir, uploadDir);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    const finalName = uniqueFilename(targetDir, upload.name);
    const destPath = join(targetDir, finalName);
    copyFileSync(sourcePath, destPath);

    const stat = statSync(destPath);
    return {
      name: finalName,
      originalFilename: upload.name,
      sourcePath,
      relativePath: `${uploadDir}/${finalName}`,
      purpose,
      referenceRole,
      ...(upload.mimeType ? { mimeType: upload.mimeType } : {}),
      size: upload.size ?? stat.size,
    };
  });
}

export function copyCharacterReferenceImagesToProject(args: {
  projectDir: string;
  stagedUploads?: StagedCharacterReferenceImage[];
  uploadsDir?: string;
}): CopiedCharacterReferenceImage[] {
  return copyReferenceImagesToProject({
    projectDir: args.projectDir,
    uploadsDir: args.uploadsDir,
    stagedUploads: (args.stagedUploads ?? []).map((upload) => ({
      ...upload,
      purpose: 'character_ref',
      referenceRole: 'character',
    })),
  }) as CopiedCharacterReferenceImage[];
}

function assertProjectLocalReference(
  projectDir: string,
  image: ProjectLocalReferenceImage,
  fallbackRole: ProjectReferenceImageRole = 'auto',
): CopiedReferenceImage {
  if (
    !isAllowedReferenceImageFilename(image.name) ||
    !isAllowedReferenceImageFilename(image.relativePath)
  ) {
    throw new Error(
      `Unsupported reference image type: ${image.name || image.relativePath}`,
    );
  }

  const absolutePath = resolve(projectDir, image.relativePath);
  const rel = relative(resolve(projectDir), absolutePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Reference image must be inside the project: ${image.relativePath}`,
    );
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(
      `Reference image not found in project: ${image.relativePath}`,
    );
  }

  const referenceRole = normalizeReferenceRole(image, fallbackRole);
  const stat = statSync(absolutePath);
  return {
    name: basename(image.relativePath),
    originalFilename: image.originalFilename ?? image.name,
    sourcePath: image.sourcePath ?? absolutePath,
    relativePath: image.relativePath.replace(/\\/g, '/'),
    purpose: purposeForReferenceRole(referenceRole),
    referenceRole,
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    size: image.size ?? stat.size,
  };
}

export function normalizeProjectLocalReferenceImages(args: {
  projectDir: string;
  images?: ProjectLocalReferenceImage[];
}): CopiedReferenceImage[] {
  return (args.images ?? []).map((image) =>
    assertProjectLocalReference(args.projectDir, image),
  );
}

export function normalizeProjectLocalCharacterReferenceImages(args: {
  projectDir: string;
  images?: ProjectLocalCharacterReferenceImage[];
}): CopiedCharacterReferenceImage[] {
  return (args.images ?? []).map((image) =>
    assertProjectLocalReference(
      args.projectDir,
      { ...image, purpose: 'character_ref', referenceRole: 'character' },
      'character',
    ),
  ) as CopiedCharacterReferenceImage[];
}

export function appendReferenceImagesToContent(
  content: string,
  images: CopiedReferenceImage[],
): string {
  if (images.length === 0) return content;

  const sections: string[] = [];
  const orderedPurposes: ProjectReferenceImagePurpose[] = [
    'character_ref',
    'setting_ref',
    'reference_general',
  ];
  for (const purpose of orderedPurposes) {
    const purposeImages = images.filter((image) => image.purpose === purpose);
    if (purposeImages.length === 0) continue;
    sections.push([
      sectionForPurpose(purpose),
      ...purposeImages.map((image) => `- ${image.name}: ${image.relativePath}`),
    ].join('\n'));
  }

  return `${content.trimEnd()}\n\n${sections.join('\n\n')}`;
}

export function appendCharacterReferenceImagesToContent(
  content: string,
  images: CopiedCharacterReferenceImage[],
): string {
  return appendReferenceImagesToContent(
    content,
    images.map((image) => ({
      ...image,
      purpose: 'character_ref',
      referenceRole: 'character',
    })),
  );
}

export function buildReferenceImageProjectInputs(
  images: CopiedReferenceImage[],
  now: number = Date.now(),
): ProjectInput[] {
  return images.map((image, index) => ({
    id: `${inputIdPrefixForPurpose(image.purpose)}-${now}-${index + 1}`,
    source: {
      type: 'local_path',
      value: image.relativePath,
      originalValue: image.sourcePath,
    },
    mediaType: 'image',
    purpose: image.purpose,
    metadata: {
      originalFilename: image.name,
      ...(image.originalFilename
        ? { originalFilename: image.originalFilename }
        : {}),
      ...(image.mimeType ? { mimeType: image.mimeType } : {}),
      fileSize: image.size,
      addedAt: now,
      processedAt: now,
      referenceRole: image.referenceRole,
    },
    processing: {
      status: 'completed',
      localPath: image.relativePath,
    },
    notes: 'Uploaded with the initial project prompt.',
  }));
}

export function buildCharacterReferenceProjectInputs(
  images: CopiedCharacterReferenceImage[],
  now: number = Date.now(),
): ProjectInput[] {
  return buildReferenceImageProjectInputs(
    images.map((image) => ({
      ...image,
      purpose: 'character_ref',
      referenceRole: 'character',
    })),
    now,
  );
}

export function addProjectLocalReferenceInputs(args: {
  projectDir: string;
  images?: ProjectLocalReferenceImage[];
  now?: number;
  notes?: string;
}): ProjectInput[] {
  const images = normalizeProjectLocalReferenceImages({
    projectDir: args.projectDir,
    images: args.images,
  });
  if (images.length === 0) return [];

  const projectJsonPath = join(args.projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) {
    throw new Error(`project.json not found at ${projectJsonPath}`);
  }

  const project = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as {
    inputs?: ProjectInput[];
    updatedAt?: number;
  };
  const existingInputs = Array.isArray(project.inputs) ? project.inputs : [];
  const existingPaths = new Set(
    existingInputs
      .map((input) => input.processing?.localPath ?? input.source?.value)
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      )
      .map((value) => value.replace(/\\/g, '/')),
  );

  const uniqueImages = images.filter(
    (image) => !existingPaths.has(image.relativePath),
  );
  if (uniqueImages.length === 0) return [];

  const added = buildReferenceImageProjectInputs(
    uniqueImages,
    args.now,
  ).map((input) => ({
    ...input,
    ...(args.notes ? { notes: args.notes } : {}),
  }));

  project.inputs = [...existingInputs, ...added];
  project.updatedAt = args.now ?? Date.now();
  atomicWriteFileSync(projectJsonPath, JSON.stringify(project, null, 2));
  return added;
}

export function addProjectLocalCharacterReferenceInputs(args: {
  projectDir: string;
  images?: ProjectLocalCharacterReferenceImage[];
  now?: number;
  notes?: string;
}): ProjectInput[] {
  return addProjectLocalReferenceInputs({
    ...args,
    images: (args.images ?? []).map((image) => ({
      ...image,
      purpose: 'character_ref',
      referenceRole: 'character',
    })),
  });
}
