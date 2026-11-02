import { expect, it } from 'vitest';
import { checkSceneIntent, sceneInputDigest } from '../../src/control/sceneIntent.js';
const intent = () => ({
  requirements: [
    {
      id: 'doctor-position',
      description: 'Doctor stays seated',
      expected: 'seated',
      sources: ['frame', 'motion'],
    },
  ],
  sources: [
    {
      id: 'frame',
      inputKey: 'image',
      sha256: 'a'.repeat(64),
      evidence: 'Viewed initial frame',
      facts: { 'doctor-position': 'exiting' },
    },
    {
      id: 'motion',
      inputKey: 'prompt',
      sha256: sceneInputDigest('Doctor stays seated.'),
      evidence: 'Read motion prompt',
      facts: { 'doctor-position': 'seated' },
    },
  ],
});
it('reports actor-action contradiction with evidence and expected correction', () => {
  expect(checkSceneIntent(intent()).issues).toContainEqual(
    expect.objectContaining({
      requirementId: 'doctor-position',
      sourceId: 'frame',
      status: 'conflict',
      expected: 'seated',
      observed: 'exiting',
    })
  );
  expect(checkSceneIntent(intent()).status).toBe('blocked');
});
it('does not interpret missing facts as agreement', () => {
  const value = intent();
  value.sources[0]!.facts = {};
  expect(checkSceneIntent(value)).toMatchObject({
    status: 'blocked',
    issues: [expect.objectContaining({ status: 'unknown' })],
  });
});
it('accepts consistent recorded observations without granting creative approval', () => {
  const value = intent();
  value.sources[0]!.facts['doctor-position'] = 'seated';
  expect(checkSceneIntent(value)).toMatchObject({
    status: 'consistent',
    creativeApproval: 'required',
    basis: 'recorded-observations',
  });
});
it('rejects vacuous contracts and duplicate requirement IDs', () => {
  expect(() => checkSceneIntent({ requirements: [], sources: [] })).toThrow();
  const value = intent();
  value.requirements.push(value.requirements[0]!);
  expect(() => checkSceneIntent(value)).toThrow(/duplicate/i);
});
it('exposes the observation check through the shared control without requiring a project', async () => {
  const { createProductionControl } = await import('../../src/control/productionControl.js');
  expect(
    await createProductionControl()({ action: 'scene.check', sceneIntent: intent() })
  ).toMatchObject({ ok: true, result: { status: 'blocked' } });
});
