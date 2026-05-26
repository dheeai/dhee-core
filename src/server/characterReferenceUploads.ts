import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { atomicWriteFileSync } from '../utils/atomicWrite.js';
import type { ProjectInput } from '../tasks/video/workflow/types.js';

export interface StagedCharacterReferenceImage {
  name: string;
  path: string;
  url?: string;
  mimeType?: string;
  size?: number;
}

export interface CopiedCharacterReferenceImage {
  /** Final project-local filename after sanitization/collision handling. */
  name: string;
  /** User-selected filename before any sanitization/collision handling. */
  originalFilename?: string;
  sourcePath: string;
  relativePath: string;
  mimeType?: string;
  size: number;
}

export interface ProjectLocalCharacterReferenceImage {
  /** Final project-local filename to show in prompts. */
  name: string;
  /** Durable project-relative path, e.g. assets/uploads/characters/hero.png. */
  relativePath: string;
  /** Original user-selected absolute path, when available. */
  sourcePath?: string;
  /** User-selected filename before any sanitization/collision handling. */
  originalFilename?: string;
  mimeType?: string;
  size?: number;
}

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const CHARACTER_UPLOAD_DIR = 'assets/uploads/characters';

export function isAllowedCharacterImageFilename(filename: string): boolean {
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

export function copyCharacterReferenceImagesToProject(args: {
  projectDir: string;
  stagedUploads?: StagedCharacterReferenceImage[];
  uploadsDir?: string;
}): CopiedCharacterReferenceImage[] {
  const uploads = args.stagedUploads ?? [];
  if (uploads.length === 0) return [];

  const uploadsDir = resolve(args.uploadsDir ?? join(process.cwd(), 'uploads'));
  const targetDir = join(args.projectDir, CHARACTER_UPLOAD_DIR);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  return uploads.map((upload) => {
    if (!isAllowedCharacterImageFilename(upload.name)) {
      throw new Error(`Unsupported character reference image type: ${upload.name}`);
    }

    const sourcePath = resolve(upload.path);
    if (!isInsideDirectory(uploadsDir, sourcePath)) {
      throw new Error(`Character reference image is not in the upload staging directory: ${upload.name}`);
    }
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      throw new Error(`Character reference image upload not found: ${upload.name}`);
    }

    const finalName = uniqueFilename(targetDir, upload.name);
    const destPath = join(targetDir, finalName);
    copyFileSync(sourcePath, destPath);

    const stat = statSync(destPath);
    return {
      name: finalName,
      originalFilename: upload.name,
      sourcePath,
      relativePath: `${CHARACTER_UPLOAD_DIR}/${finalName}`,
      ...(upload.mimeType ? { mimeType: upload.mimeType } : {}),
      size: upload.size ?? stat.size,
    };
  });
}

function assertProjectLocalCharacterReference(
  projectDir: string,
  image: ProjectLocalCharacterReferenceImage,
): CopiedCharacterReferenceImage {
  if (
    !isAllowedCharacterImageFilename(image.name) ||
    !isAllowedCharacterImageFilename(image.relativePath)
  ) {
    throw new Error(
      `Unsupported character reference image type: ${image.name || image.relativePath}`,
    );
  }

  const absolutePath = resolve(projectDir, image.relativePath);
  const rel = relative(resolve(projectDir), absolutePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Character reference image must be inside the project: ${image.relativePath}`,
    );
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(
      `Character reference image not found in project: ${image.relativePath}`,
    );
  }

  const stat = statSync(absolutePath);
  return {
    name: basename(image.relativePath),
    originalFilename: image.originalFilename ?? image.name,
    sourcePath: image.sourcePath ?? absolutePath,
    relativePath: image.relativePath.replace(/\\/g, '/'),
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    size: image.size ?? stat.size,
  };
}

export function normalizeProjectLocalCharacterReferenceImages(args: {
  projectDir: string;
  images?: ProjectLocalCharacterReferenceImage[];
}): CopiedCharacterReferenceImage[] {
  return (args.images ?? []).map((image) =>
    assertProjectLocalCharacterReference(args.projectDir, image),
  );
}

export function appendCharacterReferenceImagesToContent(
  content: string,
  images: CopiedCharacterReferenceImage[],
): string {
  if (images.length === 0) return content;

  const lines = [
    'Attached character reference images:',
    ...images.map((image) => `- ${image.name}: ${image.relativePath}`),
  ];

  return `${content.trimEnd()}\n\n${lines.join('\n')}`;
}

export function buildCharacterReferenceProjectInputs(
  images: CopiedCharacterReferenceImage[],
  now: number = Date.now(),
): ProjectInput[] {
  return images.map((image, index) => ({
    id: `character-ref-${now}-${index + 1}`,
    source: {
      type: 'local_path',
      value: image.relativePath,
      originalValue: image.sourcePath,
    },
    mediaType: 'image',
    purpose: 'character_ref',
    metadata: {
      originalFilename: image.name,
      ...(image.originalFilename
        ? { originalFilename: image.originalFilename }
        : {}),
      ...(image.mimeType ? { mimeType: image.mimeType } : {}),
      fileSize: image.size,
      addedAt: now,
      processedAt: now,
    },
    processing: {
      status: 'completed',
      localPath: image.relativePath,
    },
    notes: 'Uploaded with the initial project prompt.',
  }));
}

export function addProjectLocalCharacterReferenceInputs(args: {
  projectDir: string;
  images?: ProjectLocalCharacterReferenceImage[];
  now?: number;
  notes?: string;
}): ProjectInput[] {
  const images = normalizeProjectLocalCharacterReferenceImages({
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

  const added = buildCharacterReferenceProjectInputs(
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
