/**
 * CLI to render infographic clips via Remotion.
 * Usage: pnpm run render -- --input <json-path> --outDir <dir> [--output <json-path>]
 * Requires: pnpm run build (remotion bundle) run first. Uses build/ as serveUrl.
 *
 * Input JSON: { "placements": [ { "placementNumber": 1, "startTime": "0:45", "endTime": "1:00",
 *   "infographicType": "statistic", "prompt": "...", "componentName": "Infographic1" }, ... ] }
 *
 * Writes <outDir>/info<N>_<id>.webm (with alpha). If --output is given, writes { "outputs": [...] }
 * to that file (stdout is not used for JSON).
 *
 * Environment variables:
 *   REMOTION_BUILD_TIMEOUT  — build timeout in ms (default: 120000 = 2 min)
 *   REMOTION_RENDER_TIMEOUT — per-placement render timeout in ms (default: 600000 = 10 min)
 */
import { selectComposition, renderMedia } from '@remotion/renderer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname);
const buildDir = path.join(projectRoot, 'build');

function getEnvTimeout(envVar: string, defaultMs: number): number {
  const raw = process.env[envVar];
  if (!raw) return defaultMs;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 1000 ? defaultMs : n;
}

function parseArgs(): { input: string; outDir: string; output: string | null } {
  const args = process.argv.slice(2);
  let input = '';
  let outDir = '';
  let output: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) input = args[i + 1];
    if (args[i] === '--outDir' && args[i + 1]) outDir = args[i + 1];
    if (args[i] === '--output' && args[i + 1]) output = args[i + 1];
  }
  if (!input || !outDir) {
    console.error('Usage: pnpm run render -- --input <json-path> --outDir <dir> [--output <json-path>]');
    process.exit(1);
  }
  return { input, outDir, output };
}

function timeToSeconds(timeStr: string): number {
  const parts = timeStr.split(':');
  if (parts.length === 3) {
    return (parseInt(parts[0], 10) || 0) * 3600 + (parseInt(parts[1], 10) || 0) * 60 + (parseInt(parts[2], 10) || 0);
  }
  if (parts.length === 2) {
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }
  return parseInt(timeStr, 10) || 5;
}

function writeOutputs(outputPath: string | null, outputs: string[]): void {
  const json = JSON.stringify({ outputs });
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, 'utf-8');
  } else {
    console.log(json);
  }
}

interface PlacementInput {
  placementNumber: number;
  startTime: string;
  endTime: string;
  infographicType: string;
  prompt: string;
  data?: Record<string, unknown>;
  componentName: string;
}

async function main() {
  const { input: inputPath, outDir, output: outputPath } = parseArgs();
  const raw = fs.readFileSync(inputPath, 'utf-8');
  const { placements } = JSON.parse(raw) as { placements: PlacementInput[] };

  if (!placements || placements.length === 0) {
    writeOutputs(outputPath, []);
    return;
  }

  if (!fs.existsSync(buildDir) || !fs.existsSync(path.join(buildDir, 'index.html'))) {
    console.error('Remotion bundle not found. Run: pnpm run build');
    process.exit(1);
  }

  const serveUrl = buildDir;
  const fps = 24;
  const outputs: string[] = [];
  const total = placements.length;
  const renderTimeout = getEnvTimeout('REMOTION_RENDER_TIMEOUT', 600_000);

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const progressStart = i / total;
    console.log(`REMOTION_PROGRESS:${JSON.stringify({
      placementIndex: i,
      totalPlacements: total,
      progress: progressStart,
      stage: 'rendering',
    })}`);

    const durationSeconds = Math.max(1, timeToSeconds(p.endTime) - timeToSeconds(p.startTime));
    const durationInFrames = Math.round(durationSeconds * fps);
    const inputProps = {
      prompt: p.prompt,
      infographicType: p.infographicType,
      data: p.data ?? {},
    };

    const composition = await selectComposition({
      serveUrl,
      id: p.componentName,
      inputProps,
    });
    composition.durationInFrames = durationInFrames;

    const baseName = `info${p.placementNumber}_${Date.now().toString(36)}`;
    const outFilePath = path.join(outDir, `${baseName}.webm`);
    fs.mkdirSync(outDir, { recursive: true });

    await renderMedia({
      composition,
      serveUrl,
      codec: 'vp9',
      outputLocation: outFilePath,
      inputProps,
      logLevel: 'error',
      pixelFormat: 'yuva420p',
      imageFormat: 'png',
      timeoutInMilliseconds: renderTimeout,
    });

    outputs.push(outFilePath);
    const progressEnd = (i + 1) / total;
    console.log(`REMOTION_PROGRESS:${JSON.stringify({
      placementIndex: i,
      totalPlacements: total,
      progress: progressEnd,
      stage: 'rendering',
    })}`);
  }

  writeOutputs(outputPath, outputs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
