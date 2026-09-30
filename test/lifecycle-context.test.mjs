import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueFixture } from './queue-fixture.mjs';
import { DESCRIPTION_BLOCK } from '../dist/runtime.js';
import { MANUAL_SELECTION } from '../dist/access.js';
import { skillDetails, visibleSkills } from '../dist/context.js';
import { anchorSources, projectDescriptions } from '../dist/projection.js';

function fixture(t) {
  const f = queueFixture(t, 3, 2);
  f.manager.appendMessage({ role: 'user', content: 'Task', timestamp: 0 });
  const raw = () => f.manager.buildSessionContext().messages;
  const retained = () => projectDescriptions(raw(), f.manager.getBranch().flatMap(entry =>
    entry.type === 'custom' && entry.customType === DESCRIPTION_BLOCK ? [entry.data] : []),
    anchorSources(f.manager.buildContextEntries()));
  const request = () => f.runtime.project(f.ctx, raw());
  const select = (add, remove = []) => f.manager.appendCustomEntry(MANUAL_SELECTION, { add, remove });
  return { ...f, raw, retained, request, select };
}

test('description records are immutable; manual promotion does not reload them', t => {
  const f = fixture(t);
  f.request();
  f.select([f.paths[0]]);
  const before = f.request();
  assert.deepEqual([...visibleSkills(before)], [f.paths[0]]);
  assert.equal(f.manager.getBranch().filter(e => e.customType === DESCRIPTION_BLOCK).length, 2);
  assert.deepEqual(f.request(), before);
  assert.deepEqual(f.state().active, [f.paths[0]]);
  f.select([], [f.paths[0]]);
  assert.deepEqual(f.request(), before, 'queue removal cannot rewrite loaded context');
  assert.deepEqual(f.state().active, []);
});

test('tree preserves continuous queues and fills only descriptions missing from the target context', t => {
  const f = fixture(t);
  f.request();
  const rootLeaf = f.manager.getLeafId();
  f.select([f.paths[0]]); f.request();
  const loadedLeaf = f.manager.getLeafId();
  f.manager.branch(rootLeaf);
  assert.deepEqual([...visibleSkills(f.retained())], []);
  f.select([f.paths[1]]);
  assert.deepEqual([...visibleSkills(f.request())], [f.paths[1], f.paths[0]]);
  f.manager.branch(loadedLeaf);
  assert.deepEqual([...visibleSkills(f.retained())], [f.paths[0]]);
  const leaf = f.manager.getLeafId();
  const projected = f.request();
  assert.notEqual(f.manager.getLeafId(), leaf, 'the continuous queue still retains B');
  assert.deepEqual(skillDetails(projected.at(-1)).paths, [f.paths[1]]);
  assert.deepEqual(f.runtime.state(f.ctx).active, [f.paths[1], f.paths[0]]);
});

test('compaction drops loading facts even if its summary mentions the skill', t => {
  const f = fixture(t);
  f.seed([f.paths[0]]);
  const oldId = f.request().find(skillDetails).details.id;
  const anchor = f.manager.appendCustomEntry('compact-boundary', {});
  f.manager.appendCompaction(`Previously loaded ${f.paths[0]}`, anchor, 1000);
  assert.equal(visibleSkills(f.retained()).size, 0);
  f.runtime.compact(f.ctx);
  const projected = f.request();
  assert.deepEqual([...visibleSkills(projected)], [f.paths[0]]);
  assert.notEqual(projected.find(skillDetails).details.id, oldId);
  const leaf = f.manager.getLeafId();
  f.runtime.compact(f.ctx); f.request();
  assert.equal(f.manager.getLeafId(), leaf);
});

test('pending notices are independent of loaded descriptions and recover after branch navigation', t => {
  const f = fixture(t);
  f.seed([], [f.paths[0]]);
  f.manager.appendCustomMessageEntry('dynamic-skill:context', 'Already loaded', false,
    { id: 'loaded', paths: [f.paths[0]], pendingPaths: [] });
  const beforeNotice = f.manager.getLeafId();
  const notice = f.request().at(-1);
  assert.deepEqual(skillDetails(notice).paths, [], 'do not reload a description to announce pending');
  assert.deepEqual(skillDetails(notice).pendingPaths, [f.paths[0]]);
  assert.match(notice.content, /Pending eviction/);
  const leaf = f.manager.getLeafId();
  f.request(); assert.equal(f.manager.getLeafId(), leaf);
  f.manager.branch(beforeNotice);
  assert.deepEqual(skillDetails(f.request().at(-1)).pendingPaths, [f.paths[0]], 'removed notice must be reissued');
});

test('generic context transition protects loaded overflow independently of queue origin', t => {
  const f = fixture(t);
  f.seed(f.paths);
  f.manager.appendCustomMessageEntry('dynamic-skill:context', 'Discovered skill', false,
    { id: 'discovery', paths: [f.paths[2]], pendingPaths: [] });
  f.runtime.settle(f.ctx, false, 'transition');
  const delta = f.request().filter(skillDetails);
  assert.deepEqual(f.state().active, f.paths);
  assert.deepEqual(f.state().pendingEviction, []);
  assert.equal(delta.length, 2);
  assert.deepEqual(skillDetails(delta[1]).paths, f.paths.slice(0, 2));
  const leaf = f.manager.getLeafId();
  f.runtime.settle(f.ctx, false, 'transition'); f.request();
  assert.equal(f.manager.getLeafId(), leaf, 'transition settlement is idempotent');
});
