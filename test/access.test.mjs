import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ACCESS_STATE, settleAccesses } from '../dist/access.js';
import extension from '../dist/index.js';

function record(manager, id, name, path, isError = false) {
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path } }], timestamp: 0 });
  manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, isError, content: [{ type: 'text', text: 'Result' }], timestamp: 0 });
}

test('settlement deduplicates successful read/write/edit by last access and respects its persisted boundary', () => {
  const manager = SessionManager.inMemory('/');
  const active = Array.from({ length: 20 }, (_, i) => `/skill-${i}/SKILL.md`);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active, pendingEviction: ['/pending/SKILL.md'] });
  record(manager, '1', 'read', active[19]);
  record(manager, '2', 'write', active[19]);
  record(manager, '3', 'edit', active[19]);
  record(manager, '4', 'read', '/pending/SKILL.md', true);
  record(manager, '5', 'bash', '/pending/SKILL.md');
  record(manager, '6', 'read', '/outside/SKILL.md');
  const eligible = (path) => path !== '/outside/SKILL.md';
  const state = settleAccesses(manager.getBranch(), (path) => path, eligible);
  assert.equal(state.active.indexOf(active[19]), 9, 'three operations promote only once');
  assert.deepEqual(state.pendingEviction, ['/pending/SKILL.md']);
  manager.appendCustomEntry(ACCESS_STATE, state);
  assert.deepEqual(settleAccesses(manager.getBranch(), (path) => path, eligible), state);
  record(manager, '7', 'read', '/pending/SKILL.md');
  const restored = settleAccesses(manager.getBranch(), (path) => path, eligible);
  assert.equal(restored.active.indexOf('/pending/SKILL.md'), 10);
  assert.equal(restored.active.length, 20);
  assert.equal(restored.pendingEviction.includes('/pending/SKILL.md'), false);
});

test('latest successful access determines batch order; another branch does not leak into settlement', () => {
  const manager = SessionManager.inMemory('/');
  record(manager, '1', 'read', '/A');
  const fork = manager.getLeafId();
  record(manager, '2', 'write', '/B');
  record(manager, '3', 'edit', '/A');
  // Last accesses are B, A; two fresh admissions put A before B.
  assert.deepEqual(settleAccesses(manager.getBranch(), (p) => p, () => true).active, ['/A', '/B']);
  manager.branch(fork);
  record(manager, '4', 'read', '/C');
  assert.deepEqual(settleAccesses(manager.getBranch(), (p) => p, () => true).active, ['/C', '/A']);
});

test('extension settles on successful compact and reload, never on tool results', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-access-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'dynamic-skill', 'SKILL.md');
  const child = join(cwd, 'dynamic-skill', 'skills', 'child', 'SKILL.md');
  mkdirSync(join(child, '..'), { recursive: true });
  writeFileSync(root, '---\nname: dynamic-skill\ndescription: Root\n---\n');
  writeFileSync(child, '---\nname: child\ndescription: Child\n---\n');
  const manager = SessionManager.inMemory(cwd);
  const ctx = { cwd, sessionManager: manager, hasUI: true, ui: { notify: (text) => assert.fail(text) } };
  const hooks = new Map();
  const install = () => extension({
    on: (name, handler) => hooks.set(name, handler),
    getCommands: () => [{ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path: root } }],
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
  });
  install();
  await hooks.get('resources_discover')({ reason: 'startup' }, ctx);
  record(manager, '1', 'read', 'dynamic-skill/skills/child/SKILL.md');
  const before = manager.getLeafId();
  hooks.get('tool_result')({ toolName: 'read', input: { path: child }, isError: false }, ctx);
  assert.equal(manager.getLeafId(), before);
  assert.equal(hooks.has('session_before_compact'), false);
  hooks.get('session_compact')({}, ctx);
  assert.deepEqual(manager.getLeafEntry().data.active, [child]);
  const state = manager.getLeafEntry().data;
  install(); // A fresh extension instance restores state from the session.
  await hooks.get('resources_discover')({ reason: 'reload' }, ctx);
  assert.deepEqual(manager.getLeafEntry().data, state);
  record(manager, '2', 'edit', child);
  await hooks.get('resources_discover')({ reason: 'reload' }, ctx);
  assert.deepEqual(manager.getLeafEntry().data.active, [resolve(child)]);
  assert.equal(manager.buildSessionContext().messages.some((m) => m.customType === ACCESS_STATE), false);
});
