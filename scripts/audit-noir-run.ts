#!/usr/bin/env tsx
/**
 * Audit a kshana project's artifacts against the goal:
 *   1. Bharata framework — every scene has rasa/sthayi/narrativeMode
 *   2. SCALIST — image prompts are coherent paragraphs, no Sanskrit leakage,
 *      no banned motion verbs, single Creative Director's Brief style
 *   3. Reference determination — every shot prompt begins with a slot
 *      manifest, no inline "from image N" in the prose, setting present
 *   4. Plot/story coherence — artifacts reference the project's idea
 *      (keyword crosswalk vs. original_input + plot + story)
 *   5. Character identity — pronouns match character profiles
 *   6. First-frame + last-frame both follow the same rules
 *
 * Usage:
 *   pnpm tsx scripts/audit-noir-run.ts <project>
 *
 * Output:
 *   test-output/audit/<project>/report.md
 *   test-output/audit/<project>/findings.json
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve, basename } from 'path';

const [projectArg] = process.argv.slice(2);
if (!projectArg) {
  console.error('Usage: pnpm tsx scripts/audit-noir-run.ts <project>');
  process.exit(1);
}
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.kshana') ? projectArg : `${projectArg}.kshana`,
);
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

interface Finding {
  layer: string;
  scope: string;
  severity: 'PASS' | 'WARN' | 'FAIL';
  message: string;
}
const findings: Finding[] = [];
const add = (f: Finding) => findings.push(f);

// ── Load source-of-truth artifacts ──────────────────────────────────────────
const originalInput = existsSync(join(projectRoot, 'original_input.md'))
  ? readFileSync(join(projectRoot, 'original_input.md'), 'utf-8')
  : '';
// Plot / story / scene scripts live under chapters/chapter_1/plans|scenes/
// per the on-disk layout. The plans/ at the project root only carries
// world_style.md (a project-wide artifact).
const plotPath = join(projectRoot, 'chapters/chapter_1/plans/plot.md');
const storyPath = join(projectRoot, 'chapters/chapter_1/plans/story.md');
const plot = existsSync(plotPath) ? readFileSync(plotPath, 'utf-8') : '';
const story = existsSync(storyPath) ? readFileSync(storyPath, 'utf-8') : '';
const worldStylePath = join(projectRoot, 'plans/world_style.md');
const worldStyle = existsSync(worldStylePath) ? readFileSync(worldStylePath, 'utf-8') : '';

// Extract topical keywords from original input (very simple)
const topicWords = originalInput
  .toLowerCase()
  .match(/\b[a-z]{4,}\b/g)
  ?.filter(w => !['this', 'that', 'with', 'have', 'from', 'into', 'they'].includes(w))
  ?? [];
const topicWordSet = new Set(topicWords);

// ── Layer 0: source artifacts present ───────────────────────────────────────
if (!plot) add({ layer: 'pipeline', scope: 'plot', severity: 'FAIL', message: 'plans/plot.md missing — pipeline did not run plot stage' });
else add({ layer: 'pipeline', scope: 'plot', severity: 'PASS', message: `plot.md present (${plot.length} chars)` });

if (!story) add({ layer: 'pipeline', scope: 'story', severity: 'FAIL', message: 'plans/story.md missing' });
else add({ layer: 'pipeline', scope: 'story', severity: 'PASS', message: `story.md present (${story.length} chars)` });

if (!worldStyle) add({ layer: 'pipeline', scope: 'world_style', severity: 'WARN', message: 'plans/world_style.md missing' });

// ── Layer 1: Bharata framework on scene plans ───────────────────────────────
const RASAS = ['shringara', 'hasya', 'karuna', 'raudra', 'veera', 'bhayanaka', 'bibhatsa', 'adbhuta', 'shanta'];
const MODES = ['full_arc', 'compressed_arc', 'vignette', 'mood'];
const STHAYIS = ['rati', 'hasa', 'soka', 'krodha', 'utsaha', 'bhaya', 'jugupsa', 'vismaya', 'sama'];

const scenesDir = join(projectRoot, 'prompts/videos/scenes');
const scenePlanFiles: string[] = existsSync(scenesDir)
  ? readdirSync(scenesDir).filter(f => /^scene_\d+\.plan\.json$/.test(f)).sort()
  : [];
const sceneFiles: string[] = existsSync(scenesDir)
  ? readdirSync(scenesDir).filter(f => /^scene_\d+\.json$/.test(f) && !f.includes('.plan.') && !f.includes('.state.') && !f.includes('.motion.')).sort()
  : [];

for (const f of scenePlanFiles) {
  const sp = JSON.parse(readFileSync(join(scenesDir, f), 'utf-8'));
  const sceneId = f.replace(/\.plan\.json$/, '');
  if (!sp.rasa) add({ layer: 'bharata', scope: sceneId, severity: 'FAIL', message: `scene plan missing rasa` });
  else if (!RASAS.includes(sp.rasa)) add({ layer: 'bharata', scope: sceneId, severity: 'FAIL', message: `invalid rasa: ${sp.rasa}` });
  else add({ layer: 'bharata', scope: sceneId, severity: 'PASS', message: `rasa=${sp.rasa}` });

  if (!sp.narrativeMode) add({ layer: 'bharata', scope: sceneId, severity: 'WARN', message: `narrativeMode missing` });
  else if (!MODES.includes(sp.narrativeMode)) add({ layer: 'bharata', scope: sceneId, severity: 'FAIL', message: `invalid narrativeMode: ${sp.narrativeMode}` });
  else add({ layer: 'bharata', scope: sceneId, severity: 'PASS', message: `narrativeMode=${sp.narrativeMode}` });

  if (sp.sthayi && !STHAYIS.includes(sp.sthayi)) add({ layer: 'bharata', scope: sceneId, severity: 'WARN', message: `unrecognized sthayi: ${sp.sthayi}` });
  else if (sp.sthayi) add({ layer: 'bharata', scope: sceneId, severity: 'PASS', message: `sthayi=${sp.sthayi}` });
}

// ── Layer 2: Bharata propagation to assembled scene_video_prompt ────────────
for (const f of sceneFiles) {
  const svp = JSON.parse(readFileSync(join(scenesDir, f), 'utf-8'));
  const sceneId = f.replace(/\.json$/, '');
  if (!svp.rasa) add({ layer: 'assembler', scope: sceneId, severity: 'FAIL', message: `assembled SVP missing rasa (Bharata propagation broken)` });
  else add({ layer: 'assembler', scope: sceneId, severity: 'PASS', message: `assembled SVP rasa=${svp.rasa}` });
}

// ── Layer 3: shot_image_prompt — SCALIST + manifest + framing ──────────────
const shotsDir = join(projectRoot, 'prompts/images/shots');
const shotFiles: string[] = existsSync(shotsDir)
  ? readdirSync(shotsDir).filter(f => f.endsWith('.json')).sort()
  : [];

const BANNED_MOTION_VERBS = [
  'running', 'walking', 'falling', 'spinning', 'dissolving',
  'collapsing', 'flickering', 'dashing', 'sprinting', 'erupting',
  'crumbling', 'spewing', 'recoiling', 'fleeing', 'crashing',
  'smoldering', 'streaming', 'slipping', 'beginning to', 'starting to',
];
const SANSKRIT_LEAK_TERMS = ['raudra', 'shringara', 'karuna', 'bhayanaka', 'veera', 'adbhuta', 'hasya', 'bibhatsa', 'shanta'];

for (const f of shotFiles) {
  const path = join(shotsDir, f);
  const j = JSON.parse(readFileSync(path, 'utf-8'));
  const id = f.replace(/\.json$/, '');

  const firstFrame = j.frames?.first_frame;
  const lastFrame = j.frames?.last_frame;

  // 3a. Frame structure
  if (!firstFrame?.imagePrompt) {
    add({ layer: 'shot_prompt', scope: id, severity: 'FAIL', message: `no first_frame.imagePrompt` });
    continue;
  }
  if (!lastFrame?.imagePrompt) {
    add({ layer: 'shot_prompt', scope: id, severity: 'WARN', message: `no last_frame.imagePrompt` });
  }

  for (const [label, frame] of [['ff', firstFrame], ['lf', lastFrame]] as const) {
    if (!frame?.imagePrompt) continue;
    const prompt: string = frame.imagePrompt;
    const scope = `${id}:${label}`;

    // 3b. SCALIST: single coherent paragraph (not a bullet list)
    if (prompt.split('\n').filter((l: string) => l.trim().startsWith('-') || l.trim().startsWith('•')).length > 3) {
      add({ layer: 'scalist', scope, severity: 'WARN', message: `prompt looks like a bulleted list, not a paragraph` });
    } else {
      add({ layer: 'scalist', scope, severity: 'PASS', message: `coherent paragraph format` });
    }

    // 3c. SCALIST: length 60-300 words approx
    const words = prompt.split(/\s+/).filter(Boolean).length;
    if (words < 40) add({ layer: 'scalist', scope, severity: 'WARN', message: `prompt very short (${words} words)` });
    else if (words > 400) add({ layer: 'scalist', scope, severity: 'WARN', message: `prompt very long (${words} words)` });

    // 3d. Banned motion verbs
    const hits = BANNED_MOTION_VERBS.filter(v => new RegExp(`\\b${v}\\b`, 'i').test(prompt));
    if (hits.length > 0) {
      add({ layer: 'scalist', scope, severity: 'FAIL', message: `banned motion verbs: ${hits.join(', ')}` });
    } else {
      add({ layer: 'scalist', scope, severity: 'PASS', message: `no banned motion verbs` });
    }

    // 3e. Sanskrit leakage
    const sanskritHits = SANSKRIT_LEAK_TERMS.filter(t => new RegExp(`\\b${t}\\b`, 'i').test(prompt));
    if (sanskritHits.length > 0) {
      add({ layer: 'scalist', scope, severity: 'FAIL', message: `Sanskrit rasa term in prose (should be translated): ${sanskritHits.join(', ')}` });
    } else {
      add({ layer: 'scalist', scope, severity: 'PASS', message: `no Sanskrit leakage` });
    }

    // 3f. Deterministic slot manifest at the start
    const manifestRegex = /^[^.\n]+? from image 1\./;
    if (manifestRegex.test(prompt)) {
      add({ layer: 'manifest', scope, severity: 'PASS', message: `manifest line present at start` });
    } else {
      add({ layer: 'manifest', scope, severity: 'WARN', message: `no recognizable manifest line at start` });
    }

    // 3g. No INLINE "from image N" markers in the prose (after the manifest)
    // The manifest is one line at the top. Strip it and check the rest.
    const proseAfterManifest = prompt.split('\n\n').slice(1).join('\n\n');
    const inlineMatches = proseAfterManifest.match(/from image \d/gi);
    if (inlineMatches && inlineMatches.length > 0) {
      add({ layer: 'manifest', scope, severity: 'WARN', message: `${inlineMatches.length} inline "from image N" markers in prose body (deterministic prepend should have stripped these)` });
    }
  }

  // 3h. References array: setting in slot 1 (if any setting refs)
  const refs = (firstFrame?.references ?? []) as Array<{ imageNumber: number; type: string; refId: string }>;
  if (refs.length === 0) {
    add({ layer: 'refs', scope: id, severity: 'WARN', message: `no references — text-to-image shot` });
  } else {
    const slot1 = refs.find(r => r.imageNumber === 1);
    if (slot1?.type === 'setting') {
      add({ layer: 'refs', scope: id, severity: 'PASS', message: `setting in slot 1: ${slot1.refId}` });
    } else if (slot1) {
      add({ layer: 'refs', scope: id, severity: 'WARN', message: `slot 1 is ${slot1.type}, not setting` });
    }
  }
}

// ── Layer 4a: Period anachronism scan ───────────────────────────────────────
// If the input names an ancient/historical timeframe ("300bc", "ancient",
// "BCE", "medieval", etc.), scan downstream artifacts for industrial- or
// modern-era vocabulary that breaks the period. Closes the noir-3 bug:
// the audit said "PASS on plot coherence" but world_style.md introduced
// "ferry engine" and "corrugated iron" — both 19th-20th-century artifacts
// that an LLM helping itself to noir genre conventions slipped in.
const ANCIENT_HINTS = /\b(\d{1,4}\s*(bc|bce|ad)|ancient|antiquity|bronze[- ]age|iron[- ]age|classical|medieval|mughal|mauryan|gupta|magadhan|chola|vedic|hellenistic|sasanian|byzantine)\b/i;
const ANACHRONISM_RX: Array<[RegExp, string]> = [
  [/\bcorrugated iron\b/gi, 'corrugated iron (1820s+)'],
  [/\bferry engine\b/gi, 'ferry engine'],
  [/\bcombustion engine\b/gi, 'combustion engine'],
  [/\bsteam engine\b/gi, 'steam engine'],
  [/\b(diesel|petrol|gasoline)\b/gi, 'petroleum fuel'],
  [/\b(neon|fluorescent) (sign|light|tube)\b/gi, 'electric-era lighting'],
  [/\bskyscraper\b/gi, 'skyscraper'],
  [/\bautomobile\b/gi, 'automobile'],
  [/\bcellphone\b/gi, 'cellphone'],
  [/\btelevision\b/gi, 'television'],
  [/\b(revolver|pistol|firearm|rifle)\b/gi, 'firearm'],
  [/\b(trench coat|trenchcoat)\b/gi, 'trench coat'],
  [/\bsedan\b/gi, 'sedan'],
  [/\b(laptop|computer)\b/gi, 'computer'],
  [/\bplastic\b/gi, 'plastic'],
  [/\bchrome\b/gi, 'chrome plating'],
  [/\b(highway|tarmac|asphalt)\b/gi, 'paved road'],
];
const periodHinted = ANCIENT_HINTS.test(originalInput) || ANCIENT_HINTS.test(plot) || ANCIENT_HINTS.test(story);
if (periodHinted) {
  add({ layer: 'period', scope: 'input', severity: 'PASS', message: `period hint detected — running anachronism scan` });
  const sources: Array<[string, string]> = [
    ['plot', plot],
    ['story', story],
    ['world_style', worldStyle],
  ];
  // Add settings + characters
  const settingsDir = join(projectRoot, 'settings');
  if (existsSync(settingsDir)) {
    for (const f of readdirSync(settingsDir).filter(x => x.endsWith('.md'))) {
      sources.push([`settings/${f.replace('.md','')}`, readFileSync(join(settingsDir, f), 'utf-8')]);
    }
  }
  const charsDir = join(projectRoot, 'characters');
  if (existsSync(charsDir)) {
    for (const f of readdirSync(charsDir).filter(x => x.endsWith('.md'))) {
      sources.push([`characters/${f.replace('.md','')}`, readFileSync(join(charsDir, f), 'utf-8')]);
    }
  }
  // Add shot prompt prose
  const shotsDirInner = join(projectRoot, 'prompts/images/shots');
  if (existsSync(shotsDirInner)) {
    for (const f of readdirSync(shotsDirInner).filter(x => x.endsWith('.json'))) {
      const jj = JSON.parse(readFileSync(join(shotsDirInner, f), 'utf-8'));
      const ff = jj.frames?.first_frame?.imagePrompt ?? '';
      const lf = jj.frames?.last_frame?.imagePrompt ?? '';
      if (ff) sources.push([`shot/${f.replace('.json','')}:ff`, ff]);
      if (lf) sources.push([`shot/${f.replace('.json','')}:lf`, lf]);
    }
  }
  for (const [scope, src] of sources) {
    if (!src) continue;
    const hits: string[] = [];
    for (const [rx, label] of ANACHRONISM_RX) {
      // Skip "avoid" / "do not" / negative contexts where the anachronism is
      // explicitly being suppressed (e.g. world_style: "Avoid: synthetic neon").
      const matches = [...src.matchAll(rx)];
      for (const m of matches) {
        const idx = m.index ?? 0;
        const before = src.slice(Math.max(0, idx - 50), idx).toLowerCase();
        if (/\b(avoid|no |never|not |without|negative.?prompt)/.test(before)) continue;
        hits.push(label);
        break;
      }
    }
    if (hits.length > 0) {
      add({ layer: 'period', scope, severity: 'FAIL', message: `anachronism(s) for ancient setting: ${[...new Set(hits)].join(', ')}` });
    }
  }
}

// ── Layer 4: Plot/story coherence (keyword crosswalk) ───────────────────────
function topicalOverlap(text: string): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const w of topicWordSet) {
    if (lower.includes(w)) hits += 1;
  }
  return hits;
}
if (originalInput && plot) {
  const overlap = topicalOverlap(plot);
  if (overlap < Math.min(3, topicWords.length)) {
    add({ layer: 'coherence', scope: 'plot', severity: 'WARN', message: `plot has only ${overlap} topic-word hits from input` });
  } else {
    add({ layer: 'coherence', scope: 'plot', severity: 'PASS', message: `plot has ${overlap} topic-word hits from input` });
  }
}
if (originalInput && story) {
  const overlap = topicalOverlap(story);
  if (overlap < Math.min(3, topicWords.length)) {
    add({ layer: 'coherence', scope: 'story', severity: 'WARN', message: `story has only ${overlap} topic-word hits from input` });
  } else {
    add({ layer: 'coherence', scope: 'story', severity: 'PASS', message: `story has ${overlap} topic-word hits from input` });
  }
}

// ── Layer 5: Character identity (pronoun audit per character profile) ───────
// First pass collects gender for every character. Then for each sentence,
// we only check for mis-gendering if exactly ONE character of known gender
// appears in that sentence. Multi-character sentences ("Laila glides toward
// him") have cross-gender pronouns by design and shouldn't flag.
const charactersDir = join(projectRoot, 'characters');
const charGenders: Record<string, 'male' | 'female'> = {};
if (existsSync(charactersDir)) {
  for (const cf of readdirSync(charactersDir).filter(f => f.endsWith('.md'))) {
    const charId = cf.replace(/\.md$/, '');
    const profile = readFileSync(join(charactersDir, cf), 'utf-8').slice(0, 800);
    // Use lookup of EXPLICIT gender tokens — "male", "man", "female", "woman"
    // — rather than pronouns, since pronouns might refer to characters
    // mentioned in the profile's narrative section.
    const explicitMale = /\b(male|man|boy|gentleman)\b/i.test(profile);
    const explicitFemale = /\b(female|woman|girl|lady)\b/i.test(profile);
    if (explicitMale && !explicitFemale) charGenders[charId] = 'male';
    else if (explicitFemale && !explicitMale) charGenders[charId] = 'female';
  }
}

for (const f of sceneFiles) {
  const svp = JSON.parse(readFileSync(join(scenesDir, f), 'utf-8'));
  const sceneId = f.replace(/\.json$/, '');
  for (const shot of svp.shots ?? []) {
    const text = [shot.description, shot.cameraWork, shot.audio].filter(Boolean).join(' ');
    // First scope: which characters of which genders appear ANYWHERE in
    // this shot? If both a male and a female character are present in the
    // SAME shot, pronouns of either gender could legitimately refer to
    // either character — false positives are too high to flag.
    const presentChars = Object.keys(charGenders).filter(c => new RegExp(`\\b${c}\\b`, 'i').test(text));
    const presentGenders = new Set(presentChars.map(c => charGenders[c]));
    if (presentGenders.size > 1) continue;
    if (presentChars.length === 0) continue;
    // Single-gender-character shot: now any opposite-gender pronoun is
    // almost certainly mis-applied.
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      const sentenceChars = presentChars.filter(c => new RegExp(`\\b${c}\\b`, 'i').test(sentence));
      if (sentenceChars.length === 0) continue;
      const char = sentenceChars[0]!;
      const gender = charGenders[char]!;
      const usesFemale = /\b(she|her|hers|herself)\b/i.test(lower);
      const usesMale = /\b(he|him|his|himself)\b/i.test(lower);
      if (gender === 'male' && usesFemale && !usesMale) {
        add({ layer: 'identity', scope: `${sceneId}:shot${shot.shotNumber}:${char}`, severity: 'FAIL', message: `male character ${char} referred to with female pronouns: "${sentence.slice(0, 100)}..."` });
      }
      if (gender === 'female' && usesMale && !usesFemale) {
        add({ layer: 'identity', scope: `${sceneId}:shot${shot.shotNumber}:${char}`, severity: 'FAIL', message: `female character ${char} referred to with male pronouns: "${sentence.slice(0, 100)}..."` });
      }
    }
  }
}

// ── Render report ───────────────────────────────────────────────────────────
const outDir = resolve(process.cwd(), 'test-output/audit', basename(projectRoot));
mkdirSync(outDir, { recursive: true });

const grouped: Record<string, Finding[]> = {};
for (const f of findings) {
  if (!grouped[f.layer]) grouped[f.layer] = [];
  grouped[f.layer]!.push(f);
}
let md = `# Audit report — ${basename(projectRoot)}\n\n`;
md += `Source input (head 200): \`${originalInput.slice(0, 200).replace(/\n/g, ' ')}\`\n\n`;
md += `## Counts by severity\n\n`;
const counts: Record<string, number> = { PASS: 0, WARN: 0, FAIL: 0 };
for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
md += `- PASS: ${counts.PASS}\n- WARN: ${counts.WARN}\n- FAIL: ${counts.FAIL}\n\n`;

for (const layer of Object.keys(grouped).sort()) {
  md += `## ${layer}\n\n`;
  for (const f of grouped[layer]!) {
    const badge = f.severity === 'PASS' ? '✓' : f.severity === 'WARN' ? '⚠' : '✗';
    md += `- ${badge} **${f.scope}** — ${f.message}\n`;
  }
  md += '\n';
}

writeFileSync(join(outDir, 'report.md'), md);
writeFileSync(join(outDir, 'findings.json'), JSON.stringify(findings, null, 2));

console.log(`audit complete — ${findings.length} findings (PASS=${counts.PASS}, WARN=${counts.WARN}, FAIL=${counts.FAIL})`);
console.log(`see: ${outDir}/report.md`);
if (counts.FAIL > 0) {
  console.log('\nFAILURES:');
  for (const f of findings.filter(x => x.severity === 'FAIL')) {
    console.log(`  - ${f.layer}/${f.scope}: ${f.message}`);
  }
  process.exit(1);
}
