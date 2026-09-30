import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { SessionManager, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import { createSkillContextRuntime, DESCRIPTION_BLOCK, DISCOVERY_DETAILS } from '../dist/runtime.js';
import { ACCESS_STATE } from '../dist/access.js';
import { skillDetails, visibleSkills } from '../dist/context.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-public-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'dynamic-skill', 'SKILL.md');
  const paths = ['a', 'b', 'c'].map(name => join(dirname(root), 'skills', name, 'SKILL.md'));
  for (const [path, name] of [[root, 'dynamic-skill'], ...paths.map(path => [path, basename(dirname(path))])]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: Description ${name}\n---\n`);
  }
  const manager = SessionManager.inMemory(dir);
  const ctx = { cwd: dir, sessionManager: manager };
  const pi = { appendEntry(type, data) { manager.appendCustomEntry(type, structuredClone(data)); } };
  const create = () => createSkillContextRuntime(pi, { roots: () => [root], capacity: () => 1, resolvePath: p => p });
  const runtime = create();
  const raw = () => manager.buildContextEntries().flatMap(sessionEntryToContextMessages);
  const user = (content, timestamp) => { manager.appendMessage({ role: 'user', content, timestamp }); return raw().at(-1); };
  user('Task', 1);
  return { manager, ctx, runtime, raw, user, paths, root, create };
}

test('request projection is stable, append-only, and restores without sendMessage', t => {
  const { manager, ctx, runtime, raw, user, create } = fixture(t);
  const first = runtime.project(ctx, raw());
  assert.equal(first.filter(skillDetails).length, 1);
  const nextUser = user('Next', 2);
  assert.deepEqual(runtime.project(ctx, raw()), [...first, nextUser]);
  const leaf = manager.getLeafId();
  const reopened = create(); reopened.start(ctx, 'resume');
  assert.deepEqual(reopened.project(ctx, raw()), [...first, nextUser]);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(manager.getEntries().filter(entry => entry.customType === DESCRIPTION_BLOCK).length, 1);
});

test('ordinary appends preserve pending; a changed missing-entry mask settles it once', t => {
  const { manager, ctx, runtime, raw, user, paths } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths.slice(0, 2), pendingEviction: [] });
  runtime.project(ctx, raw());
  assert.deepEqual(runtime.state(ctx).pendingEviction, [paths[1]]);
  assert.deepEqual(runtime.state(ctx).announced, [paths[1]]);
  runtime.reconcile(ctx); runtime.project(ctx, raw());
  user('More', 2); runtime.project(ctx, raw());
  assert.deepEqual(runtime.state(ctx).pendingEviction, [paths[1]], 'normal growth is not a settlement cycle');
  runtime.project(ctx, [raw().at(-1)]);
  assert.deepEqual(runtime.state(ctx).pendingEviction, []);
  assert.deepEqual(runtime.state(ctx).active, [paths[0]]);
  const leaf = manager.getLeafId();
  runtime.project(ctx, [raw().at(-1)]);
  assert.equal(manager.getLeafId(), leaf, 'same missing-entry mask must not repeatedly settle or print');
});

test('reload schedules settlement against the retained view, not prematurely against raw history', t => {
  const { manager, ctx, runtime, raw, paths } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths.slice(0, 2), pendingEviction: [] });
  runtime.project(ctx, raw());
  runtime.settle(ctx, false);
  assert.deepEqual(runtime.state(ctx).pendingEviction, [paths[1]]);
  runtime.project(ctx, raw());
  assert.deepEqual(runtime.state(ctx).pendingEviction, []);
});

test('delivered discoveries disappear with their anchor and old read results cannot resurrect them', t => {
  const { manager, ctx, runtime, raw, user, paths, root, create } = fixture(t);
  runtime.project(ctx, raw());
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'read-root', name: 'read', arguments: { path: root } }], timestamp: 2 });
  manager.appendMessage({ role: 'toolResult', toolCallId: 'read-root', toolName: 'read', content: [], isError: false, timestamp: 3,
    details: { [DISCOVERY_DETAILS]: { parent: root, children: [{ filePath: paths[0], name: 'a', description: 'Child discovery' }] } } });
  const discovered = runtime.project(ctx, raw());
  assert.ok(visibleSkills(discovered).has(paths[0]));
  assert.equal(runtime.state(ctx).discovery.length, 1);
  const replacement = user('Retained tail', 4);
  const folded = runtime.project(ctx, [replacement]);
  assert.ok(!visibleSkills(folded).has(paths[0]));
  assert.deepEqual(runtime.state(ctx).discovery, []);
  const reopened = create(); reopened.start(ctx, 'resume');
  assert.deepEqual(reopened.project(ctx, [replacement]), folded);
  assert.deepEqual(reopened.state(ctx).discovery, []);
});
