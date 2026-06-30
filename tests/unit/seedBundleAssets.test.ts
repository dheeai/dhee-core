/**
 * Bundle asset seeding — a bundle can ship "talent" (default creator photo,
 * reference voice, default brief) in its inputs/ dir, and project creation
 * copies those into the project so they just work without the user supplying
 * them. User-provided inputs overwrite the matching seeded files (defaults).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedBundleAssets, initializeProject } from '../../src/dag/initializeProject.js';

let tmp: string;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'seed-assets-'));
});
afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env['DHEE_USER_BUNDLES_DIR'];
});

describe('seedBundleAssets', () => {
  it('copies the bundle inputs/ files into the project (binary-safe)', () => {
    const bundleDir = join(tmp, 'bundle');
    mkdirSync(join(bundleDir, 'inputs'), { recursive: true });
    writeFileSync(join(bundleDir, 'inputs', 'character.png'), PNG_BYTES);
    writeFileSync(join(bundleDir, 'inputs', 'voice_ref.wav'), Buffer.from([0x52, 0x49, 0x46, 0x46]));
    writeFileSync(join(bundleDir, 'inputs', 'story.md'), 'default brief', 'utf8');
    const projectDir = join(tmp, 'proj');
    mkdirSync(projectDir, { recursive: true });

    const seeded = seedBundleAssets(bundleDir, projectDir).sort();
    expect(seeded).toEqual(['character.png', 'story.md', 'voice_ref.wav']);
    // binary intact (byte-for-byte)
    expect(readFileSync(join(projectDir, 'inputs', 'character.png'))).toEqual(PNG_BYTES);
    expect(readFileSync(join(projectDir, 'inputs', 'story.md'), 'utf8')).toBe('default brief');
  });

  it('is a no-op when the bundle has no inputs/ dir', () => {
    const bundleDir = join(tmp, 'bundle-no-inputs');
    mkdirSync(bundleDir, { recursive: true });
    const projectDir = join(tmp, 'proj2');
    mkdirSync(projectDir, { recursive: true });
    expect(seedBundleAssets(bundleDir, projectDir)).toEqual([]);
    expect(existsSync(join(projectDir, 'inputs'))).toBe(false);
  });
});

describe('initializeProject seeds bundle assets, user inputs override', () => {
  it('seeds shipped talent and lets a provided input overwrite its file', () => {
    // Fake bundle discoverable via DHEE_USER_BUNDLES_DIR
    const bundlesRoot = join(tmp, 'bundles');
    const bundleDir = join(bundlesRoot, 'talent_bundle');
    mkdirSync(join(bundleDir, 'inputs'), { recursive: true });
    writeFileSync(join(bundleDir, 'inputs', 'character.png'), PNG_BYTES);
    writeFileSync(join(bundleDir, 'inputs', 'voice_ref.wav'), Buffer.from([0x01, 0x02]));
    writeFileSync(join(bundleDir, 'inputs', 'story.md'), 'SHIPPED default story', 'utf8');
    writeFileSync(
      join(bundleDir, 'bundle.json'),
      JSON.stringify({
        id: 'talent_bundle',
        version: '1.0.0',
        goal: 'final',
        nodes: [],
        inputs: [
          { id: 'story_input', kind: 'file', path: 'inputs/story.md', required: true },
          { id: 'character_image', kind: 'file', path: 'inputs/character.png', required: false },
        ],
      }),
      'utf8',
    );
    process.env['DHEE_USER_BUNDLES_DIR'] = bundlesRoot;

    const projectDir = join(tmp, 'studio-project');
    mkdirSync(projectDir, { recursive: true });
    const r = initializeProject({
      projectDir,
      name: 'Talent Test',
      bundleId: 'talent_bundle',
      inputs: { story_input: 'USER OVERRODE THE STORY' },
    });
    expect(r.ok).toBe(true);

    // voice + creator photo seeded (not provided by the user) → present
    expect(existsSync(join(projectDir, 'inputs', 'voice_ref.wav'))).toBe(true);
    expect(readFileSync(join(projectDir, 'inputs', 'character.png'))).toEqual(PNG_BYTES);
    // the user-provided story overrides the shipped default
    expect(readFileSync(join(projectDir, 'inputs', 'story.md'), 'utf8')).toBe('USER OVERRODE THE STORY');
  });

  it('copies provided binary file inputs instead of writing their path as text', () => {
    const bundlesRoot = join(tmp, 'bundles');
    const bundleDir = join(bundlesRoot, 'binary_input_bundle');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, 'bundle.json'),
      JSON.stringify({
        id: 'binary_input_bundle',
        version: '1.0.0',
        goal: 'final',
        nodes: [],
        inputs: [
          { id: 'product_image', kind: 'file', path: 'inputs/product.png', required: true },
          { id: 'brief', kind: 'file', path: 'inputs/brief.md', required: true },
        ],
      }),
      'utf8',
    );
    process.env['DHEE_USER_BUNDLES_DIR'] = bundlesRoot;
    const source = join(tmp, 'picked-product.png');
    const pickedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb, 0xcc]);
    writeFileSync(source, pickedBytes);

    const projectDir = join(tmp, 'binary-project');
    mkdirSync(projectDir, { recursive: true });
    const r = initializeProject({
      projectDir,
      name: 'Binary Test',
      bundleId: 'binary_input_bundle',
      inputs: {
        product_image: { sourcePath: source, name: 'picked-product.png' },
        brief: 'text brief',
      },
    });

    expect(r.ok).toBe(true);
    expect(readFileSync(join(projectDir, 'inputs', 'product.png'))).toEqual(pickedBytes);
    expect(readFileSync(join(projectDir, 'inputs', 'brief.md'), 'utf8')).toBe('text brief');
  });

  it('rejects plain text for binary file inputs', () => {
    const bundlesRoot = join(tmp, 'bundles');
    const bundleDir = join(bundlesRoot, 'reject_text_image_bundle');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, 'bundle.json'),
      JSON.stringify({
        id: 'reject_text_image_bundle',
        version: '1.0.0',
        goal: 'final',
        nodes: [],
        inputs: [{ id: 'product_image', kind: 'file', path: 'inputs/product.png', required: true }],
      }),
      'utf8',
    );
    process.env['DHEE_USER_BUNDLES_DIR'] = bundlesRoot;
    const projectDir = join(tmp, 'reject-project');
    mkdirSync(projectDir, { recursive: true });

    const r = initializeProject({
      projectDir,
      name: 'Reject Test',
      bundleId: 'reject_text_image_bundle',
      inputs: { product_image: 'this is not image bytes' },
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expects a selected file/i);
    expect(existsSync(join(projectDir, 'inputs', 'product.png'))).toBe(false);
    expect(existsSync(join(projectDir, 'project.json'))).toBe(false);
  });
});
