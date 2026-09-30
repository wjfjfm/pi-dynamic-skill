import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sessionEntryToContextMessages, SessionManager } from '@earendil-works/pi-coding-agent';
import { createSkillContextRuntime } from '../dist/runtime.js';
import { ACCESS_STATE, MANUAL_SELECTION, latestAccessState } from '../dist/access.js';
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
  const pi = { appendEntry(type, data) { manager.appendCustomEntry(type, structuredClone(data)); } };
  const ctx = { cwd: dir, sessionManager: manager };
  const runtime = createSkillContextRuntime(pi, { roots: () => [root], capacity: () => 2, resolvePath: (p) => p });
  return { paths, group, manager, ctx, runtime };
}
const raw = (manager) => manager.buildContextEntries().flatMap(sessionEntryToContextMessages);
const request = (runtime, ctx) => {
  const manager = ctx.sessionManager;
  if (!raw(manager).length) manager.appendMessage({ role: 'user', content: 'Task', timestamp: 0 });
  return runtime.project(ctx, raw(manager));
};
const read = (manager, path, id = 'read') => {
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path } }], timestamp: 1 });
  manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [], isError: false, timestamp: 2 });
};

test('accesses and manual changes settle immediately without rewriting visible descriptions', (t) => {
  const { runtime, ctx, manager, paths } = fixture(t);
  manager.appendMessage({ role: 'user', content: 'task', timestamp: 0 });
  runtime.reconcile(ctx);
  const initial = request(runtime, ctx);
  read(manager, paths[0]);
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [paths[1]], remove: [] });
  assert.deepEqual(latestAccessState(manager.getBranch()).state.active, []);
  runtime.reconcile(ctx);
  const projected = request(runtime, ctx);
  assert.deepEqual(projected.slice(0, initial.length), initial);
  assert.match(projected.at(-1).content, /New active skills/);
  assert.deepEqual(skillDetails(projected.at(-1)).paths, [paths[1], paths[0]]);
  runtime.reconcile(ctx);
  assert.deepEqual(request(runtime, ctx), projected, 'projection survives rebuilding from the branch');
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [], remove: [paths[1]] });
  runtime.reconcile(ctx);
  assert.deepEqual(latestAccessState(manager.getEntries()).state.active, [paths[0]], 'manual entry must not swallow preceding tool accesses');
  assert.deepEqual(latestAccessState(manager.getEntries()).state.pendingEviction, []);
  const leaf = manager.getLeafId();
  assert.deepEqual(request(runtime, ctx), projected, 'immutable visible descriptions are not rewritten');
  assert.deepEqual(request(runtime, ctx), projected);
  assert.equal(manager.getLeafId(), leaf);
});

for (const recovery of ['read', 'manual', 'none']) test(`manual removal chronological recovery: ${recovery}`, (t) => {
  const { runtime, ctx, manager, paths } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [paths[0]], pendingEviction: [] });
  read(manager, paths[0], 'before');
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [], remove: [paths[0]] });
  if (recovery === 'read') read(manager, paths[0], 'after');
  if (recovery === 'manual') manager.appendCustomEntry(MANUAL_SELECTION, { add: [paths[0]], remove: [] });
  request(runtime, ctx);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.active, recovery === 'none' ? [] : [paths[0]]);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, []);
});

test('native loading preserves append order without inserting a synthetic anchor', (t) => {
  const { runtime, ctx, manager } = fixture(t);
  manager.appendCustomMessageEntry('host', 'Stable prefix', false);
  manager.appendMessage({ role: 'user', content: 'A', timestamp: 1 });
  runtime.reconcile(ctx);
  const first = request(runtime, ctx);
  assert.equal(first[0].customType, 'host');
  assert.equal(first[1].role, 'user');
  assert.ok(skillDetails(first[2]));
  manager.appendMessage({ role: 'user', content: 'B', timestamp: 3 });
  runtime.reconcile(ctx);
  const next = request(runtime, ctx);
  assert.deepEqual(next.slice(0, 3), first);
  assert.equal(next.length, 4);
});

test('projection protects visible overflow, appends only missing descriptions, and persists once', (t) => {
  const { runtime, ctx, paths, manager } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths.slice(0, 2), pendingEviction: [] });
  runtime.reconcile(ctx);
  const retained = request(runtime, ctx);
  assert.deepEqual([...visibleSkills(retained)].filter((p) => paths.includes(p)), paths.slice(0, 2));
  read(manager, paths[2]);
  const projected = request(runtime, ctx);
  assert.deepEqual(projected.slice(0, retained.length), retained);
  assert.equal(projected.filter(skillDetails).length, retained.filter(skillDetails).length + 1);
  assert.deepEqual(skillDetails(projected.at(-1)).paths, [paths[2]]);
  assert.deepEqual(skillDetails(projected.at(-1)).pendingPaths, []);
  assert.equal(latestAccessState(manager.getBranch()).state.active.length, 3);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, []);
  const committed = manager.getLeafId();
  assert.deepEqual(request(runtime, ctx), projected, 'do not reprint retained descriptions');
  assert.equal(manager.getLeafId(), committed);
  assert.deepEqual(latestAccessState(manager.getEntries()).state.announced, []);
});

for (const full of [false, true]) {
  for (const tool of ['read', 'write', 'edit']) {
    test(`direct child ${tool} enters LRU and is shown after ${full ? 'zero' : 'incremental'} backtrack`, (t) => {
      const { runtime, ctx, group, manager } = fixture(t);
      runtime.reconcile(ctx);
      assert.deepEqual([...visibleSkills(request(runtime, ctx))], [], 'unaccessed children are not automatically injected');
      manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'access', name: tool, arguments: { path: group } }], timestamp: 1 });
      manager.appendMessage({ role: 'toolResult', toolCallId: 'access', toolName: tool, content: [], isError: false, timestamp: 2 });
      const input = full ? raw(manager).slice(-2) : raw(manager);
      const projected = runtime.project(ctx, input);
      assert.deepEqual(latestAccessState(manager.getBranch()).state.active, [group]);
      assert.deepEqual(skillDetails(projected.at(-1)).paths, [group]);
      assert.match(projected.at(-1).content, full ? /Active skills \(1\/2\)/ : /New active skills/);
      const leaf = manager.getLeafId();
      assert.deepEqual(runtime.project(ctx, input), projected);
      assert.equal(manager.getLeafId(), leaf);
    });
  }
}

test('full rebuild releases visibility protection, shows pending once, and only a later settlement evicts it', (t) => {
  const { runtime, ctx, paths, manager } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths, pendingEviction: [] });
  runtime.settle(ctx, true);
  const projected = request(runtime, ctx);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.active, paths.slice(0, 2));
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, paths.slice(2));
  const leaf = manager.getLeafId();
  assert.deepEqual(request(runtime, ctx), projected);
  assert.equal(manager.getLeafId(), leaf);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.announced, paths.slice(2));
  manager.appendMessage({ role: 'user', content: 'Continue', timestamp: 3 });
  const batch = request(runtime, ctx);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, paths.slice(2));
  runtime.settle(ctx, false);
  assert.deepEqual(request(runtime, ctx), batch, 'expired skills still present in the retained context need no new notices');
  assert.deepEqual(latestAccessState(manager.getBranch()).state.pendingEviction, []);
});

test('rebuilding from an empty loading view uses current descriptions without modifying old native entries', (t) => {
  const { runtime, ctx, manager, paths } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [paths[0]], pendingEviction: [] });
  const prefix = { role: 'custom', customType: 'summary', content: 'Stable summary', display: false, timestamp: 0 };
  const zero = { role: 'custom', customType: 'backtrack:checkpoint', content: '[checkpoint 0]', display: false, timestamp: 0 };
  const retained = [prefix, zero];
  runtime.reconcile(ctx);
  const old = request(runtime, ctx);
  const oldEntries = structuredClone(manager.getEntries());
  writeFileSync(paths[0], '---\nname: a\ndescription: Rebuilt active description\n---\n');
  assert.deepEqual(request(runtime, ctx), old);
  const rebuilt = runtime.project(ctx, retained);
  assert.deepEqual(rebuilt.slice(0, retained.length), retained);
  assert.deepEqual(manager.getEntries().slice(0, oldEntries.length), oldEntries, 'historical records remain immutable');
  assert.equal(rebuilt.filter(skillDetails).length, 1);
  assert.match(JSON.stringify(rebuilt), /Rebuilt active description/);
  assert.doesNotMatch(JSON.stringify(rebuilt), /a description/);
  const committed = manager.getLeafId();
  assert.deepEqual(runtime.project(ctx, retained), rebuilt);
  assert.equal(manager.getLeafId(), committed, 'replaying a completed rebuild must not reset its projection again');
});

test('duplicate compact settlement does not clear a newly materialized projection', (t) => {
  const { runtime, ctx, manager } = fixture(t);
  const anchor = manager.appendCustomEntry('compact-boundary', {});
  manager.appendCompaction('Summary', anchor, 1000);
  runtime.settle(ctx, true);
  const first = request(runtime, ctx);
  const leaf = manager.getLeafId();
  runtime.settle(ctx, true);
  assert.equal(manager.getLeafId(), leaf, 'settlement is deferred until projection');
  assert.deepEqual(request(runtime, ctx), first);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(manager.getBranch().filter((entry) => entry.customType === ACCESS_STATE).length, 1);
});

test('reload differences attach to the effective view rather than an excluded raw tail', (t) => {
  const { runtime, ctx, manager, paths } = fixture(t);
  manager.appendMessage({ role: 'user', content: 'Task', timestamp: 1 });
  runtime.reconcile(ctx);
  const retained = request(runtime, ctx);
  read(manager, paths[0]);
  manager.appendMessage({ role: 'assistant', content: [], stopReason: 'aborted', timestamp: 3 });
  runtime.settle(ctx, false);
  const native = request(runtime, ctx).filter(skillDetails);
  assert.equal(native.length, 2);
  assert.deepEqual(skillDetails(native.at(-1)).paths, [paths[0]]);
  assert.deepEqual(native[0], retained.find(skillDetails));
});

test('protected over-capacity state survives ordinary reconciliation without promotion', t => {
  const { runtime, ctx, manager, paths } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths, pendingEviction: [] });
  const retained = [{ role: 'custom', customType: 'dynamic-skill:context', details: { id: 'visible', paths, pendingPaths: [] } }];
  runtime.project(ctx, retained);
  runtime.reconcile(ctx);
  assert.deepEqual(latestAccessState(manager.getEntries()).state.active, paths);
  runtime.project(ctx, []);
  assert.deepEqual(latestAccessState(manager.getEntries()).state.active, paths.slice(0, 2));
  assert.deepEqual(latestAccessState(manager.getEntries()).state.pendingEviction, paths.slice(2));
});
