import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createEventBus, SessionManager } from '@earendil-works/pi-coding-agent';
import { createSkillContextRuntime } from '../dist/runtime.js';
import { ACCESS_NOTICE, ACCESS_STATE, MANUAL_SELECTION, selectionState, latestAccessState, settleAccesses } from '../dist/access.js';
import { skillDetails, visibleSkills } from '../dist/context.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'dynamic-skill', 'SKILL.md');
  const group = join(dirname(root), 'skills', 'group', 'SKILL.md');
  const paths = ['a', 'b', 'c'].map((name) => join(dirname(group), 'skills', name, 'SKILL.md'));
  for (const [path, name] of [[root, 'dynamic-skill'], [group, 'group'], ...paths.map((path) => [path, dirname(path).split('/').at(-1)])]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: ${name} description\n---\n`);
  }
  const manager = SessionManager.inMemory(dir);
  const pi = {
    events: createEventBus(),
    appendEntry(type, data) { manager.appendCustomEntry(type, structuredClone(data)); },
    sendMessage(message) { manager.appendCustomMessageEntry(message.customType, message.content, message.display, structuredClone(message.details)); },
  };
  const ctx = { cwd: dir, sessionManager: manager };
  const runtime = createSkillContextRuntime(pi, { roots: () => [root], capacity: () => 2, resolvePath: (p) => p, refresh() {} });
  return { paths, group, manager, pi, ctx, runtime };
}
const read = (manager, path, id = 'read') => {
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path } }], timestamp: 1 });
  manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [], isError: false, timestamp: 2 });
};

test('manual additions project on next turn without settlement; removals stay silent until settlement', (t) => {
  const { runtime, ctx, manager, paths } = fixture(t);
  const user = { role: 'user', content: 'task', timestamp: 0 };
  manager.appendMessage(user);
  runtime.reconcile(ctx);
  const initial = manager.buildSessionContext().messages;
  read(manager, paths[0]);
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [paths[1]], remove: [] });
  assert.equal(latestAccessState(manager.getBranch()), undefined);
  runtime.reconcile(ctx);
  const projected = manager.buildSessionContext().messages;
  assert.deepEqual(projected.slice(0, initial.length), initial);
  assert.match(projected.at(-1).content, /New active skills/);
  assert.deepEqual(skillDetails(projected.at(-1)).paths, [paths[1]]);
  runtime.reconcile(ctx);
  assert.deepEqual(manager.buildSessionContext().messages, projected, 'native loading survives rebuilding from the branch');
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [], remove: [paths[1]] });
  assert.deepEqual(selectionState(manager.getBranch()).active, []);
  assert.deepEqual(selectionState(manager.getBranch()).pendingEviction, []);
  runtime.reconcile(ctx);
  assert.deepEqual(manager.buildSessionContext().messages, projected, 'immutable visible descriptions are not rewritten');
  const prepared = runtime.prepare(ctx, projected, 'manual-settle', false);
  prepared.commit();
  assert.deepEqual(latestAccessState(manager.getBranch()).state.active, [paths[0]], 'manual entry must not swallow preceding tool accesses');
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, []);
  assert.ok(!prepared.messages.some((m) => skillDetails(m).paths.includes(paths[1])));
});

for (const recovery of ['read', 'manual', 'none']) test(`manual removal chronological recovery: ${recovery}`, (t) => {
  const { runtime, ctx, manager, paths } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [paths[0]], pendingEviction: [] });
  read(manager, paths[0], 'before');
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [], remove: [paths[0]] });
  if (recovery === 'read') read(manager, paths[0], 'after');
  if (recovery === 'manual') manager.appendCustomEntry(MANUAL_SELECTION, { add: [paths[0]], remove: [] });
  const prepared = runtime.prepare(ctx, [], 'manual-full', true);
  prepared.commit();
  assert.deepEqual(latestAccessState(manager.getBranch()).state.active, recovery === 'none' ? [] : [paths[0]]);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, []);
});

test('native loading preserves append order without inserting a synthetic anchor', (t) => {
  const { runtime, ctx, pi, manager } = fixture(t);
  manager.appendCustomMessageEntry('host', 'Stable prefix', false);
  manager.appendMessage({ role: 'user', content: 'A', timestamp: 1 });
  runtime.reconcile(ctx);
  const first = manager.buildSessionContext().messages;
  assert.equal(first[0].customType, 'host');
  assert.equal(first[1].role, 'user');
  assert.ok(skillDetails(first[2]));
  manager.appendMessage({ role: 'user', content: 'B', timestamp: 3 });
  runtime.reconcile(ctx);
  const next = manager.buildSessionContext().messages;
  assert.deepEqual(next.slice(0, 3), first);
  assert.equal(next.length, 4);
});

test('backtrack preparation protects visible overflow, appends only missing descriptions, and commits once', (t) => {
  const { runtime, ctx, paths, manager } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths.slice(0, 2), pendingEviction: [] });
  runtime.reconcile(ctx);
  const retained = manager.buildSessionContext().messages;
  assert.deepEqual([...visibleSkills(retained)].filter((p) => paths.includes(p)), paths.slice(0, 2));
  read(manager, paths[2]);
  const before = manager.getLeafId();
  const prepared = runtime.prepare(ctx, retained, 'transaction', false);
  assert.equal(manager.getLeafId(), before, 'prepare must not change LRU or append any entries');
  assert.equal(prepared.messages.length, 1);
  assert.deepEqual(skillDetails(prepared.messages[0]).paths, [paths[2]]);
  assert.deepEqual(skillDetails(prepared.messages[0]).pendingPaths, []);
  prepared.commit();
  assert.equal(latestAccessState(manager.getBranch()).state.active.length, 3);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, []);
  const committed = manager.getLeafId();
  prepared.commit();
  runtime.prepare(ctx, retained, 'transaction', false).commit();
  assert.equal(manager.getLeafId(), committed);
  runtime.shown(ctx, prepared.messages);
  assert.equal(manager.getBranch().some((e) => e.customType === ACCESS_NOTICE), false);
  const next = runtime.prepare(ctx, [...retained, ...prepared.messages], 'second', false);
  assert.deepEqual(next.messages, [], 'do not reprint descriptions from any retained block');
  next.commit();
  assert.equal(latestAccessState(manager.getBranch()).state.active.length, 3);
});

for (const full of [false, true]) {
  for (const tool of ['read', 'write', 'edit']) {
    test(`direct child ${tool} enters LRU and is shown after ${full ? 'zero' : 'incremental'} backtrack`, (t) => {
      const { runtime, ctx, group, manager } = fixture(t);
      runtime.reconcile(ctx);
      const retained = manager.buildSessionContext().messages;
      assert.deepEqual([...visibleSkills(retained)], [], 'unaccessed children are not automatically injected');
      manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'access', name: tool, arguments: { path: group } }], timestamp: 1 });
      manager.appendMessage({ role: 'toolResult', toolCallId: 'access', toolName: tool, content: [], isError: false, timestamp: 2 });
      const prepared = runtime.prepare(ctx, full ? [] : retained, 'child-access', full);
      prepared.commit();
      assert.deepEqual(latestAccessState(manager.getBranch()).state.active, [group]);
      assert.deepEqual(skillDetails(prepared.messages[0]).paths, [group]);
      assert.match(prepared.messages[0].content, full ? /Active skills \(1\/2\)/ : /New active skills/);
      assert.deepEqual(runtime.prepare(ctx, prepared.messages, 'next', false).messages, []);
    });
  }
}

test('full rebuild releases visibility protection, shows pending once, and only a later settlement evicts it', (t) => {
  const { runtime, ctx, paths, manager } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths, pendingEviction: [] });
  const prepared = runtime.prepare(ctx, [], 'rebuild', true);
  prepared.commit();
  assert.deepEqual(latestAccessState(manager.getBranch()).state.active, paths.slice(0, 2));
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, paths.slice(2));
  runtime.shown(ctx, prepared.messages);
  runtime.shown(ctx, prepared.messages);
  assert.equal(manager.getBranch().filter((e) => e.customType === ACCESS_NOTICE).length, 1);
  const next = runtime.prepare(ctx, prepared.messages, 'after-notice', false);
  next.commit();
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, []);
  assert.deepEqual(next.messages, [], 'expired skills still present in the retained context need no new notices');
});

test('rebuilding from an empty loading view uses current descriptions without modifying old native entries', (t) => {
  const { runtime, ctx, manager, paths } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [paths[0]], pendingEviction: [] });
  const prefix = { role: 'custom', customType: 'summary', content: 'Stable summary', display: false, timestamp: 0 };
  const zero = { role: 'custom', customType: 'backtrack:checkpoint', content: '[checkpoint 0]', display: false, timestamp: 0 };
  const retained = [prefix, zero];
  runtime.reconcile(ctx);
  const old = manager.buildSessionContext().messages;
  const before = manager.getLeafId();
  writeFileSync(paths[0], '---\nname: a\ndescription: Rebuilt active description\n---\n');
  const prepared = runtime.prepare(ctx, retained, 'reset-zero', true);
  assert.equal(manager.getLeafId(), before, 'preparation must not discard the existing overlay');
  assert.deepEqual(manager.buildSessionContext().messages, old);
  prepared.commit();
  const rebuilt = [...retained, ...prepared.messages];
  assert.deepEqual(runtime.prepare(ctx, rebuilt, 'next-reset', false).messages, [], 'retained native descriptions need no replay');
  assert.equal(rebuilt.filter(skillDetails).length, 1);
  assert.match(JSON.stringify(rebuilt), /Rebuilt active description/);
  assert.doesNotMatch(JSON.stringify(rebuilt), /a description/);
  const committed = manager.getLeafId();
  runtime.prepare(ctx, retained, 'reset-zero', true).commit();
  assert.equal(manager.getLeafId(), committed, 'replaying a completed full rebuild must not reset its projection again');
});

test('duplicate compact settlement does not clear a newly materialized projection', (t) => {
  const { runtime, ctx, manager } = fixture(t);
  const anchor = manager.appendCustomEntry('compact-boundary', {});
  manager.appendCompaction('Summary', anchor, 1000);
  runtime.compact(ctx);
  const first = manager.buildSessionContext().messages;
  const leaf = manager.getLeafId();
  runtime.compact(ctx);
  assert.equal(manager.getLeafId(), leaf, 'the second compact hook must be a complete no-op');
  assert.deepEqual(manager.buildSessionContext().messages, first);
  assert.equal(manager.getBranch().filter((entry) => entry.customType === ACCESS_STATE).length, 1);
});

test('reload differences attach to the effective view rather than an excluded raw tail', (t) => {
  const { runtime, ctx, manager, pi, paths } = fixture(t);
  const user = { role: 'user', content: 'Task', timestamp: 1 };
  manager.appendMessage(user);
  runtime.reconcile(ctx);
  const retained = manager.buildSessionContext().messages;
  read(manager, paths[0]);
  manager.appendMessage({ role: 'assistant', content: [], stopReason: 'aborted', timestamp: 3 });
  runtime.settle(ctx, false);
  const native = manager.buildSessionContext().messages.filter(skillDetails);
  assert.equal(native.length, 2);
  assert.deepEqual(skillDetails(native.at(-1)).paths, [paths[0]]);
  assert.deepEqual(native[0], retained.find(skillDetails));
});

test('protected over-capacity state survives settlement without repeated promotion or truncation', () => {
  const manager = SessionManager.inMemory('/');
  const state = { version: 1, active: ['/a', '/b', '/c', '/d'], pendingEviction: [] };
  manager.appendCustomEntry(ACCESS_STATE, state);
  assert.deepEqual(settleAccesses(manager.getBranch(), (p) => p, () => true, 2, new Set(['/c', '/d'])), state);
  assert.deepEqual(settleAccesses(manager.getBranch(), (p) => p, () => true, 2, new Set(['/d'])),
    { version: 1, active: ['/a', '/b', '/d'], pendingEviction: ['/c'] });
});
