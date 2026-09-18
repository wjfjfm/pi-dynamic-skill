import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createEventBus, SessionManager } from '@earendil-works/pi-coding-agent';
import { createSkillContextRuntime } from '../dist/runtime.js';
import { ACCESS_NOTICE, ACCESS_STATE, latestAccessState, settleAccesses } from '../dist/access.js';
import { skillContextService, skillDetails, visibleSkills } from '../dist/context.js';

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
  const pi = { events: createEventBus(), appendEntry(type, data) { manager.appendCustomEntry(type, structuredClone(data)); } };
  const ctx = { cwd: dir, sessionManager: manager };
  const runtime = createSkillContextRuntime(pi, { roots: () => [root], capacity: () => 2, resolvePath: (p) => p, refresh() {} });
  return { paths, group, manager, pi, ctx, runtime };
}
const read = (manager, path, id = 'read') => {
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path } }], timestamp: 1 });
  manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [], isError: false, timestamp: 2 });
};

test('fixed skill anchor is immediately before first user, not before the whole prefix or latest user', (t) => {
  const { runtime, ctx, pi } = fixture(t);
  assert.equal(skillContextService(pi), runtime);
  assert.deepEqual(runtime.project(ctx, []), []);
  const prefix = { role: 'custom', customType: 'host', content: 'Stable prefix', display: false, timestamp: 0 };
  const userA = { role: 'user', content: 'A', timestamp: 1 };
  const first = runtime.project(ctx, [prefix, userA]);
  assert.equal(first[0], prefix);
  assert.ok(skillDetails(first[1]));
  assert.equal(first[2], userA);
  const userB = { role: 'user', content: 'B', timestamp: 3 };
  const next = runtime.project(ctx, [prefix, userA, userB]);
  assert.deepEqual(next.slice(0, 3), first);
  assert.equal(next[3], userB);
  assert.deepEqual(runtime.project(ctx, next), next);
});

test('backtrack preparation protects visible overflow, appends only missing descriptions, and commits once', (t) => {
  const { runtime, ctx, paths, manager } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths.slice(0, 2), pendingEviction: [] });
  const retained = runtime.project(ctx, [{ role: 'user', content: 'task', timestamp: 0 }]);
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

test('protected over-capacity state survives settlement without repeated promotion or truncation', () => {
  const manager = SessionManager.inMemory('/');
  const state = { version: 1, active: ['/a', '/b', '/c', '/d'], pendingEviction: [] };
  manager.appendCustomEntry(ACCESS_STATE, state);
  assert.deepEqual(settleAccesses(manager.getBranch(), (p) => p, () => true, 2, new Set(['/c', '/d'])), state);
  assert.deepEqual(settleAccesses(manager.getBranch(), (p) => p, () => true, 2, new Set(['/d'])),
    { version: 1, active: ['/a', '/b', '/d'], pendingEviction: ['/c'] });
});
