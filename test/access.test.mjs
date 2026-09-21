import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ACCESS_STATE, latestAccessState } from '../dist/access.js';
import { queueFixture } from './queue-fixture.mjs';
import extension from '../dist/index.js';

function record(manager, id, name, path, isError = false) {
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path } }], timestamp: 0 });
  manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, isError, content: [{ type: 'text', text: 'Result' }], timestamp: 0 });
}

test('one promotion per batch, another across batches; persisted cursor prevents replay', t => {
  const f = queueFixture(t, 21, 20);
  f.seed(f.paths.slice(0, 20), [f.paths[20]]);
  for (const name of ['read', 'write', 'edit']) f.record(f.paths[19], name);
  f.record(f.paths[20], 'read', true);
  f.record(f.paths[20], 'bash');
  f.record('/outside/SKILL.md');
  f.runtime.reconcile(f.ctx);
  assert.equal(f.state().active.indexOf(f.paths[19]), 9);
  assert.deepEqual(f.state().pendingEviction, [f.paths[20]]);
  const leaf = f.manager.getLeafId();
  f.runtime.reconcile(f.ctx);
  assert.equal(f.manager.getLeafId(), leaf);
  f.record(f.paths[19], 'edit');
  f.runtime.reconcile(f.ctx);
  assert.equal(f.state().active.indexOf(f.paths[19]), 4);
  f.record(f.paths[20]);
  f.runtime.reconcile(f.ctx);
  assert.equal(f.state().active.indexOf(f.paths[20]), 10);
  assert.equal(f.state().pendingEviction.includes(f.paths[20]), false);
});

test('last successful access determines batch order; navigation does not replay history', t => {
  const f = queueFixture(t);
  f.record(f.paths[0]);
  const branch = f.manager.getLeafId();
  f.record(f.paths[1], 'write');
  f.record(f.paths[0], 'edit');
  f.runtime.reconcile(f.ctx);
  assert.deepEqual(f.state().active, [f.paths[0], f.paths[1]]);
  f.manager.branch(branch);
  f.runtime.reconcile(f.ctx);
  assert.deepEqual(f.state().active, [f.paths[0], f.paths[1]]);
});

test('legacy shown notices migrate; only unvisited pending expires on a lifecycle cycle', t => {
  const f = queueFixture(t, 5);
  const id = f.seed(f.paths.slice(0, 2), f.paths.slice(2));
  f.manager.appendCustomEntry('dynamic-skill:eviction-notice', { settlementId: id, paths: f.paths.slice(2, 4) });
  f.record(f.paths[2]);
  f.runtime.settle(f.ctx, false, 'reload:one');
  assert.deepEqual(f.state().active, [f.paths[0], f.paths[2]]);
  assert.deepEqual(f.state().pendingEviction, [f.paths[4], f.paths[1]]);
  f.runtime.reconcile(f.ctx);
  assert.deepEqual(f.state().pendingEviction, [f.paths[4], f.paths[1]]);
  f.runtime.shown(f.ctx, f.manager.buildSessionContext().messages);
  f.runtime.settle(f.ctx, false, 'reload:two');
  assert.deepEqual(f.state().pendingEviction, []);
});

test('extension settles at turn_end and restores on reload, never commits tentative tool results', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-access-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'dynamic-skill', 'SKILL.md');
  const group = join(cwd, 'dynamic-skill', 'skills', 'group', 'SKILL.md');
  const child = join(group, '..', 'skills', 'child', 'SKILL.md');
  mkdirSync(join(child, '..'), { recursive: true });
  writeFileSync(root, '---\nname: dynamic-skill\ndescription: Root\n---\n');
  writeFileSync(group, '---\nname: group\ndescription: Group\n---\n');
  writeFileSync(child, '---\nname: child\ndescription: Child\n---\n');
  const manager = SessionManager.inMemory(cwd);
  const ctx = { cwd, sessionManager: manager, hasUI: true, ui: { notify: (text) => assert.fail(text) } };
  const hooks = new Map();
  const install = () => extension({ registerCommand: () => {},
    on: (name, handler) => hooks.set(name, handler),
    getCommands: () => [{ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path: root } }],
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    sendMessage: (m) => manager.appendCustomMessageEntry(m.customType, m.content, m.display, m.details),
  });
  install();
  await hooks.get('resources_discover')({ reason: 'startup' }, ctx);
  record(manager, '1', 'read', 'dynamic-skill/skills/group/skills/child/SKILL.md');
  const before = manager.getLeafId();
  hooks.get('tool_result')({ toolName: 'read', input: { path: child }, isError: false }, ctx);
  assert.equal(manager.getLeafId(), before);
  assert.equal(hooks.has('session_before_compact'), false);
  hooks.get('turn_end')({}, ctx);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.active, [child]);
  const state = latestAccessState(manager.getBranch()).state;
  install(); // A fresh extension instance restores state from the session.
  await hooks.get('resources_discover')({ reason: 'reload' }, ctx);
  assert.deepEqual(latestAccessState(manager.getBranch()).state, state);
  record(manager, '2', 'edit', child);
  await hooks.get('resources_discover')({ reason: 'reload' }, ctx);
  assert.deepEqual(latestAccessState(manager.getBranch()).state.active, [resolve(child)]);
  assert.equal(manager.buildSessionContext().messages.some((m) => m.customType === ACCESS_STATE), false);
});

test('compact prunes missing skills without modifying authored indexes', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-compact-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'dynamic-skill', 'SKILL.md');
  const group = join(root, '..', 'skills', 'group', 'SKILL.md');
  const child = (name) => join(group, '..', 'skills', name, 'SKILL.md');
  const write = (path, name) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: ${name} instructions\n---\n`);
  };
  write(root, 'dynamic-skill');
  write(group, 'group');
  write(child('old'), 'old');
  write(child('removed'), 'removed');
  const manager = SessionManager.inMemory(cwd);
  const hooks = new Map();
  const warnings = [];
  let assertRefreshed = false;
  extension({ registerCommand: () => {}, on: (name, handler) => hooks.set(name, handler),
    getCommands: () => [{ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path: root } }],
    sendMessage: (m) => manager.appendCustomMessageEntry(m.customType, m.content, m.display, m.details),
    appendEntry: (type, data) => {
      if (assertRefreshed && type === ACCESS_STATE) {
        const text = readFileSync(group, 'utf8');
        assert.equal(text, '---\nname: group\ndescription: group instructions\n---\n');
      }
      manager.appendCustomEntry(type, data);
    } });
  const ctx = { cwd, sessionManager: manager, hasUI: true, ui: { notify: (text) => warnings.push(text) } };
  await hooks.get('resources_discover')({ reason: 'startup' }, ctx);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [child('old'), child('removed')], pendingEviction: [] });
  hooks.get('context')({ messages: [] }, ctx);
  renameSync(join(child('old'), '..'), join(child('moved'), '..'));
  write(child('moved'), 'moved');
  rmSync(join(child('removed'), '..'), { recursive: true });
  write(child('invalid'), 'wrong-name');
  record(manager, 'moved-read', 'read', child('moved'));
  assertRefreshed = true;
  assert.doesNotThrow(() => hooks.get('session_compact')({}, ctx));
  assert.deepEqual(latestAccessState(manager.getBranch()).state.active, [child('moved')]);
  hooks.get('tool_result')({ toolName: 'read', input: { path: group }, isError: false }, ctx);
  assert.ok(warnings.some((text) => text.includes('invalid/SKILL.md')));
  const content = manager.buildSessionContext().messages.findLast(m => m.customType === 'dynamic-skill:context').content;
  assert.match(content, /<name>moved<\/name>/);
  assert.doesNotMatch(content, /<name>(old|removed)<\/name>/);
  assert.equal(hooks.has('session_compact_failed'), false);
});
