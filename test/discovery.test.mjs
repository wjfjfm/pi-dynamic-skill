import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { queueFixture } from './queue-fixture.mjs';
import { createSkillContextRuntime, DESCRIPTION_BLOCK } from '../dist/runtime.js';
import { ACCESS_STATE, MANUAL_SELECTION } from '../dist/access.js';
import { skillDetails, visibleSkills } from '../dist/context.js';

const request = (f, runtime = f.runtime) => runtime.project(f.ctx, f.manager.buildSessionContext().messages);
const select = (f, add = [], remove = []) => {
  f.manager.appendCustomEntry(MANUAL_SELECTION, { add, remove });
  return request(f);
};

test('read root discovers only direct children; root stays exempt; repeated reads do not reorder or duplicate', t => {
  const f = queueFixture(t);
  f.record(f.root);
  const first = request(f);
  assert.deepEqual(f.state().active, []);
  assert.deepEqual(f.state().discovery.map(d => d.path), f.paths);
  assert.match(first.at(-1).content, /### Discovered skills/);
  assert.doesNotMatch(first.at(-1).content, /PRIVATE BODY/);
  const discovery = structuredClone(f.state().discovery);
  const blocks = first.filter(skillDetails);
  f.record(f.root);
  assert.deepEqual(request(f).filter(skillDetails), blocks);
  assert.deepEqual(f.state().discovery, discovery);
});

test('discovery to active, cancel and reselect all share one visible description', t => {
  const f = queueFixture(t);
  f.record(f.root); const blocks = request(f).filter(skillDetails);
  f.record(f.paths[0]); request(f);
  assert.deepEqual(f.state().active, [f.paths[0]]);
  assert.equal(f.state().discovery.some(d => d.path === f.paths[0]), false);
  select(f, [], [f.paths[0]]);
  assert.deepEqual(f.state().active, []);
  request(f);
  assert.equal(f.state().discovery.some(d => d.path === f.paths[0]), false, 'old discovery cannot resurrect a removal');
  assert.deepEqual(select(f, [f.paths[0]]).filter(skillDetails), blocks);
});

test('same-batch parent/child reads produce mutually exclusive queues and one description per path', t => {
  const f = queueFixture(t);
  f.record(f.root); f.record(f.paths[0]);
  const delta = request(f).filter(skillDetails);
  assert.deepEqual(f.state().active, [f.paths[0]]);
  assert.deepEqual(f.state().discovery.map(d => d.path), f.paths.slice(1));
  assert.equal(delta.length, 1);
  assert.deepEqual(skillDetails(delta[0]).paths, f.paths);
});

for (const mode of ['failure', 'overwritten', 'write', 'edit']) test(`${mode} cannot create discoveries`, t => {
  const f = queueFixture(t);
  f.record(f.root, ['write', 'edit'].includes(mode) ? mode : 'read', mode === 'failure', mode !== 'overwritten');
  assert.deepEqual([...visibleSkills(request(f))], []);
  assert.deepEqual(f.state().discovery, []);
  assert.deepEqual(f.state().active, []);
});

test('discovery uses read-time metadata, not a later disk description; disable-model-invocation is respected', t => {
  const f = queueFixture(t);
  writeFileSync(f.paths[1], '---\nname: skill-1\ndescription: Hidden\ndisable-model-invocation: true\n---\n');
  f.record(f.root);
  writeFileSync(f.paths[0], '---\nname: skill-0\ndescription: Changed later\n---\n');
  assert.doesNotMatch(request(f).at(-1).content, /Changed later|<description>Hidden/);
  assert.equal(f.state().discovery.some(d => d.path === f.paths[1]), false);
});

for (const failure of [ACCESS_STATE, DESCRIPTION_BLOCK]) test(`interrupted ${failure} recovers once from public entries`, t => {
  const f = queueFixture(t);
  f.record(f.root);
  const broken = createSkillContextRuntime({ ...f.pi, appendEntry(type, data) {
    if (type === failure) throw new Error('interrupted');
    return f.pi.appendEntry(type, data);
  } }, f.options);
  assert.throws(() => request(f, broken), /interrupted/);
  const restored = createSkillContextRuntime(f.pi, f.options);
  assert.equal(request(f, restored).filter(skillDetails).length, 1);
  assert.deepEqual(f.state().discovery.map(d => d.path), f.paths);
  const leaf = f.manager.getLeafId();
  request(f, restored);
  assert.equal(f.manager.getLeafId(), leaf);
});

test('compaction removes discovery even with old read in raw history; fresh read alone can rediscover', t => {
  const f = queueFixture(t);
  f.record(f.root); request(f);
  const savedCursor = f.state().cursor;
  const anchor = f.manager.appendMessage({ role: 'user', content: 'Kept tail', timestamp: 3 });
  f.manager.appendCompaction('Summary mentions skills, not loaded descriptions', anchor, 100);
  const restarted = createSkillContextRuntime(f.pi, f.options);
  restarted.settle(f.ctx, true);
  assert.equal(visibleSkills(request(f, restarted)).size, 0);
  assert.equal(f.state().cursor, savedCursor);
  assert.deepEqual(f.state().discovery, []);
  f.record(f.root); request(f, restarted);
  assert.deepEqual(f.state().discovery.map(d => d.path), f.paths);
});

test('ordinary unrelated tools do not persist queue snapshots; empty discoveries still consume once', t => {
  const f = queueFixture(t, 0);
  f.record(f.root); request(f);
  const snapshot = f.state();
  f.record('/outside', 'bash'); request(f);
  assert.deepEqual(f.state(), snapshot);
  const leaf = f.manager.getLeafId();
  request(f, createSkillContextRuntime(f.pi, f.options));
  assert.equal(f.manager.getLeafId(), leaf);
});

test('rediscovery of an already-visible description does not gain a second lifetime', t => {
  const f = queueFixture(t);
  f.record(f.paths[0]); request(f);
  select(f, [], [f.paths[0]]);
  f.record(f.root); request(f);
  assert.ok(f.state().discovery.some(d => d.path === f.paths[0]));
  const anchor = f.manager.appendMessage({ role: 'user', content: 'Tail', timestamp: 3 });
  f.manager.appendCompaction('Summary', anchor, 100);
  const restored = createSkillContextRuntime(f.pi, f.options);
  restored.settle(f.ctx, true);
  assert.equal(visibleSkills(request(f, restored)).size, 0);
  assert.deepEqual(f.state().discovery, []);
});

test('discovery is not truncated to active capacity', t => {
  const f = queueFixture(t, 200, 2);
  f.record(f.root);
  assert.equal(visibleSkills(request(f)).size, 200);
  assert.equal(f.state().discovery.length, 200);
  assert.deepEqual(f.state().active, []);
});
