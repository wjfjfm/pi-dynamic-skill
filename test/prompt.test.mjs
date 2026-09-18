import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { formatSkillsForPrompt, loadSkillsFromDir, SessionManager, convertToLlm } from '@earendil-works/pi-coding-agent';
import { ACCESS_STATE, ACCESS_NOTICE, latestAccessState } from '../dist/access.js';
import { DYNAMIC_CONTEXT, formatDynamicSkills } from '../dist/prompt.js';
import extension from '../dist/index.js';

test('native skill lists, immutable projection across reload and notice-based eviction', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-prompt-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'dynamic-skill', 'SKILL.md');
  const group = join(dirname(root), 'skills', 'group', 'SKILL.md');
  const child = (name) => join(dirname(group), 'skills', name, 'SKILL.md');
  const write = (path, name, description, extra = '') => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${extra}---\nPRIVATE BODY\n`);
  };
  write(root, 'dynamic-skill', 'Root');
  write(group, 'group', 'Group entry');
  write(child('active'), 'active', 'Use <A> & "B"');
  write(child('pending'), 'pending', 'Pending instructions');
  write(child('hidden'), 'hidden', 'Hidden instructions', 'disable-model-invocation: true\n');
  const state = { version: 1, active: [child('active')], pendingEviction: [child('pending'), child('hidden')] };
  const formatted = formatDynamicSkills(state, [root]);
  const native = formatSkillsForPrompt(loadSkillsFromDir({ dir: dirname(child('active')), source: 'test' }).skills);
  assert.ok(formatted.content.includes(native.slice(native.indexOf('<available_skills>'))));
  const guidance = native.slice(0, native.indexOf('<available_skills>')).trim();
  assert.equal(formatted.content.split(guidance).length - 1, 1);
  assert.doesNotMatch(formatted.content, /### Root Skills|Group entry/);
  assert.match(formatted.content, /### Active skills \(1\/20\)/);
  assert.match(formatted.content, /### Pending eviction/);
  assert.match(formatted.content, /Read a skill's SKILL.md to retain it/);
  assert.match(formatted.content, /<location>.*pending\/SKILL.md<\/location>/);
  assert.doesNotMatch(formatted.content, /PRIVATE BODY/);
  assert.doesNotMatch(formatted.content, /Hidden instructions/);
  assert.deepEqual(formatted.pendingPaths, [child('pending')]);
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry(ACCESS_STATE, state);
  const hooks = new Map();
  extension({ registerCommand: () => {}, on: (name, handler) => hooks.set(name, handler),
    getCommands: () => [{ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path: root } }],
    appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
  const ctx = { cwd, sessionManager: manager, hasUI: true, ui: { notify: (text) => assert.fail(text) } };
  const original = [{ role: 'user', content: 'Task', timestamp: 1 }];
  manager.appendMessage(original[0]);
  const project = (messages = original) => hooks.get('context')({ messages }, ctx).messages;
  const projected = project();
  assert.equal(projected[0].customType, DYNAMIC_CONTEXT);
  assert.deepEqual(projected.slice(1), original);
  assert.deepEqual(project(projected), projected, 'never duplicate the projected block');
  assert.equal(manager.getBranch().filter((e) => e.customType === ACCESS_NOTICE).length, 1);
  assert.match(JSON.stringify(convertToLlm(projected)), /Dynamic skills/);
  assert.equal(manager.buildSessionContext().messages.length, 1, 'projection metadata is not persisted as conversation history');
  write(child('active'), 'active', 'Updated description');
  assert.deepEqual(project(), projected, 'metadata remains stable until settlement/reload');
  await hooks.get('resources_discover')({ reason: 'reload' }, ctx);
  const refreshed = project();
  assert.deepEqual(refreshed, projected, 'reload must not rewrite descriptions already injected');
  assert.doesNotMatch(refreshed[0].content, /Updated description/);
  assert.equal(latestAccessState(manager.getBranch()).state.pendingEviction.includes(child('pending')), false,
    'internal eviction does not erase or reprint the historical description');
  assert.doesNotMatch(refreshed[0].content, /<name>group<\/name>/);
  assert.match(readFileSync(root, 'utf8'), /skills\/group\/SKILL.md/, 'root navigation is available when the root skill is read');
  assert.match(readFileSync(child('pending'), 'utf8'), /Pending instructions/, 'eviction never deletes skill files');
});

test('direct children are discovered through root indexes, not injected or assigned LRU slots', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-roots-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const roots = ['one', 'two'].map((name) => join(cwd, name, 'dynamic-skill', 'SKILL.md'));
  for (const root of roots) {
    mkdirSync(dirname(root), { recursive: true });
    writeFileSync(root, '---\nname: dynamic-skill\ndescription: Root entry\n---\nROOT BODY');
  }
  const children = roots.map((root) => join(dirname(root), 'skills', 'entry', 'SKILL.md'));
  for (const child of children) {
    mkdirSync(dirname(child), { recursive: true });
    writeFileSync(child, '---\nname: entry\ndescription: Entry\n---\nCHILD BODY');
  }
  const state = { version: 1, active: [roots[0], children[0]], pendingEviction: [roots[1], children[1]] };
  const formatted = formatDynamicSkills(state, [...roots, roots[0]]);
  assert.doesNotMatch(formatted.content, /Root Skills|<available_skills>|<name>entry<\/name>/);
  assert.deepEqual(formatted.paths, []);
  assert.equal(formatDynamicSkills(state, roots, 20, new Set(), false).content, '');
  assert.doesNotMatch(formatted.content, /### Pending eviction|None\./);
  assert.doesNotMatch(formatted.content, /ROOT BODY|CHILD BODY|<name>dynamic-skill<\/name>/);
  assert.deepEqual(formatted.pendingPaths, []);
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry(ACCESS_STATE, state);
  for (const [i, name] of ['read', 'write', 'edit'].entries()) {
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: String(i), name, arguments: { path: children[0] } }], timestamp: 0 });
    manager.appendMessage({ role: 'toolResult', toolCallId: String(i), toolName: name, isError: false, content: [], timestamp: 0 });
  }
  const hooks = new Map();
  extension({ registerCommand: () => {}, on: (name, handler) => hooks.set(name, handler),
    getCommands: () => roots.map((path) => ({ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path } })),
    appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
  const ctx = { cwd, sessionManager: manager, hasUI: true, ui: { notify: (text) => assert.fail(text) } };
  hooks.get('session_compact')({}, ctx);
  assert.deepEqual(latestAccessState(manager.getBranch()).state, { version: 1, active: [], pendingEviction: [] });
  const projected = hooks.get('context')({ messages: [{ role: 'user', content: 'Task', timestamp: 1 }] }, ctx).messages[0].content;
  for (const child of children) assert.ok(!projected.includes(child));
  assert.match(projected, /Active skills \(0\/20\)/);
  for (const root of roots) assert.match(readFileSync(root, 'utf8'), /skills\/entry\/SKILL.md/);
});


test('an empty skill list retains the ON marker and configured capacity without instructions', () => {
  const formatted = formatDynamicSkills({ active: [], pendingEviction: [] }, [], 7);
  assert.equal(formatted.content, '[dynamic-skill extention: ON]\n\n## Dynamic skills\n\n### Active skills (0/7)');
  assert.deepEqual(formatted.pendingPaths, []);
});
