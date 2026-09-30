import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { ACCESS_STATE } from '../dist/access.js';
import { skillDetails, visibleSkills } from '../dist/context.js';

for (const persisted of [false, true]) test(`real SDK tree and fork reconcile continuous queues (${persisted ? 'file-backed old-point fork' : 'in-memory retained fork'})`, async t => {
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
  const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: persisted ? SessionManager.create(cwd, cwd) : SessionManager.inMemory(cwd) });
  t.after(() => runtime.dispose());
  const bind = session => session.bindExtensions({ onError: error => errors.push(error) });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  const path = join(cwd, 'dynamic-skill', 'skills', 'dynamic-skill', 'skills', 'example', 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '---\nname: example\ndescription: Navigation skill\n---\n');
  const manager = runtime.session.sessionManager;
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Initial response' }],
    api: 'anthropic-messages', provider: 'anthropic', model: 'test', stopReason: 'stop', timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const empty = manager.appendCustomEntry('test:empty', {});
  manager.appendCustomEntry(ACCESS_STATE, { version: 1, active: [path], pendingEviction: [] });
  const request = () => runtime.session.extensionRunner.emitContext(runtime.session.sessionManager.buildSessionContext().messages);
  assert.deepEqual([...visibleSkills(await request())], [path]);
  const loaded = manager.appendCustomEntry('test:loaded', {});
  await runtime.session.navigateTree(empty);
  assert.deepEqual([...visibleSkills(await request())], [path], 'tree navigation fills the missing description without rolling back the queue');
  await runtime.session.navigateTree(loaded);
  const projected = await request();
  assert.deepEqual([...visibleSkills(projected)], [path]);
  assert.equal(projected.filter(skillDetails).length, 1);
  const originalId = projected.find(skillDetails).details.id;
  const fork = await runtime.fork(persisted ? empty : loaded, { position: 'at' });
  assert.equal(fork.cancelled, false);
  const forkMessages = await request();
  assert.deepEqual([...visibleSkills(forkMessages)], [path]);
  if (!persisted) assert.equal(forkMessages.find(skillDetails).details.id, originalId);
  else assert.notEqual(forkMessages.find(skillDetails).details.id, originalId, 'old-point fork inherits current queue and fills absent description');
  assert.deepEqual(await request(), forkMessages);
  assert.deepEqual(errors, []);
});
