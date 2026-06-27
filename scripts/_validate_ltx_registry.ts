import { getGlobalRegistry } from '../src/dag/runners/registry.js';
import '../src/dag/runners/index.js'; // bootstrap built-ins (ltx_director now removed)
import { ensureNpmRunnersLoaded } from '../src/dag/ecosystem.js';

const reg = getGlobalRegistry();
await ensureNpmRunnersLoaded(reg); // scan node_modules for dhee-runner-* (incl. ltx-director)

const all = reg.list();
const ltx = all.filter((m) => m.tool === 'comfy.ltx_director');
const runner = reg.get('comfy.ltx_director');

console.log('comfy.ltx_director registrations:', ltx.length);
for (const m of ltx) console.log('  tool=%s version=%s display=%s', m.tool, m.version, m.displayName);
console.log('reg.get returns a runner:', !!runner, '| describe.id:', runner?.describe?.().id);
console.log('total runners registered:', all.length);
console.log('external dhee-runner-* present:', all.filter((m) => /vace_place|comfy\.matte|comfy\.tts|ltx_director/.test(m.tool)).map((m) => m.tool).join(', '));

const ok = ltx.length === 1 && !!runner && ltx[0]!.version === '0.2.0';
console.log(ok ? '\nVALIDATED: comfy.ltx_director resolves to the external runner (v0.2.0), no duplicate.' : '\nFAILED: registration not as expected.');
process.exit(ok ? 0 : 1);
