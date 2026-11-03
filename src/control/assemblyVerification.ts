/** Orchestrate the Desktop-owned checker without adding a second media implementation. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseBundleSource, resolveBundleDir } from '../dag/bundleSource.js';
import { loadBundle } from '../dag/walker.js';
import { resolveRunnerForInstance } from '../dag/resolveRunnerForInstance.js';
import { readProductionArtifact, listProductionVersions } from './productionVersions.js';
import type { runProjectViaBundle } from '../server/runners/runProjectViaBundle.js';

const criteriaSchema = z
  .object({
    expectedScript: z.string().trim().min(1).max(12000).optional(),
    videoInput: z.string().min(1),
    outputPath: z.string().min(1),
    segments: z
      .array(
        z
          .object({
            videoInput: z.string().min(1),
            durationSec: z.number().finite().positive().max(120),
            audioInput: z.string().min(1).optional(),
            audioOffsetSec: z.number().finite().nonnegative().default(0),
          })
          .strict()
      )
      .min(1)
      .max(20),
  })
  .strict();
const findingSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['pass', 'fail', 'unchecked']),
  detail: z.string(),
  measured: z.number().finite().optional(),
  expected: z.number().finite().optional(),
  atSec: z.number().finite().optional(),
});
const reportSchema = z.object({
  analyzerVersion: z.number().int().positive(),
  status: z.enum(['fail', 'review']),
  deliveryReady: z.literal(false),
  criteria: criteriaSchema,
  inputs: z.record(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  checks: z.array(findingSchema).min(1).max(100),
});
export interface AssemblyVerification {
  status: 'not-configured' | 'not-run' | 'unavailable' | 'stale' | 'fail' | 'review';
  deliveryReady: false;
  reason?: string;
  nodeId?: string;
  reportPath?: string;
  reportSha256?: string;
  checks?: z.infer<typeof findingSchema>[];
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
export async function verifyAfterAssembly(
  req: { projectDir: string; branchId: string; nodeId: string; itemId?: string },
  run: typeof runProjectViaBundle,
  options: { signal?: AbortSignal; log?: (message: string) => void }
): Promise<AssemblyVerification> {
  const result = (
    status: AssemblyVerification['status'],
    reason: string
  ): AssemblyVerification => ({ status, reason, deliveryReady: false });
  try {
    const project = JSON.parse(readFileSync(join(req.projectDir, 'project.json'), 'utf8')) as {
      bundleSource: string;
    };
    const location = resolveBundleDir(parseBundleSource(project.bundleSource));
    const load = () =>
      loadBundle(statSync(location).isDirectory() ? join(location, 'bundle.json') : location);
    const bundle = load();
    const assembly = bundle.nodes.find(n => n.id === req.nodeId);
    if (!assembly) throw Error('Assembly stage is unavailable.');
    const selected = resolveRunnerForInstance({ ...req, fallbackTool: assembly.runner.tool });
    const assemblyConfig = { ...assembly.runner.config, ...selected.configOverride };
    const nodeId = assemblyConfig['verificationNode'];
    if (nodeId === undefined)
      return result('not-configured', 'No automatic check is configured for this assembly stage.');
    if (typeof nodeId !== 'string' || !nodeId || req.itemId)
      throw Error('Automatic checks currently require one explicit stage target.');
    const audit = bundle.nodes.find(n => n.id === nodeId);
    if (!audit || audit.kind !== 'stage' || audit.chunkBy || audit.outputs.format !== 'json')
      throw Error('Configured verification must be a JSON stage.');
    const selection = resolveRunnerForInstance({
      projectDir: req.projectDir,
      branchId: req.branchId,
      nodeId,
      fallbackTool: audit.runner.tool,
    });
    if (selection.tool !== 'media.verify_assembly')
      throw Error('Configured verification must use the Desktop media.verify_assembly runner.');
    const criteria = criteriaSchema.parse({ ...audit.runner.config, ...selection.configOverride });
    if (criteria.videoInput !== req.nodeId)
      throw Error('Configured check does not target this assembly.');
    const keys = [
      ...new Set([
        criteria.videoInput,
        ...criteria.segments.flatMap(s => [s.videoInput, ...(s.audioInput ? [s.audioInput] : [])]),
      ]),
    ];
    if (
      keys.some(
        key =>
          !audit.inputs.some(i => i.from === key) ||
          bundle.nodes.find(n => n.id === key)?.kind !== 'stage'
      )
    )
      throw Error('Every checked source must be a direct stage dependency.');
    const read = (id: string) => {
      const base = { projectDir: req.projectDir, branchId: req.branchId, nodeId: id };
      if (listProductionVersions({ ...base, action: 'version.list' }).status !== 'completed')
        throw Error('A verification source is incomplete.');
      return readProductionArtifact({ ...base, action: 'artifact.read' });
    };
    const before = Object.fromEntries(keys.map(key => [key, read(key)]));
    options.signal?.throwIfAborted();
    const executed = await run({
      projectDir: req.projectDir,
      branchId: req.branchId,
      requireProductionReviews: true,
      targetInstance: {
        nodeId,
        selectionId: selection.selectionId ?? null,
        expectedTool: 'media.verify_assembly',
      },
      signal: options.signal,
      log: options.log ?? (() => {}),
    });
    if (!executed.ok) throw Error(executed.error ?? 'Automatic check could not run.');
    options.signal?.throwIfAborted();
    const artifact = read(nodeId);
    if (!('text' in artifact) || typeof artifact.text !== 'string')
      throw Error('Verification report is missing or too large.');
    const report = reportSchema.parse(JSON.parse(artifact.text));
    if (report.analyzerVersion !== 2) throw Error('Stale: verification analyzer changed; rerun with a fresh report path.');
    const stale = (message: string): never => {
      throw Error(`Stale: ${message}`);
    };
    if (canonical(report.criteria) !== canonical(criteria))
      stale('saved check criteria changed; rerun verification.');
    if (Object.keys(report.inputs).sort().join('\n') !== [...keys].sort().join('\n'))
      throw Error('Verification report omits or adds source inputs.');
    for (const key of keys) {
      const current = read(key),
        old = before[key]!,
        checked = report.inputs[key]!;
      if (
        current.versionId !== old.versionId ||
        current.path !== old.path ||
        current.sha256 !== old.sha256 ||
        current.path !== checked.path ||
        current.sha256 !== checked.sha256
      )
        stale('selected media or bytes changed; rerun verification.');
    }
    const latest = load();
    const latestAudit = latest.nodes.find(n => n.id === nodeId),
      latestAssembly = latest.nodes.find(n => n.id === req.nodeId);
    const latestSelection = resolveRunnerForInstance({
      projectDir: req.projectDir,
      branchId: req.branchId,
      nodeId,
      fallbackTool: latestAudit?.runner.tool ?? '',
    });
    const latestAssemblySelection = resolveRunnerForInstance({
      ...req,
      fallbackTool: latestAssembly?.runner.tool ?? '',
    });
    if (
      canonical(latestAudit) !== canonical(audit) ||
      canonical(latestAssembly) !== canonical(assembly) ||
      canonical(latestSelection) !== canonical(selection) ||
      canonical(latestAssemblySelection) !== canonical(selected)
    )
      stale('workflow changed during verification.');
    const expectedIds = [
      'duration',
      'decode',
      ...criteria.segments.flatMap((_, i) => [`picture:${i}`, `voice:${i}`]),
      'transcript',
      'scene-meaning',
      'creative-approval',
    ];
    if (
      report.checks.length !== expectedIds.length ||
      new Set(report.checks.map(c => c.id)).size !== expectedIds.length ||
      expectedIds.some(id => !report.checks.some(c => c.id === id))
    )
      throw Error('Verification report is incomplete or ambiguous.');
    const status = report.checks.some(c => c.status === 'fail') ? 'fail' : 'review';
    if (report.status !== status)
      throw Error('Verification report status contradicts its findings.');
    const finalRead = read(nodeId);
    if (finalRead.versionId !== artifact.versionId || finalRead.sha256 !== artifact.sha256)
      stale('verification report changed during reading.');
    return {
      status,
      nodeId,
      reportPath: artifact.path,
      reportSha256: artifact.sha256,
      checks: report.checks,
      deliveryReady: false,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return result(reason.startsWith('Stale:') ? 'stale' : 'unavailable', reason);
  }
}
