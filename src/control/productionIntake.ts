import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { listAvailableBundles } from '../agent/pi/tools/dheeListBundles.js';
import { parseBundleSource, resolveBundleDir } from '../dag/bundleSource.js';
import { initializeProject } from '../dag/initializeProject.js';
import { loadBundle } from '../dag/walker.js';
import { setProductionReviewsRequired } from '../dag/productionReviewGates.js';

export const localFileSchema = z
  .object({
    kind: z.literal('localFile'),
    sourcePath: z.string().refine(isAbsolute, 'An absolute source path is required.'),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export function readReference(value: z.infer<typeof localFileSchema>): Buffer {
  const source = realpathSync(value.sourcePath);
  if (!statSync(source).isFile()) throw new Error('Reference source must be a regular file.');
  const fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES)
      throw new Error('Reference source must be a nonempty regular file no larger than 64 MiB.');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (!count) throw new Error('Reference source changed during import.');
      offset += count;
    }
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      createHash('sha256').update(data).digest('hex') !== value.expectedSha256
    )
      throw new Error('Reference source changed or does not match its expected SHA-256.');
    return data;
  } finally {
    closeSync(fd);
  }
}
const bundleId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const bundleListSchema = z.object({ action: z.literal('bundle.list') }).strict();
export const bundleDescribeSchema = z
  .object({ action: z.literal('bundle.describe'), bundleId })
  .strict();
export const projectCreateSchema = z
  .object({
    action: z.literal('project.create'),
    projectDir: z.string().refine(isAbsolute, 'An absolute project directory is required.'),
    name: z.string().trim().min(1).max(200),
    bundleId,
    description: z.string().max(10000).optional(),
    inputs: z
      .record(z.union([z.string().max(500000), z.number().finite(), z.boolean(), localFileSchema]))
      .default({}),
    budgetCapUsd: z.number().positive().max(10000).default(5),
  })
  .strict();
export function describeProductionBundle(id: string) {
  const location = resolveBundleDir(parseBundleSource(`built-in:${id}`));
  const file = statSync(location).isDirectory() ? join(location, 'bundle.json') : location;
  const bundle = loadBundle(file);
  if (bundle.id !== id) throw new Error('Bundle ID does not match its resolved manifest.');
  return bundle;
}
export function listProductionBundles() {
  return { bundles: listAvailableBundles() };
}
export function createProductionProject(req: z.infer<typeof projectCreateSchema>) {
  const bundle = describeProductionBundle(req.bundleId);
  const projectDir = join(realpathSync(dirname(req.projectDir)), basename(req.projectDir));
  const declarations = bundle.inputs ?? [];
  const known = new Set(declarations.map(d => d.id));
  for (const key of Object.keys(req.inputs))
    if (!known.has(key))
      throw new Error(`Unknown input '${key}'. Describe the selected bundle first.`);
  const resolvedInputs: Record<string, unknown> = { ...req.inputs };
  const importedFiles: Array<{ inputId: string; path: string; sha256: string; bytes: number }> = [];
  let totalBytes = 0;
  const destinations = new Set<string>();
  const allowedFields = new Set(['style', 'aspect', 'resolution', 'targetDuration']);
  for (const decl of declarations) {
    const value = req.inputs[decl.id];
    if (decl.kind === 'file') {
      const rel = relative(projectDir, resolve(projectDir, decl.path));
      if (
        isAbsolute(decl.path) ||
        !rel ||
        rel.startsWith('..') ||
        isAbsolute(rel) ||
        !/^(inputs|plans)[/\\]/.test(rel)
      )
        throw new Error(
          `Unsupported input path '${decl.path}'; intake only writes inputs/ or plans/ inside the fresh project.`
        );
      const destination = resolve(projectDir, decl.path);
      if (destinations.has(destination))
        throw new Error(`Duplicate input destination '${decl.path}'.`);
      destinations.add(destination);
      if (
        value !== undefined &&
        typeof value !== 'string' &&
        (typeof value !== 'object' || value.kind !== 'localFile')
      )
        throw new Error(`File input '${decl.id}' requires text content or a localFile reference.`);
      if (value && typeof value === 'object' && value.kind === 'localFile') {
        const data = readReference(value);
        totalBytes += data.length;
        if (totalBytes > MAX_TOTAL_BYTES)
          throw new Error('Total imported reference bytes exceed 128 MiB.');
        resolvedInputs[decl.id] = data;
        importedFiles.push({
          inputId: decl.id,
          path: decl.path,
          sha256: value.expectedSha256,
          bytes: data.length,
        });
      }
      if (decl.required && (value === undefined || value === ''))
        throw new Error(`Required input '${decl.id}' was not provided.`);
    } else {
      if (!allowedFields.has(decl.field))
        throw new Error(`Unsupported project input field '${decl.field}' for production intake.`);
      const resolvedValue: unknown = value ?? decl.default;
      if (resolvedValue !== undefined) {
        const validators: Record<string, z.ZodTypeAny> = {
          targetDuration: z.number().finite().positive(),
          resolution: z.number().int().positive(),
          style: z.string().trim().min(1),
          aspect: z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/),
        };
        validators[decl.field]!.parse(resolvedValue);
      }
      if (decl.required && value === undefined && decl.default === undefined)
        throw new Error(`Required input '${decl.id}' was not provided.`);
    }
  }
  // Exclusive mkdir prevents retries/concurrent callers from overwriting any existing folder.
  mkdirSync(projectDir);
  const initialized = initializeProject({ ...req, projectDir, inputs: resolvedInputs });
  if (!initialized.ok)
    throw new Error(
      `${initialized.error} Fresh folder retained at ${projectDir}; inspect before retrying.`
    );
  setProductionReviewsRequired({ projectDir, enabled: true });
  for (const imported of importedFiles) {
    const hash = createHash('sha256')
      .update(readFileSync(join(projectDir, imported.path)))
      .digest('hex');
    if (hash !== imported.sha256)
      throw new Error(`Imported input '${imported.inputId}' failed integrity verification.`);
  }
  const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as {
    projectId: string;
  };
  return {
    projectDir,
    projectId: project.projectId,
    bundleId: req.bundleId,
    reviewsRequired: true,
    started: false,
    importedFiles,
  };
}
