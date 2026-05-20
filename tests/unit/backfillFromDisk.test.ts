/**
 * The manifest carries stale paths (renamed files, content-hash legacy
 * names) and missing entries (rename script created files without
 * updating the manifest). Walking assets/images/ and assets/videos/shots/
 * directly using the shot-aware filename convention recovers paths the
 * manifest can't.
 *
 * Filename grammar:
 *   s<N>shot<M>_first_frame_<provider>_<id>.<ext>
 *   s<N>shot<M>_last_frame_<provider>_<id>.<ext>
 *   s<N>shot<M>_mid_frame_<provider>_<id>.<ext>
 *   s<N>shot<M>_<provider>_<id>.<ext>     (videos under videos/shots/)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backfillFromDisk } from "../../src/core/project/backfillFromDisk.js";

let dir: string;

function readProject(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
}

function touch(rel: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "x");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dhee-backfill-disk-"));
  mkdirSync(join(dir, "assets", "images"), { recursive: true });
  mkdirSync(join(dir, "assets", "videos", "shots"), { recursive: true });
  mkdirSync(join(dir, "assets", "videos", "final"), { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({ version: "3.0", id: "demo", title: "Demo", templateId: "narrative", assets: [] }, null, 2),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("backfillFromDisk — image filename grammar", () => {
  it("populates first/last/mid frames from shot-aware filenames", () => {
    touch("assets/images/s1shot1_first_frame_klein_aaa.png");
    touch("assets/images/s1shot1_last_frame_klein_bbb.png");
    touch("assets/images/s1shot1_mid_frame_klein_ccc.png");
    backfillFromDisk(dir);
    const p = readProject() as {
      scenes: Array<{ shots: Array<{ shotNumber: number; firstFrame?: { path: string }; lastFrame?: { path: string }; midFrame?: { path: string } }> }>;
    };
    const shot = p.scenes[0]!.shots[0]!;
    expect(shot.firstFrame?.path).toBe("assets/images/s1shot1_first_frame_klein_aaa.png");
    expect(shot.lastFrame?.path).toBe("assets/images/s1shot1_last_frame_klein_bbb.png");
    expect(shot.midFrame?.path).toBe("assets/images/s1shot1_mid_frame_klein_ccc.png");
  });

  it("recognizes alternate provider tokens (zimage, ltx, comfyui, grok…)", () => {
    touch("assets/images/s2shot4_first_frame_zimage_xxx.png");
    touch("assets/images/s2shot4_last_frame_grok_yyy.jpg");
    backfillFromDisk(dir);
    const p = readProject() as {
      scenes: Array<{ sceneNumber: number; shots: Array<{ shotNumber: number; firstFrame?: { path: string }; lastFrame?: { path: string } }> }>;
    };
    const scene = p.scenes.find((s) => s.sceneNumber === 2)!;
    const shot = scene.shots.find((s) => s.shotNumber === 4)!;
    expect(shot.firstFrame?.path).toBe("assets/images/s2shot4_first_frame_zimage_xxx.png");
    expect(shot.lastFrame?.path).toBe("assets/images/s2shot4_last_frame_grok_yyy.jpg");
  });

  it("picks the newest file per shot+frame when multiple variants exist (latest mtime)", async () => {
    touch("assets/images/s1shot1_first_frame_klein_old.png");
    // Bump the mtime of the second file by writing it later.
    await new Promise((r) => setTimeout(r, 25));
    touch("assets/images/s1shot1_first_frame_klein_new.png");
    backfillFromDisk(dir);
    const p = readProject() as {
      scenes: Array<{ shots: Array<{ firstFrame?: { path: string } }> }>;
    };
    expect(p.scenes[0]!.shots[0]!.firstFrame?.path).toBe(
      "assets/images/s1shot1_first_frame_klein_new.png",
    );
  });

  it("ignores filenames that don't fit the grammar", () => {
    touch("assets/images/CharRef_kai_xyz.png");
    touch("assets/images/SettingRef_alley_abc.png");
    touch("assets/images/random_thing.png");
    backfillFromDisk(dir);
    const p = readProject() as { scenes?: unknown[] };
    expect(p.scenes ?? []).toEqual([]);
  });
});

describe("backfillFromDisk — videos", () => {
  it("populates shot.video from assets/videos/shots/s<N>shot<M>_*.mp4", () => {
    touch("assets/videos/shots/s1shot2_ltx23_xyz.mp4");
    backfillFromDisk(dir);
    const p = readProject() as {
      scenes: Array<{ shots: Array<{ shotNumber: number; video?: { path: string } }> }>;
    };
    expect(p.scenes[0]!.shots[0]!.video?.path).toBe("assets/videos/shots/s1shot2_ltx23_xyz.mp4");
  });

  it("recognizes webm + mov in addition to mp4", () => {
    touch("assets/videos/shots/s1shot1_seedance_a.webm");
    touch("assets/videos/shots/s1shot2_ltx23_b.mov");
    backfillFromDisk(dir);
    const p = readProject() as { scenes: Array<{ shots: Array<{ video?: { path: string } }> }> };
    const shots = p.scenes[0]!.shots;
    expect(shots.find((s) => s.video?.path.endsWith(".webm"))).toBeDefined();
    expect(shots.find((s) => s.video?.path.endsWith(".mov"))).toBeDefined();
  });

  it("populates project.finalVideo from assets/videos/final/*", () => {
    touch("assets/videos/final/final_video.mp4");
    backfillFromDisk(dir);
    const p = readProject() as { finalVideo?: { path: string } };
    expect(p.finalVideo?.path).toBe("assets/videos/final/final_video.mp4");
  });
});

describe("backfillFromDisk — coexistence with manifest backfill", () => {
  it("overwrites stale manifest paths when an in-spec disk file exists", () => {
    // Simulate the prior manifest backfill having written a stale path.
    touch("assets/images/s1shot1_first_frame_klein_correct.png");
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        version: "3.0", id: "demo", title: "Demo", templateId: "narrative", assets: [],
        scenes: [{
          sceneNumber: 1,
          shots: [{
            shotNumber: 1,
            firstFrame: { path: "assets/images/Scene1_klein_correct.png", createdAt: 1 },
          }],
        }],
      }, null, 2),
    );
    backfillFromDisk(dir);
    const p = readProject() as {
      scenes: Array<{ shots: Array<{ firstFrame?: { path: string } }> }>;
    };
    expect(p.scenes[0]!.shots[0]!.firstFrame?.path).toBe(
      "assets/images/s1shot1_first_frame_klein_correct.png",
    );
  });
});
