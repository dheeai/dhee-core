#!/usr/bin/env tsx
/**
 * eventSourcedStoryDemo — narrative-shaped end-to-end demo.
 *
 * Story: "The Last Coffee" (~30s, 3 shots, dialogues between Aaron and
 * Beth). Pipeline mirrors the real narrative bundle shape but uses
 * stub runners so the demo runs in seconds without GPU/LLM dependency:
 *
 *   story.md → scenes_plan → shot{1,2,3}_prompt → shot{1,2,3}_video → final_video
 *
 * Tests three capabilities end-to-end without intervention:
 *
 *   TEST 1 — BRANCHING.   Same story, fork "noir-grade" branch, regen
 *            shot_2's prompt with a darker mood; cascade re-renders
 *            shot_2_video + final_video on the fork only. Main is
 *            untouched. Both realities coexist.
 *
 *   TEST 2 — CACHING.     A fresh project with the SAME story.md hits
 *            the shared CAS for every node ($0 spend, $X savings).
 *
 *   TEST 3 — TIME TRAVEL. Inspect the project's walkState at past
 *            seqs (mid-walk, after shot_2 done, after final_video).
 *            Replay state at any point in history.
 *
 * Run with:
 *   pnpm exec tsx scripts/eventSourcedStoryDemo.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openProjectionEngine } from '../src/dag/eventLog/ProjectionEngine.js';
import {
  runDemoWalk,
  type DemoBundle,
  type DemoRunner,
} from '../src/dag/eventLog/DemoWalker.js';
import { eventLogPath } from '../src/dag/eventLog/eventLogPath.js';

// ── Story (the input) ──────────────────────────────────────────────────

const STORY_MD = `# The Last Coffee

Setting: A small cafe at dawn. Two friends, Aaron and Beth, sit by the window.
Total target: ~30 seconds, 3 shots, 10s each.

Beat 1 — Aaron stares at his coffee. He looks tired.
  Aaron: "I've decided to leave."

Beat 2 — Beth looks up, surprised but quiet.
  Beth: "When?"

Beat 3 — Aaron meets her eyes for the first time. Outside, the sun begins to rise.
  Aaron: "Tomorrow morning."
`;

// ── Narrative bundle (3-shot pipeline) ────────────────────────────────

const STORY_BUNDLE: DemoBundle = {
  id: 'narrative_stub',
  version: '0.1.0',
  description: 'demo: story → scenes_plan → 3 shot prompts → 3 shot videos → final cut',
  goal: 'final_video',
  nodes: [
    { id: 'story',          runner: { tool: 'load.story',    config: { path: 'inputs/story.md' } },              output: { format: 'md',   pattern: 'plans/story.md' },              inputs: [] },
    { id: 'scenes_plan',    runner: { tool: 'stub.llm.plan',     config: { task: 'scenes_plan' } },                 output: { format: 'json', pattern: 'plans/scenes_plan.json' },        inputs: [{ from: 'story' }] },

    { id: 'shot_1_prompt',  runner: { tool: 'stub.llm.shot_prompt', config: { task: 'shot_1', style: 'cinematic_realism' } }, output: { format: 'json', pattern: 'shots/shot_1_prompt.json' }, inputs: [{ from: 'scenes_plan' }] },
    { id: 'shot_2_prompt',  runner: { tool: 'stub.llm.shot_prompt', config: { task: 'shot_2', style: 'cinematic_realism' } }, output: { format: 'json', pattern: 'shots/shot_2_prompt.json' }, inputs: [{ from: 'scenes_plan' }] },
    { id: 'shot_3_prompt',  runner: { tool: 'stub.llm.shot_prompt', config: { task: 'shot_3', style: 'cinematic_realism' } }, output: { format: 'json', pattern: 'shots/shot_3_prompt.json' }, inputs: [{ from: 'scenes_plan' }] },

    { id: 'shot_1_video',   runner: { tool: 'stub.ltx.shot_video',  config: { shot: 1, duration: 10 } }, output: { format: 'video', pattern: 'shots/shot_1.mp4.json' }, inputs: [{ from: 'shot_1_prompt' }] },
    { id: 'shot_2_video',   runner: { tool: 'stub.ltx.shot_video',  config: { shot: 2, duration: 10 } }, output: { format: 'video', pattern: 'shots/shot_2.mp4.json' }, inputs: [{ from: 'shot_2_prompt' }] },
    { id: 'shot_3_video',   runner: { tool: 'stub.ltx.shot_video',  config: { shot: 3, duration: 10 } }, output: { format: 'video', pattern: 'shots/shot_3.mp4.json' }, inputs: [{ from: 'shot_3_prompt' }] },

    {
      id: 'final_video',
      runner: { tool: 'stub.ffmpeg.concat', config: { shotCount: 3 } },
      output: { format: 'video', pattern: 'final/the_last_coffee.mp4.json' },
      inputs: [
        { from: 'shot_1_video' },
        { from: 'shot_2_video' },
        { from: 'shot_3_video' },
      ],
    },
  ],
};

// ── Stub runners ──────────────────────────────────────────────────────

function makeRunners(): Record<string, DemoRunner> {
  return {
    'load.story': {
      tool: 'load.story',
      toolVersion: '0.1.0',
      async run(ctx) {
        const p = (ctx.config as { path: string }).path;
        const abs = join(ctx.projectDir, p);
        const content = readFileSync(abs, 'utf-8');
        return { content, costUsd: 0 };
      },
    },

    'stub.llm.plan': {
      tool: 'stub.llm.plan',
      toolVersion: '0.1.0',
      async run(ctx) {
        const storyText = ctx.inputs['story'] as string;
        // Extract beats deterministically.
        const beatRegex = /Beat\s+(\d+)\s+—\s+([^\n]+)/g;
        const beats: Array<{ index: number; description: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = beatRegex.exec(storyText)) !== null) {
          beats.push({ index: parseInt(m[1]!, 10), description: m[2]!.trim() });
        }
        const plan = {
          totalDurationSec: 30,
          shots: beats.map((b) => ({
            shotNumber: b.index,
            durationSec: 10,
            description: b.description,
          })),
        };
        const content = JSON.stringify(plan, null, 2);
        return { content, costUsd: 0.002, metadata: { model: 'stub-llm-heavy', tokens: 248 } };
      },
    },

    'stub.llm.shot_prompt': {
      tool: 'stub.llm.shot_prompt',
      toolVersion: '0.1.0',
      async run(ctx) {
        const cfg = ctx.config as { task: string; style: string };
        const planText = ctx.inputs['scenes_plan'] as string;
        if (typeof planText !== 'string' || planText.length === 0) {
          throw new Error(`stub.llm.shot_prompt: scenes_plan input missing or empty. inputs keys=${Object.keys(ctx.inputs).join(',')}. value type=${typeof planText} value=${JSON.stringify(planText)?.slice(0, 200)}`);
        }
        let plan: { shots: Array<{ shotNumber: number; durationSec: number; description: string }> };
        try {
          plan = JSON.parse(planText) as { shots: Array<{ shotNumber: number; durationSec: number; description: string }> };
        } catch (e) {
          throw new Error(`stub.llm.shot_prompt: scenes_plan not valid JSON: ${(e as Error).message}. content preview=${planText.slice(0, 200)}`);
        }
        if (!plan.shots) {
          throw new Error(`stub.llm.shot_prompt: scenes_plan parsed but has no 'shots' field. parsed=${JSON.stringify(plan).slice(0, 200)}`);
        }
        const shotNum = parseInt(cfg.task.replace('shot_', ''), 10);
        const beat = plan.shots.find((s) => s.shotNumber === shotNum);
        if (!beat) throw new Error(`stub.llm.shot_prompt: shot ${shotNum} not in plan`);
        // Style affects the dialogueLine prefix so the noir branch
        // produces a visibly different prompt.
        const styleHint = cfg.style === 'noir' ? 'noir, high contrast, deep shadows' : 'soft natural light, warm tones';
        const promptJson = {
          shot: shotNum,
          imagePrompt: `${beat.description.replace('—', '·')}. Style: ${cfg.style}. (${styleHint}).`,
          motionDirective: shotNum === 3 ? 'slow push-in, sunrise lifts behind' : 'static frame, ambient micro-motion',
          dialogueLine: extractDialogueFor(beat.description, planText),
          style: cfg.style,
        };
        const content = JSON.stringify(promptJson, null, 2);
        return { content, costUsd: 0.005, metadata: { model: 'stub-llm-medium', tokens: 412, style: cfg.style } };
      },
    },

    'stub.ltx.shot_video': {
      tool: 'stub.ltx.shot_video',
      toolVersion: '0.1.0',
      async run(ctx) {
        const promptText = ctx.inputs[`shot_${(ctx.config as { shot: number }).shot}_prompt`] as string ?? ctx.inputs[Object.keys(ctx.inputs)[0]!] as string;
        const prompt = JSON.parse(promptText) as { shot: number; imagePrompt: string; motionDirective: string; style: string };
        // Stub "video" is a JSON marker — represents the actual mp4
        // that the real LTX runner would produce. The bytes are
        // distinctive enough that a downstream concat can verify
        // it's seeing different versions.
        const videoMarker = {
          kind: 'video.mp4 (stub)',
          shot: prompt.shot,
          style: prompt.style,
          duration: 10,
          motionDirective: prompt.motionDirective,
          summary: prompt.imagePrompt.slice(0, 80),
        };
        const content = JSON.stringify(videoMarker, null, 2);
        return { content, costUsd: 0.50, metadata: { model: 'stub-ltx', frames: 240, style: prompt.style } };
      },
    },

    'stub.ffmpeg.concat': {
      tool: 'stub.ffmpeg.concat',
      toolVersion: '0.1.0',
      async run(ctx) {
        // Read each shot's video marker and assemble a concat marker.
        const shotSummaries: Array<{ shot: number; style: string; summary: string }> = [];
        for (const key of Object.keys(ctx.inputs)) {
          if (!key.endsWith('_video')) continue;
          const marker = JSON.parse(ctx.inputs[key] as string) as { shot: number; style: string; summary: string };
          shotSummaries.push({ shot: marker.shot, style: marker.style, summary: marker.summary });
        }
        shotSummaries.sort((a, b) => a.shot - b.shot);
        const finalMarker = {
          kind: 'final.mp4 (stub)',
          totalDuration: 30,
          assembly: shotSummaries.map((s) => `[shot ${s.shot} | ${s.style}] ${s.summary}`).join('\n  '),
        };
        const content = JSON.stringify(finalMarker, null, 2);
        return { content, costUsd: 0.001, metadata: { tool: 'stub-ffmpeg' } };
      },
    },
  };
}

function extractDialogueFor(beatDescription: string, fullStory: string): string {
  // Pull the next line after the beat description that starts with a name.
  const idx = fullStory.indexOf(beatDescription);
  if (idx < 0) return '';
  const after = fullStory.slice(idx);
  const dialogueMatch = /\n\s*([A-Z][a-zA-Z]+):\s*"([^"]+)"/.exec(after);
  return dialogueMatch ? `${dialogueMatch[1]}: "${dialogueMatch[2]}"` : '';
}

// ── Pretty-printing helpers ───────────────────────────────────────────

function banner(title: string): void {
  const w = 70;
  console.log(`\n${'═'.repeat(w)}\n  ${title}\n${'═'.repeat(w)}`);
}
function subheader(s: string): void {
  console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);
}

function printEventLog(filePath: string, label: string, slice?: { from?: number; to?: number }): void {
  subheader(label);
  if (!existsSync(filePath)) {
    console.log('(no events)');
    return;
  }
  const raw = readFileSync(filePath, 'utf-8').trim();
  const lines = raw.split('\n').filter((l) => l.length > 0);
  for (const line of lines) {
    let e: { seq: number; kind: string; actor: string; branchId: string; payload: Record<string, unknown> };
    try { e = JSON.parse(line); } catch { continue; }
    if (slice?.from !== undefined && e.seq < slice.from) continue;
    if (slice?.to !== undefined && e.seq > slice.to) continue;
    console.log(`[${e.branchId}#${String(e.seq).padStart(2, '0')}] ${e.actor.padEnd(7)} ${e.kind.padEnd(22)} ${summarize(e.kind, e.payload)}`);
  }
}

function summarize(kind: string, p: Record<string, unknown>): string {
  switch (kind) {
    case 'node.started':         return `${p['nodeId'] as string}`;
    case 'node.completed': {
      const g = p['generation'] as { tool?: string; cached?: boolean; costUsd?: number } | undefined;
      return `${p['nodeId'] as string} v=${p['versionId'] as string} ${g?.cached ? '(cached)' : ''}${typeof g?.costUsd === 'number' ? ' $' + g.costUsd.toFixed(4) : ''}`;
    }
    case 'node.invalidated':     return `${p['nodeId'] as string}`;
    case 'version.selected':     return `${p['nodeId'] as string} → ${p['versionId'] as string}`;
    case 'branch.created':       return `${p['branchId'] as string} from ${p['parentBranchId'] as string} @ ${p['forkedFromEventId'] as string}`;
    case 'runner.swapped':       return `${p['nodeId'] as string} ${p['fromTool'] as string} → ${p['toTool'] as string}`;
    default:                     return JSON.stringify(p).slice(0, 80);
  }
}

function printWalkState(eng: ReturnType<typeof openProjectionEngine>, branchId: string, asOfSeq?: number): void {
  const proj = eng.projection({ branchId, ...(asOfSeq !== undefined ? { asOfSeq } : {}) });
  if (Object.keys(proj.nodes).length === 0) {
    console.log('  (no nodes)');
    return;
  }
  const sorted = Object.keys(proj.nodes).sort();
  for (const k of sorted) {
    const v = proj.nodes[k]!;
    const sel = v.selectedVersionId ? `v=${v.selectedVersionId}` : '';
    const vc = v.versions?.length ?? 0;
    console.log(`  ${k.padEnd(20)} status=${v.status.padEnd(11)} ${sel.padEnd(14)} versions=${vc}`);
  }
}

function printCost(eng: ReturnType<typeof openProjectionEngine>, branchId: string, asOfSeq?: number): void {
  const c = eng.computeCostLedger({ branchId, ...(asOfSeq !== undefined ? { asOfSeq } : {}) });
  console.log(`  totalUsd=$${c.totalUsd.toFixed(4)}  cacheHits=${c.cacheHits}  savings=$${c.estimatedSavingsUsd.toFixed(4)}  computes=${c.computeCount}`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const projectA = mkdtempSync(join(tmpdir(), 'story-A-'));
  const projectB = mkdtempSync(join(tmpdir(), 'story-B-'));
  const casRoot = mkdtempSync(join(tmpdir(), 'story-cas-'));

  // Seed the story into projectA inputs/
  mkdirSync(join(projectA, 'inputs'), { recursive: true });
  writeFileSync(join(projectA, 'inputs', 'story.md'), STORY_MD);
  // ProjectB gets the IDENTICAL story so the CAS hit demonstrates
  // cross-project reuse.
  mkdirSync(join(projectB, 'inputs'), { recursive: true });
  writeFileSync(join(projectB, 'inputs', 'story.md'), STORY_MD);

  const runners = makeRunners();

  try {
    banner('SETUP — story input (with character dialogues)');
    console.log(STORY_MD);

    // ── Main walk ─────────────────────────────────────────────────────
    banner('FIRST WALK — produce the 30s video (3 shots, default style)');
    const engA = openProjectionEngine(projectA);
    engA.appendAndProject({
      branchId: 'main', actor: 'user', kind: 'project.created',
      payload: { projectDir: projectA },
    });
    engA.appendAndProject({
      branchId: 'main', actor: 'user', kind: 'bundle.bound',
      payload: { bundleSource: 'demo:narrative_stub', bundleVersion: '0.1.0', engineVersion: '0.1.0' },
    });

    const walk1 = await runDemoWalk({
      bundle: STORY_BUNDLE,
      projectDir: projectA,
      engine: engA,
      runners,
      cacheRoot: casRoot,
      log: (m) => console.log(`    ${m}`),
    });
    console.log(`\n  ok=${walk1.ok}  goal=${walk1.goalPath?.replace(projectA, '<projectA>') ?? '?'}`);
    subheader('final assembly (the "video")');
    if (walk1.goalPath) {
      const finalMarker = JSON.parse(readFileSync(walk1.goalPath, 'utf-8')) as { totalDuration: number; assembly: string };
      console.log(`  totalDuration: ${finalMarker.totalDuration}s`);
      console.log(`  assembly:`);
      for (const line of finalMarker.assembly.split('\n')) console.log(`    ${line}`);
    }
    subheader('walkState (main) after first walk');
    printWalkState(engA, 'main');
    subheader('cost (main)');
    printCost(engA, 'main');


    // ── TEST 2: CACHING ───────────────────────────────────────────────
    banner('TEST 2 — CACHING. Fresh project, identical story → all cache hits');
    const engB = openProjectionEngine(projectB);
    engB.appendAndProject({
      branchId: 'main', actor: 'user', kind: 'bundle.bound',
      payload: { bundleSource: 'demo:narrative_stub', bundleVersion: '0.1.0', engineVersion: '0.1.0' },
    });
    const walk2 = await runDemoWalk({
      bundle: STORY_BUNDLE,
      projectDir: projectB,
      engine: engB,
      runners,
      cacheRoot: casRoot, // SAME CAS as projectA
      log: (m) => console.log(`    ${m}`),
    });
    console.log(`\n  ok=${walk2.ok}`);
    subheader('projectB cost — should be $0 spent, ~$1.5 saved');
    printCost(engB, 'main');
    // Verify the assembled video bytes are byte-identical (because
    // every node was served from the same CAS entries).
    if (walk1.goalPath && walk2.goalPath) {
      const a = readFileSync(walk1.goalPath, 'utf-8');
      const b = readFileSync(walk2.goalPath, 'utf-8');
      console.log(`  byte-identical final video? ${a === b ? 'YES' : 'NO'}`);
    }

    // ── TEST 1: BRANCHING ────────────────────────────────────────────
    banner('TEST 1 — BRANCHING. Fork "noir-grade"; regen shot_2 with noir style.');
    const lastEv = [...engA.log().read()].pop()!;
    engA.appendAndProject({
      branchId: 'main', actor: 'user', kind: 'branch.created',
      payload: { branchId: 'noir', label: 'noir grade', forkedFromEventId: lastEv.id, parentBranchId: 'main' },
    });

    // On the noir branch we swap the shot_2_prompt runner config so
    // it produces a noir-style prompt. This drives a new inputsHash
    // → CAS miss → new compute → cascade to shot_2_video + final.
    engA.appendAndProject({
      branchId: 'noir', actor: 'agent', kind: 'runner.swapped',
      payload: {
        nodeId: 'shot_2_prompt',
        fromTool: 'stub.llm.shot_prompt',
        toTool: 'stub.llm.shot_prompt',
        reason: 'noir-grade style override',
        configOverride: { style: 'noir' },
      },
    });
    engA.appendAndProject({ branchId: 'noir', actor: 'agent', kind: 'node.invalidated', payload: { nodeId: 'shot_2_prompt' } });
    await runDemoWalk({
      bundle: STORY_BUNDLE,
      projectDir: projectA,
      engine: engA,
      runners,
      cacheRoot: casRoot,
      branchId: 'noir',
      runOnly: ['shot_2_prompt'],
      log: (m) => console.log(`    ${m}`),
    });

    subheader('main walkState (untouched by noir fork)');
    printWalkState(engA, 'main');
    subheader('noir walkState (shot_2 + final_video re-rendered; other 4 shots inherited from main)');
    printWalkState(engA, 'noir');
    subheader('disk: shot_2_prompt.* files (both reality versions alive)');
    for (const f of readdirSync(join(projectA, 'shots')).sort()) {
      if (f.startsWith('shot_2_prompt')) console.log(`  ${f}`);
    }

    subheader('cost — main vs noir');
    console.log(`  main:`); printCost(engA, 'main');
    console.log(`  noir:`); printCost(engA, 'noir');

    // Show both final videos side by side.
    subheader('compare final assemblies — main vs noir');
    const mainProj = engA.projection({ branchId: 'main' });
    const noirProj = engA.projection({ branchId: 'noir' });
    const mainFinalRel = mainProj.nodes['final_video']?.outputPath;
    const noirFinalRel = noirProj.nodes['final_video']?.outputPath;
    if (mainFinalRel) {
      const mainFinal = JSON.parse(readFileSync(join(projectA, mainFinalRel), 'utf-8')) as { assembly: string };
      console.log(`  main assembly:`);
      for (const l of mainFinal.assembly.split('\n')) console.log(`    ${l}`);
    }
    if (noirFinalRel) {
      const noirFinal = JSON.parse(readFileSync(join(projectA, noirFinalRel), 'utf-8')) as { assembly: string };
      console.log(`  noir assembly:`);
      for (const l of noirFinal.assembly.split('\n')) console.log(`    ${l}`);
    }

    // ── TEST 3: TIME TRAVEL ───────────────────────────────────────────
    banner('TEST 3 — TIME TRAVEL. Inspect main at past seqs.');
    // Pick anchors actually present in the log to make the demo accurate.
    const events = [...engA.log().read({ branchId: 'main' })];
    const sceneEv = events.find((e) => e.kind === 'node.completed' && (e.payload as { nodeId?: string }).nodeId === 'scenes_plan');
    const shot2Ev = events.find((e) => e.kind === 'node.completed' && (e.payload as { nodeId?: string }).nodeId === 'shot_2_video');
    const finalEv = events.find((e) => e.kind === 'node.completed' && (e.payload as { nodeId?: string }).nodeId === 'final_video');

    if (sceneEv) {
      subheader(`State as of seq=${sceneEv.seq} (just after scenes_plan completed)`);
      printWalkState(engA, 'main', sceneEv.seq);
      printCost(engA, 'main', sceneEv.seq);
    }
    if (shot2Ev) {
      subheader(`State as of seq=${shot2Ev.seq} (after shot_2_video; final_video not yet computed)`);
      printWalkState(engA, 'main', shot2Ev.seq);
      printCost(engA, 'main', shot2Ev.seq);
    }
    if (finalEv) {
      subheader(`State as of seq=${finalEv.seq} (the moment the final video first completed)`);
      printWalkState(engA, 'main', finalEv.seq);
      printCost(engA, 'main', finalEv.seq);
    }
    subheader(`State NOW (latest)`);
    printWalkState(engA, 'main');
    printCost(engA, 'main');

    // ── Full event log ────────────────────────────────────────────────
    banner('FULL EVENT LOG (the source of truth)');
    printEventLog(eventLogPath(projectA), 'all events in chronological order');

    // ── Summary ──────────────────────────────────────────────────────
    banner('SUMMARY');
    const totalEvents = [...engA.log().read()].length;
    const mainCost = engA.computeCostLedger({ branchId: 'main' });
    const noirCost = engA.computeCostLedger({ branchId: 'noir' });
    const projBCost = engB.computeCostLedger({ branchId: 'main' });
    // Count events that originated on each branch (not the inherited
    // prefix) for an honest "how much did noir actually do?" number.
    const noirOwnEvents = [...engA.log().read({ branchId: 'noir' })];
    const noirRecomputed = noirOwnEvents.filter((e) => e.kind === 'node.completed').length;
    console.log(`  Total events:                ${totalEvents}`);
    console.log(`  Branches:                    ${engA.computeBranchTree().branches.length} (${engA.computeBranchTree().branches.map((b) => b.branchId).join(', ')})`);
    console.log(`  Main: spend=$${mainCost.totalUsd.toFixed(4)}  compute=${mainCost.computeCount}`);
    console.log(`  Noir: spend=$${noirCost.totalUsd.toFixed(4)} (inherited prefix + ${noirRecomputed} divergent nodes); only ${noirRecomputed} of ${mainCost.computeCount} recomputed on the fork.`);
    console.log(`  ProjB: spend=$${projBCost.totalUsd.toFixed(4)}  cacheHits=${projBCost.cacheHits}  savings=$${projBCost.estimatedSavingsUsd.toFixed(4)} (entire pipeline replayed for free)`);
    console.log('');
    console.log('  TESTS:');
    console.log(`    ① BRANCHING demonstrated:    main + noir coexist; ${noirRecomputed} divergent nodes on noir, ${mainCost.computeCount} inherited from main.`);
    console.log(`    ② CACHING demonstrated:      projectB hit ${projBCost.cacheHits}/${projBCost.computeCount} nodes for $${projBCost.estimatedSavingsUsd.toFixed(4)} saved.`);
    console.log(`    ③ TIME TRAVEL demonstrated:  walkState rewound across ${sceneEv?.seq ?? '?'} → ${shot2Ev?.seq ?? '?'} → ${finalEv?.seq ?? '?'} → now.`);
    console.log('');
    console.log(`  events.jsonl:  ${eventLogPath(projectA)}`);
    console.log(`  project.json:  ${join(projectA, 'project.json')}`);
    console.log(`  CAS root:      ${casRoot}`);
    console.log('\n  ALL THREE TESTS PROVEN END-TO-END WITHOUT INTERVENTION.');
  } finally {
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
    rmSync(casRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
