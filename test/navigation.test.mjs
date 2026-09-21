import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { ACCESS_STATE } from '../dist/access.js';
import { skillDetails, visibleSkills } from '../dist/context.js';

test('real SDK tree and fork restore native loading facts without duplicating descriptions', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dynamic-navigation-'));
  const agentDir = join(cwd, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  const errors = [];
  const factory = async options => {
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: { additionalExtensionPaths: [resolve('src/index.ts')], noContextFiles: true } });
    const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  t.after(() => runtime.dispose());
  const bind = session => session.bindExtensions({ onError: error => errors.push(error) });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  const path = join(cwd, 'dynamic-skill', 'skills', 'dynamic-skill', 'skills', 'example', 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '---\nname: example\ndescription: Navigation skill\n---\n');
  const manager = runtime.session.sessionManager;
  const empty = manager.appendCustomEntry('test:empty', {});
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [path], pendingEviction: [] });
  const start = await runtime.session.extensionRunner.emitBeforeAgentStart('test', undefined, '');
  await runtime.session.sendCustomMessage(start.messages[0]);
  const loaded = manager.appendCustomEntry('test:loaded', {});
  assert.deepEqual([...visibleSkills(runtime.session.messages)], [path]);
  await runtime.session.navigateTree(empty);
  assert.equal(visibleSkills(runtime.session.messages).size, 0);
  await runtime.session.navigateTree(loaded);
  assert.deepEqual([...visibleSkills(runtime.session.messages)], [path]);
  assert.equal(runtime.session.messages.filter(skillDetails).length, 1);
  const originalId = runtime.session.messages.find(skillDetails).details.id;
  const fork = await runtime.fork(loaded, { position: 'at' });
  assert.equal(fork.cancelled, false);
  assert.deepEqual([...visibleSkills(runtime.session.messages)], [path]);
  assert.equal(runtime.session.messages.find(skillDetails).details.id, originalId);
  const next = await runtime.session.extensionRunner.emitBeforeAgentStart('continue', undefined, '');
  assert.equal(next?.messages?.length ?? 0, 0);
  assert.deepEqual(errors, []);
});
