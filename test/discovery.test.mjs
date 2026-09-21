import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { queueFixture } from './queue-fixture.mjs';
import { createSkillContextRuntime } from '../dist/runtime.js';
import { MANUAL_SELECTION } from '../dist/access.js';
import { skillDetails, visibleSkills } from '../dist/context.js';

const messages = f => f.manager.buildSessionContext().messages;
const select = (f, add = [], remove = []) => {
  f.manager.appendCustomEntry(MANUAL_SELECTION, { add, remove });
  f.runtime.reconcile(f.ctx);
};

test('read root discovers only direct children; root stays exempt; repeated reads do not reorder or duplicate', t => {
  const f = queueFixture(t);
  f.record(f.root);
  f.runtime.reconcile(f.ctx);
  assert.deepEqual(f.state().active, []);
  assert.deepEqual(f.state().discovery.map(d => d.path), f.paths);
  assert.match(messages(f).at(-1).content, /### Discovered skills/);
  assert.doesNotMatch(messages(f).at(-1).content, /PRIVATE BODY/);
  const discovery = structuredClone(f.state().discovery);
  const blocks = messages(f).filter(skillDetails);
  f.record(f.root);
  f.runtime.reconcile(f.ctx);
  assert.deepEqual(f.state().discovery, discovery);
  assert.deepEqual(messages(f).filter(skillDetails), blocks);
});

test('discovery to active, cancel and reselect all share one visible description', t => {
  const f = queueFixture(t);
  f.record(f.root); f.runtime.reconcile(f.ctx);
  const blocks = messages(f).filter(skillDetails);
  f.record(f.paths[0]); f.runtime.reconcile(f.ctx);
  assert.deepEqual(f.state().active, [f.paths[0]]);
  assert.equal(f.state().discovery.some(d => d.path === f.paths[0]), false);
  select(f, [], [f.paths[0]]);
  assert.deepEqual(f.state().active, []);
  f.runtime.reconcile(f.ctx);
  assert.equal(f.state().discovery.some(d => d.path === f.paths[0]), false, 'old discovery cannot resurrect a removal');
  select(f, [f.paths[0]]);
  assert.deepEqual(messages(f).filter(skillDetails), blocks);
});

test('same-batch parent/child reads produce mutually exclusive queues and one description per path', t => {
  const f = queueFixture(t);
  f.record(f.root); f.record(f.paths[0]);
  f.runtime.reconcile(f.ctx);
  assert.deepEqual(f.state().active, [f.paths[0]]);
  assert.deepEqual(f.state().discovery.map(d => d.path), f.paths.slice(1));
  const delta = messages(f).filter(skillDetails);
  assert.equal(delta.length, 1);
  assert.deepEqual(skillDetails(delta[0]).paths, f.paths);
});

for (const mode of ['failure', 'overwritten', 'write', 'edit']) test(`${mode} cannot create discoveries`, t => {
  const f = queueFixture(t);
  f.record(f.root, ['write', 'edit'].includes(mode) ? mode : 'read', mode === 'failure', mode !== 'overwritten');
  f.runtime.reconcile(f.ctx);
  assert.deepEqual(f.state().discovery, []);
  assert.deepEqual(f.state().active, []);
  assert.deepEqual([...visibleSkills(messages(f))], []);
});

test('discovery uses read-time metadata, not a later disk description; disable-model-invocation is respected', t => {
  const f = queueFixture(t);
  writeFileSync(f.paths[1], '---\nname: skill-1\ndescription: Hidden\ndisable-model-invocation: true\n---\n');
  f.record(f.root);
  writeFileSync(f.paths[0], '---\nname: skill-0\ndescription: Changed later\n---\n');
  f.runtime.reconcile(f.ctx);
  assert.doesNotMatch(messages(f).at(-1).content, /Changed later|<description>Hidden/);
  assert.equal(f.state().discovery.some(d => d.path === f.paths[1]), false);
});

for (const failure of ['save', 'send']) test(`interrupted ${failure} recovers once from native entries`, t => {
  const f = queueFixture(t);
  f.record(f.root);
  const broken = createSkillContextRuntime({ ...f.pi, [failure === 'save' ? 'appendEntry' : 'sendMessage']() { throw new Error('interrupted'); } }, f.options);
  assert.throws(() => broken.reconcile(f.ctx), /interrupted/);
  const restored = createSkillContextRuntime(f.pi, f.options);
  restored.reconcile(f.ctx);
  assert.deepEqual(f.state().discovery.map(d => d.path), f.paths);
  assert.equal(messages(f).filter(skillDetails).length, 1);
  const leaf = f.manager.getLeafId();
  restored.reconcile(f.ctx);
  assert.equal(f.manager.getLeafId(), leaf);
});

test('compaction removes discovery even with old read in raw history; fresh read alone can rediscover', t => {
  const f = queueFixture(t);
  f.record(f.root); f.runtime.reconcile(f.ctx);
  const savedCursor = f.state().cursor;
  const anchor = f.manager.appendMessage({ role: 'user', content: 'Kept tail', timestamp: 3 });
  f.manager.appendCompaction('Summary mentions skills, not loaded descriptions', anchor, 100);
  const restarted = createSkillContextRuntime(f.pi, f.options);
  restarted.compact(f.ctx);
  assert.equal(f.state().cursor, savedCursor);
  assert.deepEqual(f.state().discovery, []);
  assert.equal(visibleSkills(messages(f)).size, 0);
  f.record(f.root); restarted.reconcile(f.ctx);
  assert.deepEqual(f.state().discovery.map(d => d.path), f.paths);
});

test('ordinary unrelated tools do not persist queue snapshots; empty discoveries still consume once', t => {
  const f = queueFixture(t, 0);
  f.record(f.root); f.runtime.reconcile(f.ctx);
  const snapshot = f.state();
  f.record('/outside', 'bash');
  f.runtime.reconcile(f.ctx);
  assert.deepEqual(f.state(), snapshot);
  const leaf = f.manager.getLeafId();
  createSkillContextRuntime(f.pi, f.options).reconcile(f.ctx);
  assert.equal(f.manager.getLeafId(), leaf);
});

test('rediscovery of an already-visible description does not gain a second lifetime', t => {
  const f = queueFixture(t);
  f.record(f.paths[0]); f.runtime.reconcile(f.ctx);
  select(f, [], [f.paths[0]]);
  f.record(f.root); f.runtime.reconcile(f.ctx);
  assert.ok(f.state().discovery.some(d => d.path === f.paths[0]));
  const anchor = f.manager.appendMessage({ role: 'user', content: 'Tail', timestamp: 3 });
  f.manager.appendCompaction('Summary', anchor, 100);
  createSkillContextRuntime(f.pi, f.options).compact(f.ctx);
  assert.deepEqual(f.state().discovery, []);
  assert.equal(visibleSkills(messages(f)).size, 0);
});

test('discovery is not truncated to active capacity', t => {
  const f = queueFixture(t, 200, 2);
  f.record(f.root); f.runtime.reconcile(f.ctx);
  assert.equal(f.state().discovery.length, 200);
  assert.equal(visibleSkills(messages(f)).size, 200);
  assert.deepEqual(f.state().active, []);
});
