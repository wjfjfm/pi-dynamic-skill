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
