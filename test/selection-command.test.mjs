import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import extension from '../dist/index.js';
import { MANUAL_SELECTION, latestAccessState } from '../dist/access.js';

test('picker browsing is read-only; applying differences settles immediately without rewriting context', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-picker-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'dynamic-skill', 'SKILL.md');
  const child = join(dirname(root), 'skills', 'child', 'SKILL.md');
  for (const [path, name] of [[root, 'dynamic-skill'], [child, 'child']]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: Test\n---\nOriginal body\n`);
  }
  const original = readFileSync(root, 'utf8');
  const manager = SessionManager.inMemory(cwd);
  let command, result;
  extension({ on() {}, registerCommand: (_name, value) => { command = value; },
    getCommands: () => [{ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path: root } }],
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    sendMessage: m => manager.appendCustomMessageEntry(m.customType, m.content, m.display, m.details) });
  const ctx = { mode: 'tui', cwd, sessionManager: manager, hasUI: true, ui: {
    notify(message) { throw new Error(message); }, custom: async () => result,
  } };
  await command.handler('', ctx);
  assert.equal(readFileSync(root, 'utf8'), original, 'viewing the tree must not regenerate indexes');
  assert.equal(manager.getBranch().length, 0);
  result = [child];
  await command.handler('', ctx);
  assert.deepEqual(latestAccessState(manager.getEntries()).state.active, [child]);
  assert.equal(manager.getBranch().filter((entry) => entry.customType === MANUAL_SELECTION).length, 1);
  const count = manager.getEntries().length;
  const messages = manager.buildSessionContext().messages;
  await command.handler('', ctx);
  assert.equal(manager.getEntries().length, count, 'unchanged application does not record an event');
  result = [];
  await command.handler('', ctx);
  assert.deepEqual(latestAccessState(manager.getEntries()).state.active, []);
  assert.deepEqual(manager.buildSessionContext().messages, messages, 'cancelling does not change descriptions');
  assert.equal(readFileSync(root, 'utf8'), original);
});
