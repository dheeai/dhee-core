import { it, expect, beforeAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setProductionReviewsRequired } from '../../src/dag/productionReviewGates.js';
// Exercise freshly packaged code, including on a clean checkout.
beforeAll(() => {
  const built = spawnSync(
    process.execPath,
    ['node_modules/tsup/dist/cli-default.js', '--config', 'tsup.config.ts'],
    { encoding: 'utf8', timeout: 30000 }
  );
  if (built.status !== 0) throw new Error(built.stderr || built.stdout || 'Core build failed');
});
it('keeps npm runner registration logs out of packaged CLI stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'control-cli-package-'));
  try {
    const pkg = join(dir, 'node_modules/dhee-runner-fixture');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: 'dhee-runner-fixture',
        version: '0.1.0',
        type: 'module',
        keywords: ['dhee-runner'],
        dhee: { runners: 'index.js' },
      })
    );
    writeFileSync(
      join(pkg, 'index.js'),
      `export const runners=[{manifest:{tool:'fixture.control',version:'0.1.0',engineCompat:'>=0.1.0',credentials:[]},runner:{describe(){return {id:'fixture.control'}},async run(){return {ok:false,error:'unused'}}}}];`
    );
    writeFileSync(join(dir, 'project.json'), '{}');
    setProductionReviewsRequired({ projectDir: dir, enabled: true });
    const child = spawnSync(process.execPath, [resolve('dist/control/cli.js')], {
      input: JSON.stringify({ action: 'project.run', projectDir: dir }),
      encoding: 'utf8',
      env: { ...process.env, DHEE_NODE_MODULES_DIRS: join(dir, 'node_modules') },
      timeout: 10000,
    });
    expect(child.error).toBeUndefined();
    expect(JSON.parse(child.stdout)).toMatchObject({ ok: false });
    expect(child.stderr).toContain('registered npm runners');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('resolves packaged bundles without a source tree or app environment override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'control-standalone-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dhee-core', type: 'module' }));
    cpSync(resolve('dist'), join(dir, 'dist'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
    const id = `packaged-only-${Date.now()}`;
    const bundle = join(dir, 'dist/bundles', id);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'bundle.json'), '{}');
    const script = `import {resolveBundleDir,parseBundleSource} from ${JSON.stringify(pathToFileURL(join(dir, 'dist/index.js')).href)};console.log(resolveBundleDir(parseBundleSource(${JSON.stringify('built-in:' + id)})));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, DHEE_APP_BUNDLES_DIR: '', DHEE_USER_BUNDLES_DIR: '' },
      timeout: 10000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe(realpathSync(bundle));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
