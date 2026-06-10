/**
 * Unit tests for src/dag/projectResolvers.ts
 *
 * Focus on the chunk-budgeting / frame-alignment / first-frame-resolution
 * logic. Each test materializes a tiny project layout under a temp dir
 * (project.json + prompts/videos/scenes/scene_N.json + assets/images/*.png)
 * so the pure-ish disk-reading functions can be exercised without a real
 * bundle/project.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readProjectStyle,
  loadScenePlan,
  pickFirstFrame,
  shotHasFirstFrame,
  resolveRelayInputs,
  chunkScene,
  type ScenePlan,
} from '../../src/dag/projectResolvers.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'project-resolvers-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** Write project.json with the given style (or no style). */
function writeProjectJson(style?: string): void {
  const body = style === undefined ? { title: 'T' } : { title: 'T', style };
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(body));
}

/** Write a scene plan to prompts/videos/scenes/scene_N.json. */
function writeScenePlan(sceneNumber: number, plan: ScenePlan): void {
  const dir = join(projectDir, 'prompts/videos/scenes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `scene_${sceneNumber}.json`), JSON.stringify(plan));
}

/** Drop a first-frame PNG on disk for s{scene}shot{shot}. */
function writeFirstFrame(sceneNum: number, shotNum: number, tag = 'a'): void {
  const dir = join(projectDir, 'assets/images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `s${sceneNum}shot${shotNum}_first_frame_${tag}.png`), 'png-bytes');
}

describe('readProjectStyle', () => {
  it('reads the declared style', () => {
    writeProjectJson('noir');
    expect(readProjectStyle(projectDir)).toBe('noir');
  });

  it('falls back to "cinematic" when style absent', () => {
    writeProjectJson(undefined);
    expect(readProjectStyle(projectDir)).toBe('cinematic');
  });

  it('falls back to "cinematic" when project.json is missing', () => {
    expect(readProjectStyle(projectDir)).toBe('cinematic');
  });

  it('falls back to "cinematic" when project.json is malformed', () => {
    writeFileSync(join(projectDir, 'project.json'), '{ not valid json');
    expect(readProjectStyle(projectDir)).toBe('cinematic');
  });
});

describe('loadScenePlan', () => {
  it('loads an existing scene plan', () => {
    const plan: ScenePlan = { sceneNumber: 2, sceneTitle: 'The Heist', shots: [{ shotNumber: 1, duration: 3 }] };
    writeScenePlan(2, plan);
    const loaded = loadScenePlan(projectDir, 2);
    expect(loaded.sceneTitle).toBe('The Heist');
    expect(loaded.shots).toHaveLength(1);
  });

  it('throws when the scene plan does not exist', () => {
    expect(() => loadScenePlan(projectDir, 99)).toThrow(/Scene plan not found/);
  });
});

describe('pickFirstFrame / shotHasFirstFrame', () => {
  it('finds a first frame on disk', () => {
    writeFirstFrame(1, 1);
    const result = pickFirstFrame(projectDir, 1, 1);
    expect(result).toContain('s1shot1_first_frame_a.png');
    expect(shotHasFirstFrame(projectDir, 1, 1)).toBe(true);
  });

  it('prefers the manifest scene_image over disk', () => {
    // Manifest path points to a relative path; manifest wins over disk scan.
    const manifest = {
      assets: [
        { type: 'scene_image', path: 'assets/images/s1shot1_first_frame_manifest.png', createdAt: 100 },
      ],
    };
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    writeFileSync(join(projectDir, 'assets/manifest.json'), JSON.stringify(manifest));
    writeFirstFrame(1, 1, 'disk');
    const result = pickFirstFrame(projectDir, 1, 1);
    expect(result).toContain('s1shot1_first_frame_manifest.png');
  });

  it('picks the most-recent manifest entry by createdAt', () => {
    const manifest = {
      assets: [
        { type: 'scene_image', path: 'assets/images/s1shot1_first_frame_old.png', createdAt: 10 },
        { type: 'scene_image', path: 'assets/images/s1shot1_first_frame_new.png', createdAt: 999 },
      ],
    };
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    writeFileSync(join(projectDir, 'assets/manifest.json'), JSON.stringify(manifest));
    const result = pickFirstFrame(projectDir, 1, 1);
    expect(result).toContain('s1shot1_first_frame_new.png');
  });

  it('throws when images dir is missing and no manifest match', () => {
    expect(() => pickFirstFrame(projectDir, 1, 1)).toThrow(/assets\/images\/ missing/);
    expect(shotHasFirstFrame(projectDir, 1, 1)).toBe(false);
  });

  it('throws when images dir exists but no matching frame', () => {
    mkdirSync(join(projectDir, 'assets/images'), { recursive: true });
    writeFileSync(join(projectDir, 'assets/images/unrelated.png'), 'x');
    expect(() => pickFirstFrame(projectDir, 1, 1)).toThrow(/No first_frame on disk/);
    expect(shotHasFirstFrame(projectDir, 1, 1)).toBe(false);
  });

  it('does not cross-match a different scene/shot', () => {
    writeFirstFrame(1, 1);
    // Looking for s1shot2 must not match the s1shot1 file.
    expect(shotHasFirstFrame(projectDir, 1, 2)).toBe(false);
  });
});

describe('resolveRelayInputs', () => {
  it('resolves a contiguous shot range with first frames + global prompt', () => {
    writeProjectJson('watercolor');
    writeScenePlan(1, {
      sceneTitle: 'Opening',
      shots: [
        { shotNumber: 1, duration: 2 },
        { shotNumber: 2, duration: 3 },
      ],
    });
    writeFirstFrame(1, 1);
    writeFirstFrame(1, 2);

    const resolved = resolveRelayInputs(projectDir, 1, [1, 2]);
    expect(resolved.shots).toHaveLength(2);
    expect(resolved.firstFrames).toHaveLength(2);
    expect(resolved.sceneTitle).toBe('Opening');
    expect(resolved.globalPrompt).toContain('watercolor style');
    expect(resolved.globalPrompt).toContain('Scene: Opening.');
  });

  it('omits sceneTitle from the global prompt when absent', () => {
    writeProjectJson('cinematic');
    writeScenePlan(1, { shots: [{ shotNumber: 1, duration: 2 }] });
    writeFirstFrame(1, 1);
    const resolved = resolveRelayInputs(projectDir, 1, [1, 1]);
    expect(resolved.globalPrompt).not.toContain('Scene:');
    expect(resolved.sceneTitle).toBeUndefined();
  });

  it('throws when the requested range has no shots', () => {
    writeScenePlan(1, { shots: [{ shotNumber: 1, duration: 2 }] });
    expect(() => resolveRelayInputs(projectDir, 1, [5, 7])).toThrow(/No shots in range/);
  });

  it('throws when the range is not fully contiguous (missing shot)', () => {
    // Range 1..3 expects 3 shots but only 1 and 3 exist -> 2 selected.
    writeScenePlan(1, {
      shots: [
        { shotNumber: 1, duration: 2 },
        { shotNumber: 3, duration: 2 },
      ],
    });
    expect(() => resolveRelayInputs(projectDir, 1, [1, 3])).toThrow(/contiguous shots/);
  });
});

describe('chunkScene — frame alignment + budgeting', () => {
  it('returns [] for an empty scene', () => {
    writeScenePlan(1, { shots: [] });
    expect(chunkScene(projectDir, 1, 1000, 24)).toEqual([]);
  });

  it('aligns a single shot to the LTX frame grid with +1 on the first segment', () => {
    // duration 2s @ 24fps = 48 raw frames -> round(48/8)*8 = 48; first-in-chunk +1 = 49
    writeScenePlan(1, { shots: [{ shotNumber: 1, duration: 2 }] });
    writeFirstFrame(1, 1);
    const chunks = chunkScene(projectDir, 1, 1000, 24);
    expect(chunks).toEqual([{ startShot: 1, endShot: 1, frames: 49 }]);
  });

  it('enforces the minimum of 8 frames for tiny durations', () => {
    // 0s -> max(8, 0) = 8; +1 first-segment = 9
    writeScenePlan(1, { shots: [{ shotNumber: 1, duration: 0 }] });
    writeFirstFrame(1, 1);
    const chunks = chunkScene(projectDir, 1, 1000, 24);
    expect(chunks[0]!.frames).toBe(9);
  });

  it('can disable the first-segment +1', () => {
    writeScenePlan(1, { shots: [{ shotNumber: 1, duration: 2 }] });
    writeFirstFrame(1, 1);
    const chunks = chunkScene(projectDir, 1, 1000, 24, false);
    expect(chunks[0]!.frames).toBe(48);
  });

  it('packs multiple shots into one chunk while under the cap', () => {
    // two 2s shots @24 = 48 + 48; first gets +1 -> 49 + 48 = 97, under cap 1000
    writeScenePlan(1, {
      shots: [
        { shotNumber: 1, duration: 2 },
        { shotNumber: 2, duration: 2 },
      ],
    });
    writeFirstFrame(1, 1);
    writeFirstFrame(1, 2);
    const chunks = chunkScene(projectDir, 1, 1000, 24);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startShot: 1, endShot: 2, frames: 97 });
  });

  it('splits into separate chunks when the frame cap would be exceeded', () => {
    // Each shot ~48 frames. Cap of 60 forces one shot per chunk.
    writeScenePlan(1, {
      shots: [
        { shotNumber: 1, duration: 2 },
        { shotNumber: 2, duration: 2 },
      ],
    });
    writeFirstFrame(1, 1);
    writeFirstFrame(1, 2);
    const chunks = chunkScene(projectDir, 1, 60, 24);
    expect(chunks).toHaveLength(2);
    // Each chunk's first segment gets the +1 (new chunk = first-in-chunk).
    expect(chunks[0]).toMatchObject({ startShot: 1, endShot: 1, frames: 49 });
    expect(chunks[1]).toMatchObject({ startShot: 2, endShot: 2, frames: 49 });
  });

  it('treats a missing first-frame as a chunk boundary and skips that shot', () => {
    // shot 2 has no first frame -> chunk ends at shot 1, shot 2 dropped,
    // shot 3 starts a fresh chunk.
    writeScenePlan(1, {
      shots: [
        { shotNumber: 1, duration: 2 },
        { shotNumber: 2, duration: 2 },
        { shotNumber: 3, duration: 2 },
      ],
    });
    writeFirstFrame(1, 1);
    // intentionally NO frame for shot 2
    writeFirstFrame(1, 3);
    const chunks = chunkScene(projectDir, 1, 1000, 24);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ startShot: 1, endShot: 1 });
    expect(chunks[1]).toMatchObject({ startShot: 3, endShot: 3 });
  });

  it('drops leading shots with no first-frame and starts the chunk later', () => {
    writeScenePlan(1, {
      shots: [
        { shotNumber: 1, duration: 2 },
        { shotNumber: 2, duration: 2 },
      ],
    });
    // only shot 2 has a frame
    writeFirstFrame(1, 2);
    const chunks = chunkScene(projectDir, 1, 1000, 24);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startShot: 2, endShot: 2 });
  });
});
