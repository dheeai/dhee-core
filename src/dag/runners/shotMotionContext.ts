import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MotionContextShotPlanShot {
  id?: string;
  scene?: number;
  shotNumber?: number;
  duration?: number;
  description?: string;
  cameraWork?: string;
  mainSubject?: string;
  dialogue?: string | null;
  speaker?: string | null;
}

export interface MotionDirectiveSummary {
  description?: string;
  cameraWork?: string;
  audio?: string;
  purpose?: string;
  transition?: string;
}

export interface MotionContextShotSlot extends MotionContextShotPlanShot {
  imagePrompt?: string;
  motionDirective?: MotionDirectiveSummary;
}

export interface ShotMotionContext {
  itemId?: string;
  previousShot: MotionContextShotSlot | null;
  currentShot: MotionContextShotSlot | null;
  nextShot: MotionContextShotSlot | null;
}

export interface MotionContextDependency {
  nodeId: string;
  itemId?: string;
  role?: 'input' | 'context' | 'reference' | 'aggregate';
}

export interface BuildShotMotionContextOptions {
  projectDir: string;
  itemId?: string;
  shots: MotionContextShotPlanShot[];
  imagePromptPattern: string;
  motionDirectivePattern: string;
}

export interface BuildShotMotionContextResult {
  context: ShotMotionContext;
  additionalDependencies: MotionContextDependency[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseSceneShotId(id: string | undefined): { scene?: number; shotNumber?: number } {
  const m = id?.match(/^scene_(\d+)_shot_(\d+)$/);
  if (!m) return {};
  return {
    scene: parseInt(m[1]!, 10),
    shotNumber: parseInt(m[2]!, 10),
  };
}

export function canonicalShotId(shot: MotionContextShotPlanShot | undefined): string | undefined {
  if (!shot) return undefined;
  if (shot.id) return shot.id;
  if (shot.scene !== undefined && shot.shotNumber !== undefined) {
    return `scene_${shot.scene}_shot_${shot.shotNumber}`;
  }
  return undefined;
}

function normalizeShot(shot: MotionContextShotPlanShot | undefined): MotionContextShotSlot | null {
  if (!shot) return null;
  const parsed = parseSceneShotId(shot.id);
  const out: MotionContextShotSlot = {};
  const id = canonicalShotId(shot);
  if (id !== undefined) out.id = id;
  const scene = shot.scene ?? parsed.scene;
  if (scene !== undefined) out.scene = scene;
  const shotNumber = shot.shotNumber ?? parsed.shotNumber;
  if (shotNumber !== undefined) out.shotNumber = shotNumber;
  if (shot.duration !== undefined) out.duration = shot.duration;
  if (shot.description !== undefined) out.description = shot.description;
  if (shot.cameraWork !== undefined) out.cameraWork = shot.cameraWork;
  if (shot.mainSubject !== undefined) out.mainSubject = shot.mainSubject;
  if (shot.dialogue !== undefined) out.dialogue = shot.dialogue;
  if (shot.speaker !== undefined) out.speaker = shot.speaker;
  return out;
}

export function applyItemPattern(pattern: string, itemId: string): string {
  return pattern.replace(/\{\{\s*(item_id|shot_id|id)\s*\}\}/g, itemId);
}

export function readJsonFile(abs: string): unknown | undefined {
  if (!existsSync(abs)) return undefined;
  try {
    return JSON.parse(readFileSync(abs, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

function readJsonByPattern(projectDir: string, pattern: string, itemId: string): unknown | undefined {
  return readJsonFile(resolve(projectDir, applyItemPattern(pattern, itemId)));
}

export function extractImagePrompt(value: unknown): string | undefined {
  const obj = asRecord(value);
  if (!obj) return undefined;
  const direct = obj['imagePrompt'];
  if (typeof direct === 'string') return direct;
  const frames = asRecord(obj['frames']);
  const firstFrame = asRecord(frames?.['first_frame']);
  const nested = firstFrame?.['imagePrompt'];
  return typeof nested === 'string' ? nested : undefined;
}

export function extractMotionDirective(value: unknown): MotionDirectiveSummary | undefined {
  const obj = asRecord(value);
  if (!obj) return undefined;
  const out: MotionDirectiveSummary = {};
  for (const key of ['description', 'cameraWork', 'audio', 'purpose', 'transition'] as const) {
    const v = obj[key];
    if (typeof v === 'string') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildShotMotionContext(
  opts: BuildShotMotionContextOptions,
): BuildShotMotionContextResult {
  const currentIdx = opts.itemId
    ? opts.shots.findIndex((s) => canonicalShotId(s) === opts.itemId)
    : -1;
  const previous = currentIdx > 0 ? opts.shots[currentIdx - 1] : undefined;
  const current = currentIdx >= 0 ? opts.shots[currentIdx] : undefined;
  const next = currentIdx >= 0 && currentIdx < opts.shots.length - 1
    ? opts.shots[currentIdx + 1]
    : undefined;

  const slotFor = (
    shot: MotionContextShotPlanShot | undefined,
    includeMotionDirective: boolean,
  ): MotionContextShotSlot | null => {
    const slot = normalizeShot(shot);
    const id = canonicalShotId(shot);
    if (!slot || !id) return slot;
    const imagePrompt = extractImagePrompt(
      readJsonByPattern(opts.projectDir, opts.imagePromptPattern, id),
    );
    if (imagePrompt !== undefined) slot.imagePrompt = imagePrompt;
    if (includeMotionDirective) {
      const motionDirective = extractMotionDirective(
        readJsonByPattern(opts.projectDir, opts.motionDirectivePattern, id),
      );
      if (motionDirective !== undefined) slot.motionDirective = motionDirective;
    }
    return slot;
  };

  const previousSlot = slotFor(previous, true);
  const currentSlot = slotFor(current, false);
  const nextSlot = slotFor(next, false);

  const additionalDependencies: MotionContextDependency[] = [];
  const addDep = (
    nodeId: string,
    itemId: string | undefined,
    role: MotionContextDependency['role'],
  ): void => {
    if (!itemId) return;
    additionalDependencies.push({ nodeId, itemId, role });
  };

  for (const shot of [previous, current, next]) {
    addDep('shot_image_prompt', canonicalShotId(shot), 'context');
  }

  return {
    context: {
      ...(opts.itemId !== undefined ? { itemId: opts.itemId } : {}),
      previousShot: previousSlot,
      currentShot: currentSlot,
      nextShot: nextSlot,
    },
    additionalDependencies,
  };
}
