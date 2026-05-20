#!/usr/bin/env tsx
/**
 * Create a new dhee-core project from a text input.
 *
 * Required flags:
 *   --style <s>      `live` (cinematic_realism) or `anime` (animation)
 *   --duration <sec> target video length in seconds
 *
 * Three input modes (pick one):
 *   1. STDIN     pnpm new my_story --style live --duration 60 <<EOF
 *                A woman fled a betrothal...
 *                EOF
 *
 *   2. INLINE    pnpm new my_story --text "A woman fled..." --style anime --duration 60
 *
 *   3. FILE      pnpm new my_story --input story.md --style live --duration 90
 *
 * Optional: --template <id> (default: narrative), --type <idea|story>.
 *
 * The actual scaffolding logic lives in
 * `src/server/runners/createProjectInProcess.ts` so the pi-agent /
 * packaged desktop / library callers all share the same code path.
 * This script is the CLI wrapper: arg parsing, stdin reading, error
 * formatting, exit codes.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  createProjectInProcess,
  CreateProjectError,
} from '../src/server/runners/createProjectInProcess.js';

interface Args {
  projectName: string;
  inputFile?: string;
  inputText?: string;
  style?: string;
  duration?: number;
  templateId?: string;
  inputType?: 'idea' | 'story';
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length < 1 || argv[0]!.startsWith('--')) {
    printUsageAndExit();
  }

  const projectName = argv[0]!;
  let inputFile: string | undefined;
  let inputText: string | undefined;
  let style: string | undefined;
  let duration: number | undefined;
  let templateId: string | undefined;
  let inputType: 'idea' | 'story' | undefined;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case '--input':
      case '-i':
        inputFile = next;
        i += 1;
        break;
      case '--text':
        inputText = next;
        i += 1;
        break;
      case '--style':
      case '-s':
        style = next;
        i += 1;
        break;
      case '--duration':
      case '-d':
        duration = next ? parseInt(next, 10) : undefined;
        i += 1;
        break;
      case '--template':
      case '-t':
        templateId = next;
        i += 1;
        break;
      case '--type':
        if (next !== 'idea' && next !== 'story') {
          console.error(
            `--type must be 'idea' or 'story', got: ${next ?? '(missing)'}`,
          );
          printUsageAndExit();
        }
        inputType = next;
        i += 1;
        break;
      case '--help':
      case '-h':
        printUsageAndExit(0);
      default:
        console.error(`Unknown argument: ${a}`);
        printUsageAndExit();
    }
  }
  return { projectName, inputFile, inputText, style, duration, templateId, inputType };
}

/** Read all of stdin as UTF-8. Returns empty string if stdin is a TTY (no pipe). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function printUsageAndExit(code: number = 1): never {
  console.error(
    'Usage: pnpm new <project-name> --style <style> --duration <sec> [input-source] [options]',
  );
  console.error('');
  console.error('Required:');
  console.error('  --style, -s <style>   live  (= cinematic_realism, photorealistic / live-action)');
  console.error('                        anime (= animation, stylized 2D)');
  console.error('  --duration, -d <sec>  target video duration in seconds (e.g. 30, 60, 120)');
  console.error('');
  console.error('Input source (pick ONE):');
  console.error('  (default)             read from stdin    `echo "..." | pnpm new myproj ...`');
  console.error('  --text "..."          pass inline text');
  console.error('  --input, -i <file>    read from a file');
  console.error('');
  console.error('Optional:');
  console.error('  --template, -t <id>   template id (default: narrative)');
  console.error('  --type <idea|story>   force input type (skip auto-detection).');
  console.error("                        'story' skips plot generation — use when input is a full story.");
  console.error('');
  console.error('Examples:');
  console.error('  pnpm new noir_60s --style live --duration 60 --text "A noir detective..."');
  console.error('  echo "Story..." | pnpm new my_anime --style anime --duration 30');
  process.exit(code);
}

// resolveStyle is also re-exported by createProjectInProcess so callers
// can validate before invoking. Keep this `export` for legacy import paths.
export { resolveStyle } from '../src/server/runners/createProjectInProcess.js';

async function main() {
  const args = parseArgs();

  // Resolve input content from one of: --input file, --text inline, or stdin.
  if (args.inputFile && args.inputText !== undefined) {
    console.error('Error: pass only one of --input or --text, not both.');
    printUsageAndExit();
  }
  let inputContent: string;
  let inputSource: string;
  if (args.inputFile) {
    const inputPath = resolve(args.inputFile);
    if (!existsSync(inputPath)) {
      console.error(`Input file not found: ${inputPath}`);
      process.exit(1);
    }
    inputContent = readFileSync(inputPath, 'utf-8');
    inputSource = inputPath;
  } else if (args.inputText !== undefined) {
    inputContent = args.inputText;
    inputSource = '(--text inline)';
  } else {
    inputContent = await readStdin();
    if (!inputContent.trim()) {
      console.error('Error: no input provided. Pipe content via stdin, or use --text or --input.');
      console.error('Examples:');
      console.error('  echo "A woman fled..." | pnpm new myproj');
      console.error('  pnpm new myproj --text "A woman fled..."');
      console.error('  pnpm new myproj --input story.md');
      process.exit(1);
    }
    inputSource = '(stdin)';
  }

  // Validate the rest at the CLI level so we can produce nicer
  // messages than the library's CreateProjectError. createProjectInProcess
  // also validates these, but the messages there are shorter.
  if (!args.style) {
    console.error('Error: --style is required. Pick one of: live, anime');
    console.error('  live  → cinematic_realism (photorealistic, live-action look)');
    console.error('  anime → animation (stylized 2D)');
    printUsageAndExit();
  }
  if (args.duration === undefined) {
    console.error('Error: --duration is required (target video length in seconds, e.g. 60).');
    printUsageAndExit();
  }

  console.log(`Creating project: ${args.projectName}.dhee`);
  console.log(`  Source:     ${inputSource} (${inputContent.length} bytes)`);
  console.log(`  Style:      ${args.style!}`);
  console.log(`  Duration:   ${args.duration!}s`);
  console.log(`  Template:   ${args.templateId ?? 'narrative'}`);
  console.log('');

  try {
    const result = createProjectInProcess({
      name: args.projectName,
      input: inputContent,
      style: args.style!,
      duration: args.duration!,
      basePath: process.cwd(),
      ...(args.templateId ? { templateId: args.templateId } : {}),
      ...(args.inputType ? { inputType: args.inputType } : {}),
    });

    console.log('Created.');
    console.log('');
    console.log(`  resolved style:     ${result.resolvedStyle}`);
    console.log(`  detected inputType: ${result.project.inputType}`);
    console.log(`  initial phase:      ${result.project.currentPhase}`);
    console.log('');
    console.log('Next steps:');
    console.log(`  pnpm run-to ${args.projectName}                # run to final video`);
    console.log(`  pnpm run-to ${args.projectName} scene          # stop after scene prose`);
    console.log(`  pnpm run-to ${args.projectName} scene_video_prompt   # stop after shot planning`);
    console.log(`  pnpm reset ${args.projectName} <stage> [--clean]    # roll back to a stage`);
  } catch (err) {
    if (err instanceof CreateProjectError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

// Only run when executed directly (not when imported). Mirrors the
// guard in scripts/reset-project.ts so the resolveStyle re-export
// above can be imported safely if anyone wants to.
const isDirectExecution = process.argv[1]?.endsWith('new-project.ts');
if (isDirectExecution) {
  main().catch((err) => {
    console.error('Failed to create project:', err);
    process.exit(1);
  });
}
