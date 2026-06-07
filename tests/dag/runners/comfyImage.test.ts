/**
 * Phase 2 — comfy.image runner.
 *
 * Drives the Klein (Flux 2 Klein) ComfyUI workflow (or any compatible
 * image workflow) for first-frame / last-frame / reference image
 * generation. Replaces the executor's hardcoded image handlers.
 *
 * Failure modes per docs/bundle-migration-plan.md §3 Phase 2. The
 * runner is created via createComfyImageRunner({ clientFactory }) so
 * tests stub the ComfyUI client.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createComfyImageRunner, type ComfyImageClient } from '../../../src/dag/runners/comfyImage.js';
import { writeAliases } from '../../../src/dag/workflowAliases.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

// ── Stub client ────────────────────────────────────────────────────────

interface StubBehavior {
  uploads?: Array<{ name: string }>;
  uploadError?: Error;
  queueOutputs?: Array<{ filename: string; subfolder?: string; nodeId?: string }>;
  queueError?: Error;
  downloadContent?: Buffer;
  downloadError?: Error;
  calls?: {
    uploads: string[];
    queued: Array<Record<string, unknown>>;
    downloads: Array<{ filename: string; subfolder: string | undefined; destPath: string }>;
  };
}

function makeStubClient(behavior: StubBehavior): ComfyImageClient {
  behavior.calls ??= { uploads: [], queued: [], downloads: [] };
  let uploadIdx = 0;
  return {
    async uploadImage(filePath: string) {
      behavior.calls!.uploads.push(filePath);
      if (behavior.uploadError) throw behavior.uploadError;
      const u = behavior.uploads?.[uploadIdx++] ?? { name: `stub_${uploadIdx}.png` };
      return u;
    },
    async queueAndWait(wf, _signal) {
      behavior.calls!.queued.push(wf);
      if (behavior.queueError) throw behavior.queueError;
      return { outputs: behavior.queueOutputs ?? [{ filename: 'stub_out.png' }] };
    },
    async downloadOutput(filename, subfolder, destPath) {
      behavior.calls!.downloads.push({ filename, subfolder, destPath });
      if (behavior.downloadError) throw behavior.downloadError;
      const content = behavior.downloadContent ?? Buffer.from('fake-png');
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(destPath, '..'), { recursive: true });
      await fs.writeFile(destPath, content);
    },
  };
}

// ── Per-test scratch ───────────────────────────────────────────────────

let bundleDir: string;
let projectDir: string;
let refImage1: string;
let baseImagePath: string;
// COMFY_MODE controls whether the resolver honors the bundle's named
// endpoint label (cloud) or force-routes to the local Comfy URL
// (local, also the default when unset). The runner happy-path tests
// configure `endpoint: 'test.endpoint'` + `ENDPOINT_test_endpoint` —
// so the suite must run in cloud mode for those lookups to fire.
// Locally most devs have COMFY_MODE=local in .env which would mask
// this; CI runs with no env so the default 'local' wins and the test
// silently breaks. Pin cloud mode here, restore afterEach.
let savedComfyMode: string | undefined;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'comfy-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'comfy-proj-'));
  mkdirSync(join(bundleDir, 'workflows'), { recursive: true });
  mkdirSync(join(projectDir, 'refs'), { recursive: true });

  // Minimal Klein-ish workflow stub: a couple of nodes with editable inputs.
  const workflow = {
    '91': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
    '81': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
    '92:73': { class_type: 'KSampler', inputs: { noise_seed: 0 } },
    '94': { class_type: 'SaveImage', inputs: { filename_prefix: 'klein/out' } },
  };
  writeFileSync(join(bundleDir, 'workflows/klein.json'), JSON.stringify(workflow));

  baseImagePath = join(projectDir, 'refs/base.png');
  writeFileSync(baseImagePath, Buffer.from('fake-base-png'));
  refImage1 = join(projectDir, 'refs/char1.png');
  writeFileSync(refImage1, Buffer.from('fake-char-png'));

  // Pin cloud mode so the resolver honors the bundle's named endpoint.
  savedComfyMode = process.env['COMFY_MODE'];
  process.env['COMFY_MODE'] = 'cloud';
  // Set up endpoint env for the happy path.
  process.env['ENDPOINT_test_endpoint'] = 'http://stub.local:8188';
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  delete process.env['ENDPOINT_test_endpoint'];
  if (savedComfyMode === undefined) delete process.env['COMFY_MODE'];
  else process.env['COMFY_MODE'] = savedComfyMode;
});

function makeCtx(opts: {
  config: Record<string, unknown>;
  signal?: AbortSignal;
}): RunnerContext {
  const node: NodeDef = {
    id: 'image_node',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'image', pattern: 'out.png' },
    runner: { tool: 'comfy.image', config: opts.config },
  };
  return {
    projectDir,
    bundleDir,
    node,
    inputs: {},
    ...(opts.signal ? { signal: opts.signal } : {}),
    log: () => {},
  };
}

const DEFAULT_MAPPINGS = [
  { input: 'prompt',            nodeId: '91',    field: 'text'            },
  { input: 'base_image',        nodeId: '81',    field: 'image'           },
  { input: 'seed',              nodeId: '92:73', field: 'noise_seed'      },
  { input: 'filenamePrefix',    nodeId: '94',    field: 'filename_prefix' },
];

// ── Tests ──────────────────────────────────────────────────────────────

describe('comfy.image runner', () => {
  describe('happy path', () => {
    it('uploads base image, applies workflow params, queues, downloads output', async () => {
      const behavior: StubBehavior = {
        uploads: [{ name: 'uploaded_base.png' }],
        queueOutputs: [{ filename: 'klein_out_1.png', subfolder: 'klein' }],
      };
      const client = makeStubClient(behavior);
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: DEFAULT_MAPPINGS,
          endpoint: 'test.endpoint',
          prompt: 'a friendly dragon',
          baseImage: baseImagePath,
          outputPath: 'assets/images/shots/s1shot1.png',
        },
      }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        // The uploaded base path was reported.
        expect(behavior.calls!.uploads).toEqual([baseImagePath]);
        // The queued workflow has the prompt + the uploaded image name +
        // the seed (defaulted) + the filename_prefix injected.
        const wf = behavior.calls!.queued[0]!;
        expect((wf['91'] as { inputs: { text: string } }).inputs.text).toBe('a friendly dragon');
        expect((wf['81'] as { inputs: { image: string } }).inputs.image).toBe('uploaded_base.png');
        // Downloaded to the bundle output path.
        const writtenAbs = join(projectDir, result.outputPath);
        expect(existsSync(writtenAbs)).toBe(true);
        expect(readFileSync(writtenAbs).toString()).toBe('fake-png');
      }
    });
  });

  describe('failure mode 1 — endpoint env var unset', () => {
    it('fails with the named env var in the error', async () => {
      delete process.env['ENDPOINT_test_endpoint']; // unset for this case
      // resolveEndpointUrl in COMFY_MODE=local (the default) routes
      // EVERY endpoint to ENDPOINT_self_local / COMFYUI_BASE_URL,
      // ignoring the bundle's named endpoint. To test the bundle-
      // label-honoring code path (which is what this test asserts),
      // force COMFY_MODE=cloud and unset the local fallbacks.
      const savedMode = process.env['COMFY_MODE'];
      const savedLocal = process.env['ENDPOINT_self_local'];
      const savedBase = process.env['COMFYUI_BASE_URL'];
      process.env['COMFY_MODE'] = 'cloud';
      delete process.env['ENDPOINT_self_local'];
      delete process.env['COMFYUI_BASE_URL'];
      const restoreEnv = () => {
        if (savedMode === undefined) delete process.env['COMFY_MODE'];
        else process.env['COMFY_MODE'] = savedMode;
        if (savedLocal !== undefined) process.env['ENDPOINT_self_local'] = savedLocal;
        if (savedBase !== undefined) process.env['COMFYUI_BASE_URL'] = savedBase;
      };
      const client = makeStubClient({});
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: DEFAULT_MAPPINGS,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          outputPath: 'out.png',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/ENDPOINT_test_endpoint/);
        expect(result.error).toMatch(/test\.endpoint/);
      }
      restoreEnv();
    });
  });

  describe('failure mode 2 — missing workflow file', () => {
    it('fails clearly when workflowPath does not exist', async () => {
      const client = makeStubClient({});
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/nonexistent.json',
          parameterMappings: DEFAULT_MAPPINGS,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          outputPath: 'out.png',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/workflow|not found|nonexistent/i);
      }
    });
  });

  describe('failure mode 4 — too many reference images (Klein 4-cap)', () => {
    it('rejects more than 4 reference images', async () => {
      const refs = [refImage1, refImage1, refImage1, refImage1, refImage1]; // 5 (over cap)
      const client = makeStubClient({});
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: DEFAULT_MAPPINGS,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          referenceImages: refs,
          outputPath: 'out.png',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/4|cap|reference/i);
      }
    });
  });

  describe('failure mode 6 — skip-if-output-exists', () => {
    it('returns the existing output without calling Comfy when forceRerun=false and output exists', async () => {
      mkdirSync(join(projectDir, 'assets/images'), { recursive: true });
      writeFileSync(join(projectDir, 'assets/images/cached.png'), Buffer.from('already-here'));

      const behavior: StubBehavior = {};
      const client = makeStubClient(behavior);
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: DEFAULT_MAPPINGS,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          outputPath: 'assets/images/cached.png',
        },
      }));

      expect(result.ok).toBe(true);
      expect(behavior.calls!.queued.length).toBe(0); // Comfy was NOT called
    });
  });

  describe('failure mode 7 — Comfy returns no outputs', () => {
    it('fails clearly when Comfy returns an empty outputs array', async () => {
      const client = makeStubClient({ queueOutputs: [] });
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: DEFAULT_MAPPINGS,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          outputPath: 'out.png',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/no outputs|comfy returned/i);
      }
    });
  });

  describe('failure mode — upload error propagation', () => {
    it('fails with the uploaded image path when upload fails', async () => {
      const client = makeStubClient({ uploadError: new Error('connect ECONNREFUSED') });
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: DEFAULT_MAPPINGS,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          outputPath: 'out.png',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/upload|ECONNREFUSED/i);
        expect(result.error).toContain(baseImagePath);
      }
    });
  });

  describe('failure mode — queue error', () => {
    it('returns ok:false with Comfy error when the workflow queue rejects', async () => {
      const client = makeStubClient({ queueError: new Error('Comfy: model checkpoint not found: flux2_klein.safetensors') });
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: DEFAULT_MAPPINGS,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          outputPath: 'out.png',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The actual Comfy error must come through verbatim — no
        // swallowing or paraphrasing. The user needs the model name.
        expect(result.error).toContain('flux2_klein.safetensors');
      }
    });
  });

  describe('failure mode 10 — parameterMappings refs an unknown node', () => {
    it('fails when a mapping refers to a node that does not exist in the workflow', async () => {
      const badMappings = [
        ...DEFAULT_MAPPINGS,
        { input: 'extra', nodeId: '999', field: 'foo' }, // 999 isn't in our stub workflow
      ];
      const client = makeStubClient({});
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: badMappings,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          extra: 'value',
          outputPath: 'out.png',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/999|node|not found|missing/i);
      }
    });
  });

  describe('reference images', () => {
    it('uploads all reference images and wires them into the workflow', async () => {
      // Workflow has slots for 3 refs (81 already used by base, 82/83/84 for refs).
      const workflow = {
        '91': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
        '81': { class_type: 'LoadImage', inputs: { image: '' } },
        '82': { class_type: 'LoadImage', inputs: { image: '' } },
        '83': { class_type: 'LoadImage', inputs: { image: '' } },
        '94': { class_type: 'SaveImage', inputs: { filename_prefix: 'klein/out' } },
      };
      writeFileSync(join(bundleDir, 'workflows/klein.json'), JSON.stringify(workflow));

      const mappings = [
        { input: 'prompt', nodeId: '91', field: 'text' },
        { input: 'base_image', nodeId: '81', field: 'image' },
        { input: 'reference_image_1', nodeId: '82', field: 'image' },
        { input: 'reference_image_2', nodeId: '83', field: 'image' },
        { input: 'filenamePrefix', nodeId: '94', field: 'filename_prefix' },
      ];
      const ref2 = join(projectDir, 'refs/char2.png');
      writeFileSync(ref2, Buffer.from('fake-char2'));

      const behavior: StubBehavior = {
        uploads: [
          { name: 'up_base.png' },
          { name: 'up_ref1.png' },
          { name: 'up_ref2.png' },
        ],
      };
      const client = makeStubClient(behavior);
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: mappings,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          referenceImages: [refImage1, ref2],
          outputPath: 'out.png',
        },
      }));

      expect(result.ok).toBe(true);
      expect(behavior.calls!.uploads).toEqual([baseImagePath, refImage1, ref2]);
      const wf = behavior.calls!.queued[0]!;
      expect((wf['81'] as { inputs: { image: string } }).inputs.image).toBe('up_base.png');
      expect((wf['82'] as { inputs: { image: string } }).inputs.image).toBe('up_ref1.png');
      expect((wf['83'] as { inputs: { image: string } }).inputs.image).toBe('up_ref2.png');
    });
  });

  describe('workflow aliases — model substitution', () => {
    it('applies a persisted name_alias to model *_name fields before queueing', async () => {
      // Regression: image nodes used to ignore the alias store entirely
      // (only ltx_director / qwen_edit_chain applied it), so a user's
      // "use a model I have" pick in the BundleConfigurator never reached
      // comfy.image — the flux-2 mismatch reappeared on every render.
      const aliasesDir = mkdtempSync(join(tmpdir(), 'comfy-aliases-'));
      const savedAliasDir = process.env['DHEE_WORKFLOW_ALIASES_DIR'];
      process.env['DHEE_WORKFLOW_ALIASES_DIR'] = aliasesDir;
      try {
        // Workflow references the bundle's canonical checkpoint name on a
        // loader node that NO parameter mapping touches — so only the
        // alias can change it.
        const workflow = {
          '10': { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2.safetensors', weight_dtype: 'default' } },
          '91': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
          '94': { class_type: 'SaveImage', inputs: { filename_prefix: 'out' } },
        };
        writeFileSync(join(bundleDir, 'workflows/klein.json'), JSON.stringify(workflow));

        // User's box only has the klein-quantized variant. Persisted the
        // same way the configurator / agent tool do — keyed by the
        // endpoint the runner will resolve to.
        writeAliases(aliasesDir, process.env['ENDPOINT_test_endpoint']!, {
          name_aliases: { 'flux-2.safetensors': 'flux-2-klein-full.safetensors' },
        });

        const behavior: StubBehavior = { queueOutputs: [{ filename: 'out.png' }] };
        const client = makeStubClient(behavior);
        const runner = createComfyImageRunner({ clientFactory: () => client });

        const result = await runner.run(makeCtx({
          config: {
            workflowPath: 'workflows/klein.json',
            parameterMappings: [
              { input: 'prompt', nodeId: '91', field: 'text' },
              { input: 'filenamePrefix', nodeId: '94', field: 'filename_prefix' },
            ],
            endpoint: 'test.endpoint',
            prompt: 'a dragon',
            outputPath: 'out.png',
          },
        }));

        expect(result.ok).toBe(true);
        const wf = behavior.calls!.queued[0]!;
        // The model name posted to Comfy is the user's local file, not the
        // bundle's canonical name.
        expect((wf['10'] as { inputs: { unet_name: string } }).inputs.unet_name).toBe(
          'flux-2-klein-full.safetensors',
        );
      } finally {
        if (savedAliasDir === undefined) delete process.env['DHEE_WORKFLOW_ALIASES_DIR'];
        else process.env['DHEE_WORKFLOW_ALIASES_DIR'] = savedAliasDir;
        rmSync(aliasesDir, { recursive: true, force: true });
      }
    });
  });

  describe('abort signal', () => {
    it('returns ok:false when aborted before upload', async () => {
      const client = makeStubClient({});
      const runner = createComfyImageRunner({ clientFactory: () => client });

      const ac = new AbortController();
      ac.abort();
      const result = await runner.run(makeCtx({
        config: {
          workflowPath: 'workflows/klein.json',
          parameterMappings: DEFAULT_MAPPINGS,
          endpoint: 'test.endpoint',
          prompt: 'x',
          baseImage: baseImagePath,
          outputPath: 'out.png',
        },
        signal: ac.signal,
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/abort/i);
      }
    });
  });
});
