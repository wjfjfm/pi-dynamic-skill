import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { formatSkillsForPrompt, loadSkillsFromDir, SessionManager, convertToLlm } from '@earendil-works/pi-coding-agent';
import { ACCESS_STATE, ACCESS_NOTICE } from '../dist/access.js';
import { DYNAMIC_CONTEXT, formatDynamicSkills } from '../dist/prompt.js';
import extension from '../dist/index.js';

test('native skill lists, stable context projection, reload refresh and notice-based eviction', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-prompt-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'dynamic-skill', 'SKILL.md');
  const child = (name) => join(dirname(root), 'skills', name, 'SKILL.md');
  const write = (path, name, description, extra = '') => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${extra}---\nPRIVATE BODY\n`);
  };
  write(root, 'dynamic-skill', 'Root');
  write(child('active'), 'active', 'Use <A> & "B"');
  write(child('pending'), 'pending', 'Pending instructions');
  write(child('hidden'), 'hidden', 'Hidden instructions', 'disable-model-invocation: true\n');
  const state = { version: 1, active: [child('active')], pendingEviction: [child('pending'), child('hidden')] };
  const formatted = formatDynamicSkills(state, [root]);
  const native = formatSkillsForPrompt(loadSkillsFromDir({ dir: dirname(child('active')), source: 'test' }).skills);
  assert.ok(formatted.content.includes(native));
  assert.match(formatted.content, /<location>.*pending\/SKILL.md<\/location>/);
  assert.doesNotMatch(formatted.content, /PRIVATE BODY|Hidden instructions/);
  assert.deepEqual(formatted.pendingPaths, [child('pending')]);
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry(ACCESS_STATE, state);
  const hooks = new Map();
  extension({ on: (name, handler) => hooks.set(name, handler),
    getCommands: () => [{ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path: root } }],
    appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
  const ctx = { cwd, sessionManager: manager, hasUI: true, ui: { notify: (text) => assert.fail(text) } };
  const original = [{ role: 'user', content: 'Task', timestamp: 1 }];
  const project = (messages = original) => hooks.get('context')({ messages }, ctx).messages;
  const projected = project();
  assert.equal(projected[0].customType, DYNAMIC_CONTEXT);
  assert.deepEqual(projected.slice(1), original);
  assert.deepEqual(project(projected), projected, 'never duplicate the projected block');
  assert.equal(manager.getBranch().filter((e) => e.customType === ACCESS_NOTICE).length, 1);
  assert.match(JSON.stringify(convertToLlm(projected)), /Dynamic skills/);
  assert.equal(manager.buildSessionContext().messages.length, 0, 'projection is not persisted conversation history');
  write(child('active'), 'active', 'Updated description');
  assert.deepEqual(project(), projected, 'metadata remains stable until settlement/reload');
  await hooks.get('resources_discover')({ reason: 'reload' }, ctx);
  const refreshed = project();
  assert.match(refreshed[0].content, /Updated description/);
  assert.doesNotMatch(refreshed[0].content, /Pending instructions/);
  assert.match(readFileSync(child('pending'), 'utf8'), /Pending instructions/, 'eviction never deletes skill files');
});

test('discovered roots have a fixed native section and never occupy active or pending slots', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-roots-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const roots = ['one', 'two'].map((name) => join(cwd, name, 'dynamic-skill', 'SKILL.md'));
  for (const root of roots) {
    mkdirSync(dirname(root), { recursive: true });
    writeFileSync(root, '---\nname: dynamic-skill\ndescription: Root entry\n---\nROOT BODY');
  }
  const state = { version: 1, active: [roots[0]], pendingEviction: [roots[1]] };
  const formatted = formatDynamicSkills(state, [...roots, roots[0]]);
  const [rootSection, rest] = formatted.content.split('### Active skills');
  assert.match(rootSection, /### Root Skills/);
  for (const root of roots) assert.ok(rootSection.includes(`<location>${root}</location>`));
  assert.equal((rootSection.match(/<name>dynamic-skill<\/name>/g) ?? []).length, 2);
  assert.doesNotMatch(rest, /<name>dynamic-skill<\/name>/);
  assert.doesNotMatch(formatted.content, /ROOT BODY/);
  assert.deepEqual(formatted.pendingPaths, []);
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry(ACCESS_STATE, state);
  for (const [i, name] of ['read', 'write', 'edit'].entries()) {
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: String(i), name, arguments: { path: roots[0] } }], timestamp: 0 });
    manager.appendMessage({ role: 'toolResult', toolCallId: String(i), toolName: name, isError: false, content: [], timestamp: 0 });
  }
  const hooks = new Map();
  extension({ on: (name, handler) => hooks.set(name, handler),
    getCommands: () => roots.map((path) => ({ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path } })),
    appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
  const ctx = { cwd, sessionManager: manager, hasUI: true, ui: { notify: (text) => assert.fail(text) } };
  hooks.get('session_compact')({}, ctx);
  assert.deepEqual(manager.getLeafEntry().data, { version: 1, active: [], pendingEviction: [] });
  const projected = hooks.get('context')({ messages: [] }, ctx).messages[0].content;
  for (const root of roots) assert.ok(projected.includes(`<location>${root}</location>`));
});
