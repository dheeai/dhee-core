/**
 * After the manifest + disk backfills run, project.scenes can still
 * carry stale paths pointing at files that don't exist (legacy
 * hash-only naming, files cleaned up after a rename). The verify pass
 * walks every shot slot, drops references to missing files, and
 * archives the dropped path to shot.history with reason: 'missing_file'.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyShotPaths } from "../../src/core/project/verifyShotPaths.js";

let dir: string;

function readProject(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
}

function touch(rel: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "x");
}

function setProject(data: Record<string, unknown>): void {
  writeFileSync(join(dir, "project.json"), JSON.stringify(data, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dhee-verify-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("verifyShotPaths", () => {
  it("drops a frame whose file is missing and archives it as missing_file", () => {
    setProject({
      scenes: [
        {
          sceneNumber: 1,
          shots: [
            {
              shotNumber: 1,
              firstFrame: { path: "assets/images/missing.png", createdAt: 1 },
            },
          ],
        },
      ],
    });
    const r = verifyShotPaths(dir);
    expect(r.dropped).toBe(1);
    const p = readProject() as {
      scenes: Array<{ shots: Array<{ firstFrame?: unknown; history?: Array<{ reason: string; firstFrame?: { path: string } }> }> }>;
    };
    const shot = p.scenes[0]!.shots[0]!;
    expect(shot.firstFrame).toBeUndefined();
    const dropped = shot.history?.find((h) => h.reason === "missing_file");
    expect(dropped?.firstFrame?.path).toBe("assets/images/missing.png");
  });

  it("preserves a frame whose file exists", () => {
    touch("assets/images/exists.png");
    setProject({
      scenes: [
        {
          sceneNumber: 1,
          shots: [{ shotNumber: 1, firstFrame: { path: "assets/images/exists.png", createdAt: 1 } }],
        },
      ],
    });
    verifyShotPaths(dir);
    const p = readProject() as {
      scenes: Array<{ shots: Array<{ firstFrame?: { path: string } }> }>;
    };
    expect(p.scenes[0]!.shots[0]!.firstFrame?.path).toBe("assets/images/exists.png");
  });

  it("drops video and finalVideo when their files are gone", () => {
    setProject({
      scenes: [
        {
          sceneNumber: 1,
          shots: [{ shotNumber: 1, video: { path: "assets/videos/shots/x.mp4", createdAt: 1 } }],
        },
      ],
      finalVideo: { path: "assets/videos/final/missing.mp4", createdAt: 2 },
    });
    const r = verifyShotPaths(dir);
    expect(r.dropped).toBe(2);
    const p = readProject() as {
      scenes: Array<{ shots: Array<{ video?: unknown }> }>;
      finalVideo?: unknown;
    };
    expect(p.scenes[0]!.shots[0]!.video).toBeUndefined();
    expect(p.finalVideo).toBeUndefined();
  });

  it("returns 0 dropped when everything checks out", () => {
    touch("assets/images/a.png");
    touch("assets/videos/shots/b.mp4");
    touch("assets/videos/final/c.mp4");
    setProject({
      scenes: [
        {
          sceneNumber: 1,
          shots: [
            {
              shotNumber: 1,
              firstFrame: { path: "assets/images/a.png", createdAt: 1 },
              video: { path: "assets/videos/shots/b.mp4", createdAt: 2 },
            },
          ],
        },
      ],
      finalVideo: { path: "assets/videos/final/c.mp4", createdAt: 3 },
    });
    const r = verifyShotPaths(dir);
    expect(r.dropped).toBe(0);
  });

  it("checks every slot type — first/last/mid/video — independently", () => {
    touch("assets/images/keep.png");
    setProject({
      scenes: [
        {
          sceneNumber: 1,
          shots: [
            {
              shotNumber: 1,
              firstFrame: { path: "assets/images/keep.png", createdAt: 1 },
              lastFrame: { path: "assets/images/gone1.png", createdAt: 2 },
              midFrame: { path: "assets/images/gone2.png", createdAt: 3 },
              video: { path: "assets/videos/shots/gone3.mp4", createdAt: 4 },
            },
          ],
        },
      ],
    });
    verifyShotPaths(dir);
    const p = readProject() as {
      scenes: Array<{ shots: Array<{ firstFrame?: { path: string }; lastFrame?: unknown; midFrame?: unknown; video?: unknown }> }>;
    };
    const shot = p.scenes[0]!.shots[0]!;
    expect(shot.firstFrame?.path).toBe("assets/images/keep.png");
    expect(shot.lastFrame).toBeUndefined();
    expect(shot.midFrame).toBeUndefined();
    expect(shot.video).toBeUndefined();
  });
});
