import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../dist/config.js';
import { storagePaths } from '../dist/storage.js';
import { ACCESS_STATE, latestAccessState } from '../dist/access.js';
import extension from '../dist/index.js';

test('capacity config defaults safely and rejects malformed values', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dynamic-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'dynamic-skill.json');
  assert.deepEqual(loadConfig(path), { capacity: 20, diagnostics: [] });
  for (const content of ['{}', '{"capacity":5}']) {
    writeFileSync(path, content);
    assert.deepEqual(loadConfig(path), { capacity: JSON.parse(content).capacity ?? 20, diagnostics: [] });
  }
  for (const content of ['broken', 'null', '[]', '{"capacity":0}', '{"capacity":-1}', '{"capacity":1.5}', '{"capacity":"5"}', '{"capacity":9007199254740992}']) {
    writeFileSync(path, content);
    const config = loadConfig(path);
    assert.equal(config.capacity, 20);
    assert.ok(config.diagnostics[0].includes(path));
  }
});

test('startup and reload load capacity; compact uses the loaded value; shrinking preserves overflow as pending', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-capacity-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent');
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
  });
  const { config } = storagePaths(process.env.PI_CODING_AGENT_DIR);
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, '{"capacity":3}');
  const root = join(cwd, 'skills', 'dynamic-skill', 'SKILL.md');
  const group = join(dirname(root), 'skills', 'group', 'SKILL.md');
  const paths = ['a', 'b', 'c'].map((name) => join(dirname(group), 'skills', name, 'SKILL.md'));
  for (const path of [root, group, ...paths]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${dirname(path).split('/').at(-1)}\ndescription: Test\n---\n`);
  }
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths, pendingEviction: [] });
  const hooks = new Map();
  let command;
  const notices = [];
  extension({ on: (name, handler) => hooks.set(name, handler), registerCommand: (_name, handler) => { command = handler; },
    getCommands: () => [{ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path: root } }],
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    sendMessage: (m) => manager.appendCustomMessageEntry(m.customType, m.content, m.display, m.details) });
  const ctx = { cwd, sessionManager: manager, hasUI: true, ui: { notify: (text, type) => notices.push({ text, type }) } };
  await hooks.get('resources_discover')({ reason: 'startup' }, ctx);
  await command.handler('', ctx);
  assert.match(notices.at(-1).text, /Active: 3 \/ 3/);
  assert.match(notices.at(-1).text, /Root directories/);
  assert.ok(notices.at(-1).text.includes(dirname(root)));
  assert.doesNotMatch(notices.at(-1).text, /Root Skills/);
  assert.ok(!notices.at(-1).text.includes(group), 'the status command does not duplicate the root child index');
  assert.match(hooks.get('before_agent_start')({}, ctx).message.content, /### Active skills \(3\/3\)/);
  writeFileSync(config, '{"capacity":1}');
  hooks.get('session_compact')({}, ctx);
  assert.equal(latestAccessState(manager.getBranch()).state.active.length, 3);
  const boundary = manager.appendCustomEntry('compact-boundary', {});
  manager.appendCompaction('Summary', boundary, 1000);
  await hooks.get('resources_discover')({ reason: 'reload' }, ctx);
  assert.deepEqual(latestAccessState(manager.getEntries()).state.active, paths.slice(0, 1));
  assert.deepEqual(latestAccessState(manager.getEntries()).state.pendingEviction, paths.slice(1));
  await command.handler('', ctx);
  assert.match(notices.at(-1).text, /Active: 1 \/ 1/);
  assert.match(manager.buildSessionContext().messages.findLast(m => m.customType === 'dynamic-skill:context').content, /### Active skills \(1\/1\)/);
  writeFileSync(config, 'broken');
  await hooks.get('resources_discover')({ reason: 'reload' }, ctx);
  assert.ok(notices.some((n) => n.type === 'warning' && n.text.includes('Using capacity 20')));
  await command.handler('', ctx);
  assert.match(notices.at(-1).text, /Active: 1 \/ 20/);
});
