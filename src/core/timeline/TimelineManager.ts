/**
 * TimelineManager
 *
 * Pure functions for creating, updating, validating, and persisting timelines.
 * No tool concerns — this module is the core logic layer.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { atomicWriteFileSync } from '../../utils/atomicWrite.js';
import { dirname, join } from 'path';
import {
  readProjectText,
  writeProjectText,
} from '../../tasks/video/workflow/projectFileIO.js';
import { getCurrentSession } from '../fs/SessionContext.js';
import type {
  Timeline,
  TimelineSegment,
  TimelineLayerEntry,
  TimelineValidation,
  TimelineGap,
  TimelineGlobalLayer,
  CompositingMode,
  SegmentFillStatus,
  DurationConstraints,
  SegmentDescriptor,
  LayerSnapshot,
  SegmentVersionInfo,
} from './types.js';

export type LayerDowngradeReason =
  | 'missing_artifact_id'
  | 'missing_file_path'
  | 'video_over_weaker_media'
  | 'metadata_cleared';

export interface DowngradePrevention {
  preservedIndexes: number[];
  reasons: Array<{
    index: number;
    reason: LayerDowngradeReason;
  }>;
}

export interface UpdateSegmentLayersResult extends Timeline {
  downgradePrevention?: DowngradePrevention;
}

export interface UpsertSceneShotsResult {
  timeline: Timeline;
  preservedExistingShots: boolean;
  mergedMetadataIntoExistingShots: boolean;
}

function buildShotSegmentsFromContainer(
  sceneSegmentId: string,
  container: Pick<TimelineSegment, 'startTime' | 'compositingMode'>,
  shots: Array<{ label: string; duration: number; metadata?: Record<string, unknown> }>
): TimelineSegment[] {
  if (shots.length === 0) {
    throw new Error('shots array must not be empty');
  }

  // Use each shot's EXACT duration. The previous behavior scaled shots
  // to fit the original container's window, which silently distorted
  // shot timings. Callers (splitSegmentIntoShots) are now responsible
  // for reflowing downstream segments by the resulting delta.
  const shotSegments: TimelineSegment[] = [];
  let currentTime = container.startTime;

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i]!;
    const shotDuration = Math.round(shot.duration * 100) / 100;

    shotSegments.push({
      id: `${sceneSegmentId}_shot_${i + 1}`,
      label: shot.label,
      startTime: Math.round(currentTime * 100) / 100,
      endTime: Math.round((currentTime + shotDuration) * 100) / 100,
      duration: shotDuration,
      compositingMode: container.compositingMode,
      fillStatus: 'planned',
      layers: [],
      ...(shot.metadata ? { metadata: shot.metadata } : {}),
    });

    currentTime += shotDuration;
  }

  return shotSegments;
}

/** Default constraints based on current generation capabilities */
const DEFAULT_CONSTRAINTS: DurationConstraints = {
  maxClipDuration: 10,
  maxImageDuration: 10,
  minSegmentDuration: 3,
};

const TIMELINE_FILENAME = 'timeline.json';

function isVisualLikeLayer(layer: TimelineLayerEntry | undefined): layer is TimelineLayerEntry {
  return layer?.type === 'visual' || layer?.type === 'narration_video';
}

function detectLayerMediaType(layer: TimelineLayerEntry | undefined): 'video' | 'image' | null {
  if (!layer) return null;
  if (layer.type === 'narration_video') return 'video';

  const path = layer.filePath?.toLowerCase() ?? '';
  if (/\.(mp4|mov|webm|m4v|avi|mkv)$/.test(path)) return 'video';
  if (/\.(png|jpe?g|webp|gif|avif|bmp)$/.test(path)) return 'image';

  const artifactId = layer.artifactId?.toLowerCase() ?? '';
  if (artifactId.startsWith('vid_')) return 'video';
  if (artifactId.startsWith('img_')) return 'image';

  const label = layer.label.toLowerCase();
  if (label.includes('video')) return 'video';
  if (label.includes('image')) return 'image';

  return null;
}

function mergeLayerMetadata(
  existingMetadata?: Record<string, unknown>,
  incomingMetadata?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!existingMetadata && !incomingMetadata) return undefined;
  return { ...(existingMetadata ?? {}), ...(incomingMetadata ?? {}) };
}

function hasUsefulMetadata(metadata?: Record<string, unknown>): boolean {
  if (!metadata) return false;
  const usefulKeys = [
    'prompt',
    'promptFile',
    'prompt_file',
    'motionPrompt',
    'motion_prompt',
    'negativePrompt',
    'negative_prompt',
    'shotType',
    'shot_type',
  ];
  return usefulKeys.some((key) => metadata[key] !== undefined);
}

function layersHaveEquivalentAssetIdentity(
  existing: TimelineLayerEntry[],
  next: TimelineLayerEntry[]
): boolean {
  const max = Math.max(existing.length, next.length);
  for (let i = 0; i < max; i++) {
    const left = existing[i];
    const right = next[i];
    if (!left || !right) return false;
    if (!isVisualLikeLayer(left) && !isVisualLikeLayer(right)) continue;
    if (left.type !== right.type) return false;
    if ((left.artifactId ?? '') !== (right.artifactId ?? '')) return false;
    if ((left.filePath ?? '') !== (right.filePath ?? '')) return false;
  }
  return true;
}

/**
 * Parse a "Scene N Shot M" identity from any free-form string —
 * segment label, file path, artifact id. Used by both the segment-
 * identity check and the layer-identity check below. Returns
 * undefined fields when not matched.
 */
function parseSceneShotIdentity(
  value: string | undefined,
): { sceneNumber?: number; shotNumber?: number } {
  if (!value) return {};
  const match = value.match(
    /scene[\s_-]*(\d+)[^\d]+shot[\s_-]*(\d+)|segment[_-](\d+)[_-]shot[_-](\d+)/i,
  );
  if (!match) return {};
  const sceneRaw = match[1] ?? (match[3] !== undefined ? String(Number(match[3]) + 1) : undefined);
  const shotRaw = match[2] ?? match[4];
  return {
    ...(sceneRaw !== undefined ? { sceneNumber: Number(sceneRaw) } : {}),
    ...(shotRaw !== undefined ? { shotNumber: Number(shotRaw) } : {}),
  };
}

/**
 * Identity of a segment from its id / label / metadata. Returns
 * undefined fields for non-shot segments (e.g. scene-level intros).
 */
function extractSegmentIdentity(
  segment: TimelineSegment,
): { sceneNumber?: number; shotNumber?: number } {
  const idIdentity = parseSceneShotIdentity(segment.id);
  if (idIdentity.sceneNumber !== undefined && idIdentity.shotNumber !== undefined) {
    return idIdentity;
  }
  const labelIdentity = parseSceneShotIdentity(segment.label);
  if (
    labelIdentity.sceneNumber !== undefined &&
    labelIdentity.shotNumber !== undefined
  ) {
    return labelIdentity;
  }
  return {
    ...idIdentity,
    ...labelIdentity,
  };
}

/**
 * Identity of an incoming visual-like layer, derived from filePath
 * primarily (the path on disk is the authoritative source for "what
 * is at this path"), then artifactId, then label.
 */
function extractLayerIdentity(
  layer: TimelineLayerEntry,
): { sceneNumber?: number; shotNumber?: number } {
  for (const candidate of [layer.filePath, layer.artifactId, layer.label]) {
    const id = parseSceneShotIdentity(candidate);
    if (id.sceneNumber !== undefined && id.shotNumber !== undefined) {
      return id;
    }
  }
  return {};
}

function identitiesConflict(
  segmentIdentity: { sceneNumber?: number; shotNumber?: number },
  layerIdentity: { sceneNumber?: number; shotNumber?: number },
): boolean {
  if (
    segmentIdentity.sceneNumber === undefined ||
    segmentIdentity.shotNumber === undefined ||
    layerIdentity.sceneNumber === undefined ||
    layerIdentity.shotNumber === undefined
  ) {
    return false;
  }
  return (
    segmentIdentity.sceneNumber !== layerIdentity.sceneNumber ||
    segmentIdentity.shotNumber !== layerIdentity.shotNumber
  );
}

function isCompatibleShotUpdate(
  existingSegment: TimelineSegment,
  incomingShot: { label: string; duration: number; metadata?: Record<string, unknown> }
): boolean {
  if (Math.abs(existingSegment.duration - incomingShot.duration) > 0.01) {
    return false;
  }

  const existingShotType = existingSegment.metadata?.['shotType'];
  const incomingShotType = incomingShot.metadata?.['shotType'];
  if (
    typeof existingShotType === 'string' &&
    typeof incomingShotType === 'string' &&
    existingShotType !== incomingShotType
  ) {
    return false;
  }

  const existingShotNumber = existingSegment.metadata?.['shotNumber'];
  const incomingShotNumber = incomingShot.metadata?.['shotNumber'];
  if (
    typeof existingShotNumber === 'number' &&
    typeof incomingShotNumber === 'number' &&
    existingShotNumber !== incomingShotNumber
  ) {
    return false;
  }

  return true;
}

export function getSceneShotSegments(
  timeline: Timeline,
  sceneSegmentId: string
): TimelineSegment[] {
  return timeline.segments.filter(segment => segment.id.startsWith(`${sceneSegmentId}_shot_`));
}

/**
 * Calculate how to divide total duration among segments.
 *
 * If descriptors provide suggested durations, those are used as weights
 * for proportional allocation. Otherwise, duration is split equally.
 */
export function calculateSegmentDurations(
  totalDuration: number,
  descriptors: SegmentDescriptor[],
  constraints: DurationConstraints = DEFAULT_CONSTRAINTS
): number[] {
  const count = descriptors.length;
  if (count === 0) return [];

  // Check if any descriptors have suggested durations
  const hasSuggestions = descriptors.some(d => d.suggestedDuration !== undefined);

  let durations: number[];

  if (hasSuggestions) {
    // Use suggested durations as proportional weights
    const totalSuggested = descriptors.reduce(
      (sum, d) => sum + (d.suggestedDuration ?? totalDuration / count),
      0
    );
    const scale = totalDuration / totalSuggested;
    durations = descriptors.map(
      d => (d.suggestedDuration ?? totalDuration / count) * scale
    );
  } else {
    // Equal split
    durations = new Array(count).fill(totalDuration / count);
  }

  // Enforce minimum segment duration
  durations = durations.map(d => Math.max(d, constraints.minSegmentDuration));

  // Re-normalize to fit total duration after enforcing minimums
  const currentTotal = durations.reduce((sum, d) => sum + d, 0);
  if (currentTotal !== totalDuration && currentTotal > 0) {
    const adjustmentFactor = totalDuration / currentTotal;
    durations = durations.map(d => Math.round(d * adjustmentFactor * 100) / 100);
  }

  // Fix any floating point drift on the last segment
  const almostTotal = durations.slice(0, -1).reduce((sum, d) => sum + d, 0);
  durations[durations.length - 1] = Math.round((totalDuration - almostTotal) * 100) / 100;

  return durations;
}

/**
 * Create a timeline skeleton from segment descriptors and total duration.
 *
 * This divides the total duration among segments and sets up empty layers.
 * Called after segments are planned but before content is generated.
 */
export function createTimelineSkeleton(
  totalDuration: number,
  descriptors: SegmentDescriptor[],
  defaultCompositingMode: CompositingMode = 'replace'
): Timeline {
  const durations = calculateSegmentDurations(totalDuration, descriptors);

  let currentTime = 0;
  const segments: TimelineSegment[] = descriptors.map((desc, index) => {
    const duration = durations[index] ?? 0;
    const segment: TimelineSegment = {
      id: desc.id ?? `segment_${index}`,
      label: desc.label,
      startTime: Math.round(currentTime * 100) / 100,
      endTime: Math.round((currentTime + duration) * 100) / 100,
      duration: Math.round(duration * 100) / 100,
      compositingMode: desc.compositingMode ?? defaultCompositingMode,
      fillStatus: 'empty',
      layers: [],
    };
    currentTime += duration;
    return segment;
  });

  const timeline: Timeline = {
    version: '1.0',
    totalDuration,
    defaultCompositingMode,
    segments,
    globalLayers: [],
    validation: validateTimeline({
      version: '1.0',
      totalDuration,
      defaultCompositingMode,
      segments,
      globalLayers: [],
      validation: { isComplete: false, filledDuration: 0, gaps: [], warnings: [] },
    }),
  };

  return timeline;
}

/**
 * Update a segment's layers and fill status.
 *
 * Automatically preserves version history: if the segment already has filled
 * visual layers, the current layers are snapshotted into `layerHistory` before
 * being replaced. First-time fills simply initialize `versionInfo`.
 *
 * Returns a new timeline with the updated segment.
 */
export function updateSegmentLayers(
  timeline: Timeline,
  segmentId: string,
  layers: TimelineLayerEntry[],
  fillStatus?: SegmentFillStatus,
  prompt?: string,
  note?: string
): UpdateSegmentLayersResult {
  const segmentIndex = timeline.segments.findIndex(s => s.id === segmentId);
  if (segmentIndex === -1) {
    throw new Error(`Segment not found: ${segmentId}`);
  }

  const updatedSegments = [...timeline.segments];
  const existing = updatedSegments[segmentIndex]!;
  const downgradePrevention: DowngradePrevention = {
    preservedIndexes: [],
    reasons: [],
  };

  // Identity guard — if the segment's id/label say "Scene 1 Shot 1"
  // and an incoming layer's filePath/artifactId says "Scene 2 Shot 1",
  // reject the update outright. The agent has the wrong target.
  const segmentIdentity = extractSegmentIdentity(existing);
  for (const incoming of layers) {
    if (!isVisualLikeLayer(incoming)) continue;
    const layerIdentity = extractLayerIdentity(incoming);
    if (identitiesConflict(segmentIdentity, layerIdentity)) {
      throw new Error('Incoming visual layer does not match target segment identity');
    }
  }

  const newLayers = layers.map((incomingLayer, index) => {
    const existingLayer = existing.layers[index];
    if (!isVisualLikeLayer(existingLayer) || !isVisualLikeLayer(incomingLayer)) {
      return prompt
        ? {
            ...incomingLayer,
            metadata: index === 0
              ? { ...(incomingLayer.metadata ?? {}), prompt }
              : incomingLayer.metadata,
          }
        : incomingLayer;
    }

    const strongExistingLayer = existingLayer;
    const mergedMetadata = mergeLayerMetadata(
      strongExistingLayer.metadata,
      incomingLayer.metadata,
    );

    // Skeletal patch — incoming declares no refs, only display fields.
    // Merge label / source / metadata onto existing without recording
    // a downgrade. The agent is not "demoting" anything; it just sent
    // an incomplete patch.
    const isSkeletalPatch =
      !incomingLayer.artifactId && !incomingLayer.filePath;
    if (isSkeletalPatch) {
      return {
        ...strongExistingLayer,
        ...incomingLayer,
        type: strongExistingLayer.type,
        artifactId: strongExistingLayer.artifactId,
        filePath: strongExistingLayer.filePath,
        metadata:
          index === 0 && prompt
            ? { ...(mergedMetadata ?? {}), prompt }
            : mergedMetadata,
      };
    }

    // Demotion check — incoming has refs, but they describe a weaker
    // medium than what's already on the layer (image where there was
    // a video). Keep existing wholesale; record the rejection so the
    // tool layer can surface it to the user.
    const existingMediaType = detectLayerMediaType(strongExistingLayer);
    const incomingMediaType = detectLayerMediaType(incomingLayer);
    if (existingMediaType === 'video' && incomingMediaType !== 'video') {
      downgradePrevention.preservedIndexes.push(index);
      downgradePrevention.reasons.push({
        index,
        reason: 'video_over_weaker_media',
      });
      return strongExistingLayer;
    }

    // Genuine update — same type or upgrade. Incoming wins on
    // explicit fields; existing fills the gaps.
    return {
      ...incomingLayer,
      artifactId: incomingLayer.artifactId ?? strongExistingLayer.artifactId,
      filePath: incomingLayer.filePath ?? strongExistingLayer.filePath,
      metadata:
        index === 0 && prompt
          ? { ...(mergedMetadata ?? {}), prompt }
          : mergedMetadata,
    };
  });

  // Determine fill status: if layers contain a visual, mark as filled
  const hasVisual = newLayers.some(l => l.type === 'visual' || l.type === 'narration_video');
  const newFillStatus = fillStatus ?? (hasVisual ? 'filled' : 'planned');

  // --- Version history ---
  const existingHasVisual = existing.layers.some(
    l => l.type === 'visual' || l.type === 'narration_video'
  );
  const layersChanged = !layersAreDeepEqual(existing.layers, newLayers);
  // Bump version whenever a real change lands and we didn't reject
  // the update via downgrade prevention. Skeletal patches do bump
  // (they meaningfully change the layer); preserved-existing demotes
  // do not.
  const isReplacement =
    existingHasVisual &&
    hasVisual &&
    layersChanged &&
    downgradePrevention.preservedIndexes.length === 0;

  const layerHistory = existing.layerHistory ? [...existing.layerHistory] : [];
  let versionInfo: SegmentVersionInfo;

  if (isReplacement) {
    // Snapshot current layers before replacing
    const currentVersion = existing.versionInfo?.activeVersion ?? 1;
    const snapshot: LayerSnapshot = {
      version: currentVersion,
      layers: [...existing.layers],
      createdAt: new Date().toISOString(),
      prompt: existing.layers[0]?.metadata?.['prompt'] as string | undefined,
      note: note ?? undefined,
    };
    layerHistory.push(snapshot);
    versionInfo = {
      activeVersion: currentVersion + 1,
      totalVersions: currentVersion + 1,
    };
  } else {
    // First-time fill — initialize version info
    versionInfo = existing.versionInfo ?? { activeVersion: 1, totalVersions: 1 };
  }

  updatedSegments[segmentIndex] = {
    ...existing,
    layers: newLayers,
    fillStatus: newFillStatus,
    layerHistory: layerHistory.length > 0 ? layerHistory : undefined,
    versionInfo,
  };

  const updated: Timeline = {
    ...timeline,
    version: layerHistory.length > 0 ? '1.1' : timeline.version,
    segments: updatedSegments,
  };
  updated.validation = validateTimeline(updated);
  return downgradePrevention.preservedIndexes.length > 0
    ? { ...updated, downgradePrevention }
    : updated;
}

function layersAreDeepEqual(
  a: TimelineLayerEntry[],
  b: TimelineLayerEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

/**
 * Set the compositing mode for a segment.
 */
export function setSegmentCompositing(
  timeline: Timeline,
  segmentId: string,
  compositingMode: CompositingMode,
  compositingMetadata?: Record<string, unknown>
): Timeline {
  const segmentIndex = timeline.segments.findIndex(s => s.id === segmentId);
  if (segmentIndex === -1) {
    throw new Error(`Segment not found: ${segmentId}`);
  }

  const updatedSegments = [...timeline.segments];
  const existing = updatedSegments[segmentIndex]!;

  updatedSegments[segmentIndex] = {
    ...existing,
    compositingMode,
    ...(compositingMetadata ? { compositingMetadata } : {}),
  };

  return {
    ...timeline,
    segments: updatedSegments,
  };
}

/**
 * Set the transition for a segment.
 */
export function setSegmentTransition(
  timeline: Timeline,
  segmentId: string,
  transition: TimelineSegment['transition']
): Timeline {
  const segmentIndex = timeline.segments.findIndex(s => s.id === segmentId);
  if (segmentIndex === -1) {
    throw new Error(`Segment not found: ${segmentId}`);
  }

  const updatedSegments = [...timeline.segments];
  const existing = updatedSegments[segmentIndex]!;

  updatedSegments[segmentIndex] = {
    ...existing,
    transition,
  };

  return {
    ...timeline,
    segments: updatedSegments,
  };
}

/**
 * Add a global layer (narration audio, background music, etc.).
 */
export function addGlobalLayer(
  timeline: Timeline,
  layer: TimelineGlobalLayer
): Timeline {
  return {
    ...timeline,
    globalLayers: [...timeline.globalLayers, layer],
  };
}

/**
 * Validate a timeline for completeness and consistency.
 *
 * Checks for:
 * - Segments with empty visual layers
 * - Time gaps between segments
 * - Time overlaps between segments
 * - Duration sum matching total duration
 */
export function validateTimeline(timeline: Timeline): TimelineValidation {
  const warnings: string[] = [];
  const gaps: TimelineGap[] = [];
  let filledDuration = 0;
  // Tracks "this segment claims filled but its active layer is
  // unrenderable" — used to defeat isComplete even when the gap /
  // status checks would otherwise mark the timeline ready.
  let hasCorruptedFilledSegment = false;

  // Check each segment
  for (const segment of timeline.segments) {
    if (segment.fillStatus === 'filled') {
      filledDuration += segment.duration;
    }

    if (segment.fillStatus === 'empty') {
      warnings.push(`Segment "${segment.label}" (${segment.id}) has no content`);
    }

    const hasVisualLayer = segment.layers.some(
      l => l.type === 'visual' || l.type === 'narration_video'
    );
    if (segment.fillStatus === 'filled' && !hasVisualLayer) {
      warnings.push(
        `Segment "${segment.label}" (${segment.id}) is marked filled but has no visual layer`
      );
    }

    // Filled segment with a visual layer that has neither artifactId
    // nor filePath — the layer is a stub. Surface explicitly so callers
    // (validate tool, UI) can flag it for repair instead of silently
    // pretending the segment is renderable.
    if (segment.fillStatus === 'filled') {
      const activeVisual = segment.layers.find(isVisualLikeLayer);
      if (
        activeVisual &&
        !activeVisual.artifactId &&
        !activeVisual.filePath
      ) {
        warnings.push(
          `Segment "${segment.label}" (${segment.id}) is marked filled but its active visual layer has no filePath or artifactId`,
        );
        hasCorruptedFilledSegment = true;
      }

      // Image-active layer when a matching video exists in this
      // segment's layerHistory — the agent demoted the visual without
      // realizing the prior video was still on disk. Don't auto-repair
      // (the user may have intentionally swapped); just warn.
      if (
        activeVisual &&
        detectLayerMediaType(activeVisual) === 'image' &&
        segment.layerHistory?.some(snapshot =>
          snapshot.layers.some(
            l => isVisualLikeLayer(l) && detectLayerMediaType(l) === 'video',
          ),
        )
      ) {
        warnings.push(
          `Segment "${segment.label}" (${segment.id}) has an image active layer even though a matching video exists in history`,
        );
      }
    }
  }

  // Check for gaps and overlaps between segments (sorted by startTime)
  const sorted = [...timeline.segments].sort((a, b) => a.startTime - b.startTime);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;

    const gapSize = curr.startTime - prev.endTime;
    if (gapSize > 0.01) {
      gaps.push({
        startTime: prev.endTime,
        endTime: curr.startTime,
        duration: Math.round(gapSize * 100) / 100,
      });
      warnings.push(
        `Gap of ${gapSize.toFixed(2)}s between "${prev.label}" and "${curr.label}"`
      );
    } else if (gapSize < -0.01) {
      warnings.push(
        `Overlap of ${Math.abs(gapSize).toFixed(2)}s between "${prev.label}" and "${curr.label}"`
      );
    }
  }

  // Check total duration coverage
  if (sorted.length > 0) {
    const firstStart = sorted[0]!.startTime;
    const lastEnd = sorted[sorted.length - 1]!.endTime;

    if (firstStart > 0.01) {
      gaps.unshift({
        startTime: 0,
        endTime: firstStart,
        duration: Math.round(firstStart * 100) / 100,
      });
      warnings.push(`Timeline starts at ${firstStart.toFixed(2)}s instead of 0s`);
    }

    const durationDiff = Math.abs(lastEnd - timeline.totalDuration);
    if (durationDiff > 0.1) {
      warnings.push(
        `Segments end at ${lastEnd.toFixed(2)}s but total duration is ${timeline.totalDuration}s`
      );
    }
  }

  const allFilled = timeline.segments.every(s => s.fillStatus === 'filled');
  const isComplete =
    allFilled &&
    gaps.length === 0 &&
    timeline.segments.length > 0 &&
    !hasCorruptedFilledSegment;

  return {
    isComplete,
    filledDuration: Math.round(filledDuration * 100) / 100,
    gaps,
    warnings,
  };
}

/**
 * Split a scene segment into multiple shot sub-segments.
 *
 * Replaces the target segment with N shot segments, proportionally scaling
 * shot durations to fill the scene's allocated time. New segment IDs follow
 * the pattern `{sceneSegmentId}_shot_{n}`.
 *
 * @param timeline - The current timeline
 * @param sceneSegmentId - ID of the scene segment to split
 * @param shots - Array of shot descriptors with label, duration, and optional metadata
 * @returns Updated timeline with shot segments replacing the scene segment
 */
export function splitSegmentIntoShots(
  timeline: Timeline,
  sceneSegmentId: string,
  shots: Array<{ label: string; duration: number; metadata?: Record<string, unknown> }>
): Timeline {
  // Two paths:
  //   1. Direct: `sceneSegmentId` is still present as a single scene
  //      segment. Replace it with the new shot segments.
  //   2. Re-split: a previous call already replaced it with
  //      `${sceneSegmentId}_shot_*` segments. Treat that contiguous
  //      run as the container so callers can re-issue a split with a
  //      different shot list without first un-splitting by hand.
  const directIndex = timeline.segments.findIndex(s => s.id === sceneSegmentId);
  const shotPattern = new RegExp(`^${sceneSegmentId}_shot_\\d+$`);

  let firstIndex: number;
  let lastIndex: number;
  let containerStartTime: number;
  let containerEndTime: number;
  let containerCompositingMode: TimelineSegment['compositingMode'];
  let containerCompositingMetadata: TimelineSegment['compositingMetadata'];
  let containerTransition: TimelineSegment['transition'];

  if (directIndex !== -1) {
    const seg = timeline.segments[directIndex]!;
    firstIndex = directIndex;
    lastIndex = directIndex;
    containerStartTime = seg.startTime;
    containerEndTime = seg.endTime;
    containerCompositingMode = seg.compositingMode;
    containerCompositingMetadata = seg.compositingMetadata;
    containerTransition = seg.transition;
  } else {
    // Re-split path: gather the existing shot segments for this scene.
    const matched = timeline.segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => shotPattern.test(segment.id));
    if (matched.length === 0) {
      throw new Error(`Segment not found: ${sceneSegmentId}`);
    }
    matched.sort((a, b) => a.segment.startTime - b.segment.startTime);
    firstIndex = matched[0]!.index;
    lastIndex = matched[matched.length - 1]!.index;
    const first = matched[0]!.segment;
    const last = matched[matched.length - 1]!.segment;
    containerStartTime = first.startTime;
    containerEndTime = last.endTime;
    containerCompositingMode = first.compositingMode;
    containerCompositingMetadata = first.compositingMetadata;
    containerTransition = first.transition;
  }

  const shotSegments = buildShotSegmentsFromContainer(
    sceneSegmentId,
    {
      startTime: containerStartTime,
      compositingMode: containerCompositingMode,
    },
    shots,
  );

  // Carry over the original scene's transition + compositingMetadata to
  // the FIRST shot — those properties belong to the scene boundary, so
  // they should follow the leading shot rather than be lost.
  if (containerTransition || containerCompositingMetadata) {
    shotSegments[0] = {
      ...shotSegments[0]!,
      ...(containerTransition ? { transition: containerTransition } : {}),
      ...(containerCompositingMetadata
        ? { compositingMetadata: containerCompositingMetadata }
        : {}),
    };
  }

  // Reflow downstream segments by the delta between the new shots'
  // total span and the original container's span. Negative delta
  // shrinks the timeline; positive grows it.
  const newEndTime =
    shotSegments[shotSegments.length - 1]!.endTime;
  const delta = Math.round((newEndTime - containerEndTime) * 100) / 100;

  const before = timeline.segments.slice(0, firstIndex);
  const after = timeline.segments.slice(lastIndex + 1).map(segment => ({
    ...segment,
    startTime: Math.round((segment.startTime + delta) * 100) / 100,
    endTime: Math.round((segment.endTime + delta) * 100) / 100,
  }));

  const updated: Timeline = {
    ...timeline,
    segments: [...before, ...shotSegments, ...after],
    totalDuration: Math.round((timeline.totalDuration + delta) * 100) / 100,
  };
  updated.validation = validateTimeline(updated);
  return updated;
}

export function upsertSceneShots(
  timeline: Timeline,
  sceneSegmentId: string,
  shots: Array<{ label: string; duration: number; metadata?: Record<string, unknown> }>
): UpsertSceneShotsResult {
  const existingShotSegments = getSceneShotSegments(timeline, sceneSegmentId);
  const sceneSegment = timeline.segments.find(segment => segment.id === sceneSegmentId);

  // (0) Drop-all: caller is replacing the scene's plan with an empty list.
  // Remove every `<sceneSegmentId>_shot_*` segment and reflow downstream
  // segments by the dropped span. Bypasses the rest of the function because
  // every later branch assumes shots.length > 0.
  if (shots.length === 0) {
    if (existingShotSegments.length === 0) {
      return {
        timeline,
        preservedExistingShots: false,
        mergedMetadataIntoExistingShots: false,
      };
    }
    const sortedScene = [...existingShotSegments].sort((a, b) => a.startTime - b.startTime);
    const sceneStart = sortedScene[0]!.startTime;
    const sceneEnd = sortedScene[sortedScene.length - 1]!.endTime;
    const droppedSpan = Math.round((sceneEnd - sceneStart) * 100) / 100;
    const sceneIdsSet = new Set(sortedScene.map(s => s.id));
    const survivors = timeline.segments
      .filter(s => !sceneIdsSet.has(s.id))
      .map(s =>
        s.startTime >= sceneEnd
          ? {
              ...s,
              startTime: Math.round((s.startTime - droppedSpan) * 100) / 100,
              endTime: Math.round((s.endTime - droppedSpan) * 100) / 100,
            }
          : s,
      );
    const updated: Timeline = {
      ...timeline,
      segments: survivors,
      totalDuration: Math.round((timeline.totalDuration - droppedSpan) * 100) / 100,
    };
    updated.validation = validateTimeline(updated);
    return {
      timeline: updated,
      preservedExistingShots: false,
      mergedMetadataIntoExistingShots: false,
    };
  }

  const hasFilledShots = existingShotSegments.some(segment => segment.fillStatus === 'filled');
  const canMergeIntoExistingShots =
    existingShotSegments.length === shots.length &&
    existingShotSegments.every((segment, index) => isCompatibleShotUpdate(segment, shots[index]!));

  if (existingShotSegments.length > 0 && canMergeIntoExistingShots) {
    const mergedSegments = timeline.segments.map(segment => {
      const shotMatch = segment.id.match(new RegExp(`^${sceneSegmentId}_shot_(\\d+)$`));
      if (!shotMatch?.[1]) return segment;
      const shotIndex = Number(shotMatch[1]) - 1;
      const incomingShot = shots[shotIndex];
      if (!incomingShot) return segment;

      return {
        ...segment,
        label: incomingShot.label ?? segment.label,
        metadata: incomingShot.metadata
          ? { ...(segment.metadata ?? {}), ...incomingShot.metadata }
          : segment.metadata,
      };
    });

    const updatedTimeline: Timeline = {
      ...timeline,
      segments: mergedSegments,
    };
    updatedTimeline.validation = validateTimeline(updatedTimeline);

    return {
      timeline: updatedTimeline,
      preservedExistingShots: true,
      mergedMetadataIntoExistingShots: true,
    };
  }

  // (2) Plan resize — shot count changed. Rebuild segments from the new
  // plan (via splitSegmentIntoShots, which already handles reflow), then
  // patch fills back onto surviving shots whose shotNumber is still in
  // scope. Without this branch, a Stage A re-plan from 8 → 4 shots leaves
  // the old 4 trailing segments untouched on the timeline, and the FFmpeg
  // assembler then stitches a final video of 8 shots from two different
  // plans (the 2026-05-19 "Village" bug).
  if (existingShotSegments.length > 0 && existingShotSegments.length !== shots.length) {
    const oldFilledByShotNum = new Map<number, TimelineSegment>();
    for (const seg of existingShotSegments) {
      if (seg.fillStatus !== 'filled') continue;
      const m = seg.id.match(/_shot_(\d+)$/);
      if (m?.[1]) oldFilledByShotNum.set(Number(m[1]), seg);
    }
    const rebuilt = splitSegmentIntoShots(timeline, sceneSegmentId, shots);
    const shotIdPrefix = `${sceneSegmentId}_shot_`;
    const patchedSegments = rebuilt.segments.map(seg => {
      if (!seg.id.startsWith(shotIdPrefix)) return seg;
      const m = seg.id.match(/_shot_(\d+)$/);
      if (!m?.[1]) return seg;
      const oldSeg = oldFilledByShotNum.get(Number(m[1]));
      if (!oldSeg) return seg;
      // Carry the rendered work forward: layers + fillStatus + version
      // history. Metadata is merged (new plan's metadata wins on key
      // overlap because shotNumber etc. are authoritative there).
      return {
        ...seg,
        layers: oldSeg.layers,
        fillStatus: oldSeg.fillStatus,
        ...(oldSeg.layerHistory ? { layerHistory: oldSeg.layerHistory } : {}),
        ...(oldSeg.versionInfo ? { versionInfo: oldSeg.versionInfo } : {}),
        metadata: { ...(oldSeg.metadata ?? {}), ...(seg.metadata ?? {}) },
      };
    });
    const updated: Timeline = { ...rebuilt, segments: patchedSegments };
    updated.validation = validateTimeline(updated);
    return {
      timeline: updated,
      preservedExistingShots: oldFilledByShotNum.size > 0,
      mergedMetadataIntoExistingShots: false,
    };
  }

  if (existingShotSegments.length > 0 && hasFilledShots) {
    return {
      timeline,
      preservedExistingShots: true,
      mergedMetadataIntoExistingShots: false,
    };
  }

  if (!sceneSegment && existingShotSegments.length > 0) {
    const sortedExisting = [...existingShotSegments].sort((a, b) => a.startTime - b.startTime);
    const replacementSegments = buildShotSegmentsFromContainer(
      sceneSegmentId,
      {
        startTime: sortedExisting[0]!.startTime,
        compositingMode: sortedExisting[0]!.compositingMode,
      },
      shots,
    );

    const existingIds = new Set(sortedExisting.map(segment => segment.id));
    const insertionIndex = timeline.segments.findIndex(segment => segment.id === sortedExisting[0]!.id);
    const remainingSegments = timeline.segments.filter(segment => !existingIds.has(segment.id));
    const updatedSegments = [
      ...remainingSegments.slice(0, insertionIndex),
      ...replacementSegments,
      ...remainingSegments.slice(insertionIndex),
    ];

    const updatedTimeline: Timeline = {
      ...timeline,
      segments: updatedSegments,
    };
    updatedTimeline.validation = validateTimeline(updatedTimeline);

    return {
      timeline: updatedTimeline,
      preservedExistingShots: false,
      mergedMetadataIntoExistingShots: false,
    };
  }

  return {
    timeline: splitSegmentIntoShots(timeline, sceneSegmentId, shots),
    preservedExistingShots: false,
    mergedMetadataIntoExistingShots: false,
  };
}

/**
 * Load a timeline from disk. For remote-fs sessions (desktop's
 * websocket-attached projects) this hits the projectFileIO cache; for
 * local-fs callers it reads the file directly so callers can pass a
 * concrete project dir without juggling the session-global active
 * project. Returns null if the file is missing or malformed.
 */
export function loadTimeline(projectDir: string): Timeline | null {
  let raw: string | null = null;
  const session = getCurrentSession();
  if (session?.mode === 'remote') {
    // Remote-fs session: read from the projectFileIO cache (the
    // websocket transport keeps it warm). Falls back to null if the
    // file isn't in the cache yet.
    raw = readProjectText(TIMELINE_FILENAME, projectDir);
  } else {
    try {
      raw = readFileSync(join(projectDir, TIMELINE_FILENAME), 'utf-8');
    } catch {
      return null;
    }
  }
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Timeline;
  } catch {
    return null;
  }
}

/**
 * Canonicalize all `filePath` strings in the timeline (active layers
 * + layerHistory snapshots + globalLayers) to project-relative form.
 * Absolute paths under `projectDir` are rewritten by stripping the
 * prefix; paths already relative are left alone. Pure — returns a new
 * Timeline.
 */
function canonicalizeTimelineFilePaths(
  projectDir: string,
  timeline: Timeline,
): { timeline: Timeline; changed: boolean } {
  let changed = false;
  const prefix = projectDir.endsWith('/') ? projectDir : projectDir + '/';

  const rewritePath = (p: string | undefined): string | undefined => {
    if (!p) return p;
    if (p.startsWith(prefix)) {
      changed = true;
      return p.slice(prefix.length);
    }
    return p;
  };

  const rewriteLayer = <T extends TimelineLayerEntry>(layer: T): T => {
    if (layer.filePath === undefined) return layer;
    const rewritten = rewritePath(layer.filePath);
    return rewritten === layer.filePath ? layer : { ...layer, filePath: rewritten };
  };

  const segments = timeline.segments.map(segment => {
    const layers = segment.layers.map(rewriteLayer);
    const history = segment.layerHistory?.map(snapshot => ({
      ...snapshot,
      layers: snapshot.layers.map(rewriteLayer),
    }));
    return {
      ...segment,
      layers,
      ...(history ? { layerHistory: history } : {}),
    };
  });

  const globalLayers = timeline.globalLayers.map(rewriteLayer);

  return {
    timeline: { ...timeline, segments, globalLayers },
    changed,
  };
}

/**
 * Save a timeline to disk. Routes through projectFileIO so the write
 * lands wherever the active session points (local fs or a remote
 * websocket peer for desktop-attached projects). On the way through,
 * absolute filePath strings rooted under the project dir are
 * rewritten to project-relative form so timeline.json stays portable
 * across machines.
 */
export function saveTimeline(projectDir: string, timeline: Timeline): void {
  const { timeline: canonical } = canonicalizeTimelineFilePaths(
    projectDir,
    timeline,
  );
  // Revalidate before saving
  canonical.validation = validateTimeline(canonical);
  const content = JSON.stringify(canonical, null, 2);

  // Remote-fs path: dispatch through projectFileIO so the desktop's
  // websocket peer hears about the write (and the in-process cache
  // stays in sync). projectFileIO joins the active project root for
  // us, so we pass the bare relative filename.
  const session = getCurrentSession();
  if (session?.mode === 'remote') {
    writeProjectText(TIMELINE_FILENAME, content, projectDir);
    return;
  }

  // Local-fs path: write directly to the supplied project dir. We
  // intentionally avoid writeProjectText here — it composes its target
  // path from `getActiveProjectDir()`, which is a session-global that
  // doesn't match a `projectDir` argument the caller passed in by
  // hand (CLI tests, executor unit tests, etc).
  const filePath = join(projectDir, TIMELINE_FILENAME);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(filePath, content, 'utf-8');
}

/**
 * Pending segment summary used by getPendingTimelineSegments /
 * getNextPendingTimelineSegment. Mirrors dev's shape so callers
 * (TimelineTools, GenericAgent) get the same surface area.
 */
export interface PendingTimelineSegment {
  segmentId: string;
  label: string;
  fillStatus: SegmentFillStatus;
  sceneNumber?: number;
  shotNumber?: number;
}

/**
 * Parse a shot segment ID like `segment_0_shot_3` into its scene/shot
 * numbers. Counterpart to `buildShotSegmentId`. Returns null if the ID
 * doesn't match the convention (e.g. global layer / scene segments).
 */
export function parseShotSegmentId(
  segmentId: string,
): { sceneIndex: number; sceneNumber: number; shotNumber: number } | null {
  const match = /^segment_(\d+)_shot_(\d+)$/.exec(segmentId);
  if (!match?.[1] || !match?.[2]) return null;
  const sceneIndex = Number(match[1]);
  const shotNumber = Number(match[2]);
  if (!Number.isFinite(sceneIndex) || !Number.isFinite(shotNumber)) return null;
  return { sceneIndex, sceneNumber: sceneIndex + 1, shotNumber };
}

/**
 * All segments whose fillStatus isn't `filled`. Used by manage_timeline
 * tool consumers to figure out what work remains.
 */
export function getPendingTimelineSegments(
  timeline: Timeline,
): PendingTimelineSegment[] {
  return timeline.segments
    .filter(segment => segment.fillStatus !== 'filled')
    .map(segment => {
      const parsed = parseShotSegmentId(segment.id);
      return {
        segmentId: segment.id,
        label: segment.label,
        fillStatus: segment.fillStatus,
        ...(parsed
          ? { sceneNumber: parsed.sceneNumber, shotNumber: parsed.shotNumber }
          : {}),
      };
    });
}

/**
 * First (in declared segment order) pending segment, or null if everything
 * is filled. Convenience wrapper around getPendingTimelineSegments.
 */
export function getNextPendingTimelineSegment(
  timeline: Timeline,
): PendingTimelineSegment | null {
  return getPendingTimelineSegments(timeline)[0] ?? null;
}

/**
 * Build a deterministic timeline segment ID for a (scene, shot) pair.
 * Matches the dev-branch convention so cross-merge code that imports
 * this function from TimelineManager keeps working. The ID format is:
 *
 *   segment_{sceneIndex}_shot_{shotNumber}
 *
 * Where sceneIndex is `sceneNumber - 1` (zero-indexed scenes, one-indexed
 * shots — matches how segments are emitted elsewhere in the pipeline).
 */
export function buildShotSegmentId(sceneNumber: number, shotNumber: number): string {
  if (!Number.isFinite(sceneNumber) || sceneNumber < 1) {
    throw new Error(`Invalid scene number for shot segment: ${sceneNumber}`);
  }
  if (!Number.isFinite(shotNumber) || shotNumber < 1) {
    throw new Error(`Invalid shot number for shot segment: ${shotNumber}`);
  }
  return `segment_${sceneNumber - 1}_shot_${shotNumber}`;
}

/**
 * Minimal `inspectTimeline` for callers (e.g. GenericAgent from the dev
 * merge) that expect the path-canonicalization API. Loads the timeline
 * as-is. The full path-correction pipeline from dev isn't ported yet;
 * we return the timeline unchanged with an empty `pathCorrections`
 * array so callers can safely read `.length`.
 *
 * Returns null when there's no timeline.json on disk.
 */
export function inspectTimeline(
  projectDir: string,
): {
  timeline: Timeline;
  wouldChangeOnSave: boolean;
  pathCorrections: Array<{
    index: number;
    artifactId: string;
    previousFilePath?: string;
    canonicalFilePath: string;
  }>;
} | null {
  const timeline = loadTimeline(projectDir);
  if (!timeline) return null;
  // wouldChangeOnSave = true when a save would rewrite at least one
  // absolute filePath to project-relative. Pure — does not touch disk.
  const { changed } = canonicalizeTimelineFilePaths(projectDir, timeline);
  return { timeline, wouldChangeOnSave: changed, pathCorrections: [] };
}
