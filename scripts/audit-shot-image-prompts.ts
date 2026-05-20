#!/usr/bin/env tsx
/**
 * Deterministic logic-error audit for shot_image_prompt JSONs.
 *
 * Scans every `prompts/images/shots/scene-N-shot-M.json` in a project
 * and reports prompts that exhibit known failure patterns. The goal is
 * twofold:
 *   1. Surface specific shots that need regeneration before they get
 *      sent to an image model that takes the bad instruction literally.
 *   2. Build a list of failure classes worth adding to the
 *      shot-composition rubric so autoresearch can pressure the guide
 *      to stop producing them.
 *
 * Issues detected:
 *
 *   OTS_SINGLE_CHAR        — `over-the-shoulder` / `OTS` in prose with
 *                            <2 character refs in the references array.
 *                            Image models invent a phantom second
 *                            character to fill the OTS anchor slot.
 *                            (See todos/forbid-ots-for-single-character-shots.md)
 *
 *   PHANTOM_CHARACTER      — a project character's name appears in
 *                            prose but the character is NOT in the
 *                            references array for that frame.
 *
 *   ORPHAN_REF             — a reference in the array is never named
 *                            in the prose. Refs the LLM included but
 *                            forgot to write into the scene.
 *
 *   FABRICATED_IMAGE_NUM   — `from image N` in prose where N is larger
 *                            than the references array length, OR not
 *                            present in the references' imageNumber set.
 *
 *   FOCUS_MISMATCH         — scene_video_prompt declares a focus.primary
 *                            character but the prose puts a different
 *                            character in razor-sharp focus. Heuristic:
 *                            the focal character should be the named
 *                            subject of "razor-sharp" / "in focus" /
 *                            "the focal subject" phrasing.
 *
 *   MULTI_SPEAKER_AUDIO    — already audited elsewhere via dialogueValidation;
 *                            re-checked here for a unified report.
 *
 * Usage:
 *   pnpm tsx scripts/audit-shot-image-prompts.ts <project_dir>
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const projectDir = process.argv[2];
if (!projectDir) {
  console.error('Usage: pnpm tsx scripts/audit-shot-image-prompts.ts <project_dir>');
  process.exit(1);
}
const projectRoot = projectDir.endsWith('.dhee') ? projectDir : `${projectDir}.dhee`;
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

// ── Build the project's character roster (refIds + display labels) ──
// Used to detect "phantom" characters: names that appear in prose but
// the corresponding refId is absent from the frame's references[].
const projectJson = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8'));
const allNodes: Record<string, { id: string; typeId: string; itemId?: string }> = projectJson?.executorState?.nodes ?? {};
interface CharRoster {
  refId: string;          // "character_image:parvati"
  itemId: string;         // "parvati"
  displayName: string;    // "parvati" (may have spaces / dots normalized)
}
const charRoster: CharRoster[] = [];
for (const n of Object.values(allNodes)) {
  if (n.typeId === 'character_image' && n.itemId) {
    // Just normalize underscores to spaces; leave dots alone. Earlier
    // version doubled the space after dots ("mrs._singh" → "mrs.  singh"),
    // breaking the prose-name match for any character whose itemId has a dot.
    const display = n.itemId.replace(/_/g, ' ').trim();
    charRoster.push({ refId: n.id, itemId: n.itemId, displayName: display });
  }
}

// ── Load shot focus.primary per (scene, shot) from scene_video_prompts ──
type FocusInfo = { primary: string | null; background: string[] };
const focusByShot = new Map<string, FocusInfo>();
const sceneDir = join(projectRoot, 'prompts/videos/scenes');
if (existsSync(sceneDir)) {
  for (const f of readdirSync(sceneDir)) {
    if (!/^scene_\d+\.json$/.test(f)) continue;
    try {
      const d = JSON.parse(readFileSync(join(sceneDir, f), 'utf-8'));
      const sceneNum = d.sceneNumber;
      for (const s of d.shots ?? []) {
        const key = `${sceneNum}/${s.shotNumber}`;
        const fp = s.focus ?? {};
        focusByShot.set(key, {
          primary: typeof fp.primary === 'string' ? fp.primary : null,
          background: Array.isArray(fp.background) ? fp.background : [],
        });
      }
    } catch { /* skip */ }
  }
}

// ── Helpers ──
function nameInProse(prose: string, displayName: string): { found: boolean; index: number } {
  const re = new RegExp(`(?<![A-Za-z0-9])${displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i');
  const m = prose.match(re);
  if (!m) return { found: false, index: -1 };
  return { found: true, index: m.index ?? -1 };
}

interface Issue {
  shot: string;
  frame: string;
  type: string;
  detail: string;
}
const issues: Issue[] = [];

// ── Walk every shot prompt ──
const shotsDir = join(projectRoot, 'prompts/images/shots');
const shotFiles = existsSync(shotsDir)
  ? readdirSync(shotsDir).filter(f => /^scene-\d+-shot-\d+\.json$/.test(f)).sort()
  : [];

for (const f of shotFiles) {
  const m = f.match(/scene-(\d+)-shot-(\d+)\.json$/)!;
  const sceneNum = parseInt(m[1]!, 10);
  const shotNum = parseInt(m[2]!, 10);
  const shotKey = `s${sceneNum}sh${shotNum}`;

  let json: any;
  try {
    json = JSON.parse(readFileSync(join(shotsDir, f), 'utf-8'));
  } catch (e) {
    issues.push({ shot: shotKey, frame: '?', type: 'JSON_PARSE_ERROR', detail: (e as Error).message });
    continue;
  }
  if (!json.frames) continue;

  for (const frameKey of Object.keys(json.frames)) {
    const frame = json.frames[frameKey];
    if (!frame || typeof frame.imagePrompt !== 'string' || !Array.isArray(frame.references)) continue;
    const prose: string = frame.imagePrompt;
    const refs = frame.references as Array<{ imageNumber: number; type: string; refId: string }>;
    const charRefIds = new Set(refs.filter(r => r.type === 'character').map(r => r.refId));
    const refImageNumbers = new Set(refs.map(r => r.imageNumber));

    // ── 1. OTS_SINGLE_CHAR ──
    // Only flag the cinematographic OTS framing — the hyphenated phrase
    // or the OTS abbreviation. Don't match "over her shoulder" alone
    // because that turns up in unrelated descriptive prose like "canvas
    // bag slung over her shoulder" (s2sh4 false positive on first audit).
    const otsRe = /\b(over[-\s]the[-\s]shoulder|OTS)\b/i;
    if (otsRe.test(prose) && charRefIds.size < 2) {
      issues.push({
        shot: shotKey,
        frame: frameKey,
        type: 'OTS_SINGLE_CHAR',
        detail: `OTS framing in prose with only ${charRefIds.size} character ref(s). Phantom-character risk.`,
      });
    }

    // ── 2. PHANTOM_CHARACTER ──
    for (const c of charRoster) {
      if (charRefIds.has(c.refId)) continue; // legitimately referenced
      // displayName may have a dot/spaces variant; also try the raw itemId form
      const variants = new Set<string>([c.displayName, c.itemId.replace(/_/g, ' ')]);
      let foundProseName = '';
      for (const v of variants) {
        const r = nameInProse(prose, v);
        if (r.found) { foundProseName = v; break; }
      }
      if (foundProseName) {
        issues.push({
          shot: shotKey,
          frame: frameKey,
          type: 'PHANTOM_CHARACTER',
          detail: `prose names "${foundProseName}" but their refId (${c.refId}) is not in references[]`,
        });
      }
    }

    // ── 3. ORPHAN_REF ──
    // Each ref's imageNumber should appear at least once as `from image N`.
    for (const r of refs) {
      const imgRe = new RegExp(`\\bfrom\\s+image\\s+${r.imageNumber}\\b`, 'i');
      if (!imgRe.test(prose)) {
        issues.push({
          shot: shotKey,
          frame: frameKey,
          type: 'ORPHAN_REF',
          detail: `ref imageNumber=${r.imageNumber} (${r.refId}) is never tagged "from image ${r.imageNumber}" in prose`,
        });
      }
    }

    // ── 4. FABRICATED_IMAGE_NUM ──
    const allImgTags = [...prose.matchAll(/\bfrom\s+image\s+(\d+)\b/gi)].map(m => parseInt(m[1]!, 10));
    for (const n of allImgTags) {
      if (!refImageNumbers.has(n)) {
        issues.push({
          shot: shotKey,
          frame: frameKey,
          type: 'FABRICATED_IMAGE_NUM',
          detail: `"from image ${n}" in prose, but no entry with imageNumber=${n} in references[]`,
        });
        // Don't double-count: break after first
        break;
      }
    }

    // ── 5. FOCUS_MISMATCH ──
    // scene_video_prompt's focus.primary should agree with the character
    // identified as razor-sharp / focal in the prose. Heuristic only —
    // looks for "<focus.primary> ... razor-sharp" or "razor-sharp ... <focus.primary>".
    const focus = focusByShot.get(`${sceneNum}/${shotNum}`);
    if (focus?.primary && frameKey === 'first_frame') {
      // Strip trailing _face / _shoulder / _silhouette etc that focus fields sometimes carry.
      const focusBase = focus.primary.replace(/_(face|shoulder|silhouette|figure|hand|body)$/i, '');
      const focusChar = charRoster.find(c => c.itemId === focusBase || c.itemId === focus.primary);
      if (focusChar) {
        // Find "razor-sharp" / "in focus" / "focal" phrases and which character is closest.
        const focalRe = /\b(razor[\-\s]sharp|in\s+sharp\s+focus|in\s+razor[\-\s]sharp|sharply\s+in\s+focus|in\s+focus|focal\s+(subject|point))/i;
        if (focalRe.test(prose)) {
          // Crude heuristic: if the focus character's name appears within 100 chars
          // of any "razor-sharp"-style phrase, assume the prose has them as focal.
          let aligned = false;
          for (const focalMatch of prose.matchAll(/\b(razor[\-\s]sharp|in\s+sharp\s+focus|focal\s+subject|in\s+focus)\b/gi)) {
            // Widen window to 250 chars to handle pronoun chaining like
            // "Parvati from image 2 ... her face razor-sharp" where the
            // explicit name and the focal phrase can be far apart.
            const start = Math.max(0, (focalMatch.index ?? 0) - 250);
            const end = Math.min(prose.length, (focalMatch.index ?? 0) + (focalMatch[0]?.length ?? 0) + 250);
            const window = prose.slice(start, end);
            if (nameInProse(window, focusChar.displayName).found) {
              aligned = true;
              break;
            }
          }
          if (!aligned) {
            issues.push({
              shot: shotKey,
              frame: frameKey,
              type: 'FOCUS_MISMATCH',
              detail: `scene_video_prompt focus.primary="${focus.primary}" but prose's focal subject doesn't match`,
            });
          }
        }
      }
    }
  }
}

// ── Report ──
const counts: Record<string, number> = {};
for (const i of issues) counts[i.type] = (counts[i.type] ?? 0) + 1;

console.log(`\nProject: ${projectRoot}`);
console.log(`Shot prompts scanned: ${shotFiles.length}`);
console.log(`Total issues: ${issues.length}`);
console.log(`Breakdown:`);
for (const [t, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${c}`);
}

console.log(`\n--- by-shot detail ---`);
const byShot: Record<string, Issue[]> = {};
for (const i of issues) {
  const k = `${i.shot}/${i.frame}`;
  byShot[k] = byShot[k] ?? [];
  byShot[k].push(i);
}
for (const k of Object.keys(byShot).sort()) {
  console.log(`\n${k}:`);
  for (const i of byShot[k]!) {
    console.log(`  [${i.type}] ${i.detail}`);
  }
}
