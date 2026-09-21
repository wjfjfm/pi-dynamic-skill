import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createEventBus, SessionManager } from '@earendil-works/pi-coding-agent';
import { createSkillContextRuntime } from '../dist/runtime.js';
import { ACCESS_STATE, MANUAL_SELECTION, latestAccessState } from '../dist/access.js';
import { skillDetails, visibleSkills } from '../dist/context.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'native-skill-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'dynamic-skill', 'SKILL.md');
  const paths = ['a', 'b', 'c'].map(name => join(dirname(root), 'skills', name, 'SKILL.md'));
  for (const [path, name] of [[root, 'dynamic-skill'], ...paths.map(path => [path, dirname(path).split('/').at(-1)])]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: ${name} description\n---\n`);
  }
  const manager = SessionManager.inMemory(dir);
  const ctx = { cwd: dir, sessionManager: manager };
  const pi = {
    events: createEventBus(),
    appendEntry(type, data) { manager.appendCustomEntry(type, structuredClone(data)); },
    sendMessage(message, options) {
      assert.equal(options.triggerTurn, false);
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, structuredClone(message.details));
    },
  };
  const runtime = createSkillContextRuntime(pi, { roots: () => [root], capacity: () => 2, resolvePath: p => p, refresh() {} });
  const messages = () => manager.buildSessionContext().messages;
  return { manager, ctx, pi, runtime, paths, messages };
}

test('native messages are immutable loading records; manual promotion does not reload them', t => {
  const { manager, ctx, runtime, paths, messages } = fixture(t);
  runtime.reconcile(ctx);
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [paths[0]], remove: [] });
  runtime.reconcile(ctx);
  const before = messages();
  assert.deepEqual([...visibleSkills(before)], [paths[0]]);
  assert.equal(manager.getBranch().filter(e => e.type === 'custom_message').length, 2);
  runtime.reconcile(ctx);
  assert.deepEqual(messages(), before);
  assert.equal(latestAccessState(manager.getBranch()), undefined);
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [], remove: [paths[0]] });
  runtime.reconcile(ctx);
  assert.deepEqual(messages(), before, 'queue removal cannot rewrite loaded context');
});

test('native tree branches recover loading only from the selected effective path', t => {
  const { manager, ctx, runtime, paths, messages } = fixture(t);
  runtime.reconcile(ctx);
  const rootLeaf = manager.getLeafId();
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [paths[0]], remove: [] });
  runtime.reconcile(ctx);
  const loadedLeaf = manager.getLeafId();
  manager.branch(rootLeaf);
  assert.deepEqual([...visibleSkills(messages())], []);
  manager.appendCustomEntry(MANUAL_SELECTION, { add: [paths[1]], remove: [] });
  runtime.reconcile(ctx);
  assert.deepEqual([...visibleSkills(messages())], [paths[1]]);
  manager.branch(loadedLeaf);
  assert.deepEqual([...visibleSkills(messages())], [paths[0]]);
  const leaf = manager.getLeafId();
  runtime.reconcile(ctx);
  assert.equal(manager.getLeafId(), leaf, 'restored native descriptions need no replay');
});

test('compaction drops loading facts even if its summary mentions the skill', t => {
  const { manager, ctx, runtime, paths, messages } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [paths[0]], pendingEviction: [] });
  runtime.reconcile(ctx);
  const oldId = messages().find(skillDetails).details.id;
  const anchor = manager.appendCustomEntry('compact-boundary', {});
  manager.appendCompaction(`Previously loaded ${paths[0]}`, anchor, 1000);
  assert.equal(visibleSkills(messages()).size, 0);
  runtime.compact(ctx);
  assert.deepEqual([...visibleSkills(messages())], [paths[0]]);
  assert.notEqual(messages().find(skillDetails).details.id, oldId);
  const leaf = manager.getLeafId();
  runtime.compact(ctx);
  assert.equal(manager.getLeafId(), leaf);
});

test('pending notices are independent of loaded descriptions and recover after branch navigation', t => {
  const { manager, ctx, runtime, paths, messages } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [paths[0]], pendingEviction: [] });
  runtime.reconcile(ctx);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [], pendingEviction: [paths[0]] });
  const beforeNotice = manager.getLeafId();
  runtime.reconcile(ctx);
  const notice = messages().at(-1);
  assert.deepEqual(skillDetails(notice).paths, [], 'do not reload a description to announce pending');
  assert.deepEqual(skillDetails(notice).pendingPaths, [paths[0]]);
  assert.match(notice.content, /Pending eviction/);
  const leaf = manager.getLeafId();
  runtime.reconcile(ctx);
  assert.equal(manager.getLeafId(), leaf);
  manager.branch(beforeNotice);
  runtime.reconcile(ctx);
  assert.deepEqual(skillDetails(messages().at(-1)).pendingPaths, [paths[0]], 'a notice removed from effective context must be reissued');
});

test('generic context transition protects loaded overflow independently of queue origin', t => {
  const { manager, ctx, pi, runtime, paths } = fixture(t);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths, pendingEviction: [] });
  const retained = [{ role: 'custom', customType: 'dynamic-skill:context', content: 'Discovered skill', display: false, timestamp: 0,
    details: { id: 'discovery', paths: [paths[2]], pendingPaths: [] } }];
  const message = retained[0];
  manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  runtime.settle(ctx, false, 'transition');
  assert.deepEqual(latestAccessState(manager.getBranch()).state, { version: 1, active: paths, pendingEviction: [] });
  const delta = manager.buildSessionContext().messages.filter(skillDetails);
  assert.equal(delta.length, 2);
  assert.deepEqual(skillDetails(delta[1]).paths, paths.slice(0, 2));
  const leaf = manager.getLeafId();
  runtime.settle(ctx, false, 'transition');
  assert.equal(manager.getLeafId(), leaf, 'transition settlement is idempotent');
});
