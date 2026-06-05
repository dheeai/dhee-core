/**
 * llm-usage-report — print a chat-vs-walker spend summary from the
 * per-call telemetry written by recordLlmUsage (issue #102 #0).
 *
 * Run:  pnpm tsx scripts/llm-usage-report.ts [path]
 * Defaults to <logs>/llm-usage.jsonl (or $DHEE_USAGE_TELEMETRY_PATH).
 *
 * This is the lens that answers the issue's questions from data:
 *   - what's the chat-vs-walker spend split?
 *   - what's each lane's cached-token ratio (did prompt-caching help)?
 *   - what's each lane's input:output ratio (the runaway-context symptom)?
 */
import {
  readUsageRecords,
  summarizeUsage,
  usageTelemetryPath,
  type LaneSummary,
} from '../src/core/llm/usageTelemetry.js';

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
function ratio(r: number): string {
  return r === Infinity ? '∞' : r.toFixed(2);
}
function line(label: string, s: LaneSummary): void {
  console.log(
    `  ${label.padEnd(8)} calls=${String(s.calls).padStart(5)}  ` +
      `prompt=${fmt(s.promptTokens).padStart(12)}  ` +
      `cached=${fmt(s.cachedTokens).padStart(12)} (${(s.cachedRatio * 100).toFixed(0)}%)  ` +
      `out=${fmt(s.completionTokens).padStart(9)}  ` +
      `in:out=${ratio(s.inputOutputRatio).padStart(7)}  ` +
      `cost=$${s.costUsd.toFixed(4)}`,
  );
}

const path = process.argv[2] ?? usageTelemetryPath();
const records = readUsageRecords(path);

if (records.length === 0) {
  console.log(`No telemetry records at ${path}.`);
  console.log('Run a pipeline / chat session first (telemetry is on by default; DHEE_USAGE_TELEMETRY_DISABLED turns it off).');
  process.exit(0);
}

const s = summarizeUsage(records);
console.log(`LLM usage — ${path}  (${fmt(records.length)} calls)\n`);
for (const [lane, sum] of Object.entries(s.byLane)) line(lane, sum);
console.log('  ' + '-'.repeat(96));
line('TOTAL', s.overall);
console.log(
  `\nCached spend avoided: ${fmt(s.overall.cachedTokens)} of ${fmt(s.overall.promptTokens)} prompt tokens ` +
    `(${(s.overall.cachedRatio * 100).toFixed(0)}%) served from cache.`,
);
