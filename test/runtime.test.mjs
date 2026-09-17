import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';

test('real Pi runtime creates the template root and expands its authored content without adding tools', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'dynamic-runtime-'));
  const agentDir = join(cwd, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    additionalExtensionPaths: [resolve('src/index.ts')], noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
  t.after(() => session.dispose());
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const root = join(agentDir, 'skills', 'dynamic-skill', 'SKILL.md');
  const source = await readFile(root, 'utf8');
  assert.equal(source, await readFile('templates/dynamic-skill/SKILL.md', 'utf8'));
  const skills = loader.getSkills().skills;
  assert.equal(skills.filter((skill) => skill.name === 'dynamic-skill').length, 1);
  assert.equal(skills.find((skill) => skill.name === 'dynamic-skill').filePath, root);
  assert.deepEqual([...loader.getExtensions().extensions[0].tools], []);
  await writeFile(root, source + '\nPersistent authored root body.\n');
  await session.extensionRunner.emitBeforeAgentStart('test', undefined, '', { cwd, skills });
  const original = [{ role: 'user', content: 'Task', timestamp: 0 }];
  const messages = await session.extensionRunner.emitContext(original);
  assert.equal(messages[0].customType, 'dynamic-skill:context');
  assert.match(messages[0].content, /## Dynamic skills/);
  assert.match(messages[0].content, /Persistent authored root body/);
  assert.equal(messages[0].content.split("Dynamic skills preserve reusable knowledge").length - 1, 1);
  assert.deepEqual(messages.slice(1), original);
  const catalog = formatSkillsForPrompt(skills);
  assert.match(catalog, /<name>dynamic-skill<\/name>/);
  assert.ok(catalog.includes(root));
  assert.doesNotMatch(catalog, /Persistent authored root body/);
  assert.equal(session.messages.length, 0, 'context projection must not append durable history');
  assert.deepEqual(errors, []);
});
