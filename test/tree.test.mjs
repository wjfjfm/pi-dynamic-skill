import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { loadSkillsFromDir, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, convertToLlm } from '@earendil-works/pi-coding-agent';
import extension from '../dist/index.js';
import { synchronizeTrees, START, END } from '../dist/tree.js';

const skill = (name, description = `${name} instructions`, body = '') => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dynamic-tree-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'dynamic-skill', 'SKILL.md');
  await mkdir(join(cwd, 'dynamic-skill'));
  await writeFile(root, skill('dynamic-skill', 'Root entry', 'My own instructions.\n'));
  const child = (name) => join(cwd, 'dynamic-skill', 'skills', name, 'SKILL.md');
  const write = async (path, text) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); };
  return { cwd, root, child, write };
}
async function harness(t) {
  const f = await fixture(t);
  const hooks = new Map();
  const warnings = [];
  const commands = [{ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path: f.root } }];
  const pi = { on: (name, handler) => hooks.set(name, handler), getCommands: () => commands,
    registerTool: () => assert.fail('Extension must be tool free') };
  extension(pi);
  const ctx = { cwd: f.cwd, ui: { notify: (...args) => warnings.push(args) } };
  await hooks.get('session_start')({ reason: 'startup' }, ctx);
  const native = { read: createReadToolDefinition(f.cwd), write: createWriteToolDefinition(f.cwd), edit: createEditToolDefinition(f.cwd) };
  let sequence = 0;
  const call = async (toolName, input) => {
    const toolCallId = String(sequence++);
    const before = await hooks.get('tool_call')({ toolName, input, toolCallId }, ctx);
    if (before?.block) return before;
    const result = await native[toolName].execute(toolCallId, input, undefined, undefined, ctx);
    await hooks.get('tool_result')({ toolName, input, toolCallId, isError: false, ...result }, ctx);
    return result;
  };
  return { ...f, hooks, ctx, call, warnings, commands };
}

test('tree navigation is direct-child only, stable, and preserves authored text', async (t) => {
  const f = await fixture(t);
  assert.equal(synchronizeTrees([f.root]).diagnostics.length, 0);
  await assert.rejects(stat(join(f.cwd, 'dynamic-skill', 'skills')), { code: 'ENOENT' });
  const nested = join(f.child('development'), '..', 'skills', 'testing', 'SKILL.md');
  await f.write(f.child('development'), skill('development', 'Development', 'Custom child body.'));
  await f.write(nested, skill('testing', 'Testing', 'Do not auto-load this body.'));
  const tree = synchronizeTrees([f.root]);
  assert.deepEqual(tree.diagnostics, []);
  const rootText = await readFile(f.root, 'utf8');
  assert.ok(rootText.startsWith(skill('dynamic-skill', 'Root entry', 'My own instructions.\n')));
  assert.match(rootText, /\.\/skills\/development\/SKILL.md/);
  assert.doesNotMatch(rootText, /testing/);
  assert.match(await readFile(f.child('development'), 'utf8'), /\.\/skills\/testing\/SKILL.md/);
  const mtime = (await stat(f.root)).mtimeMs;
  synchronizeTrees([f.root]);
  assert.equal((await stat(f.root)).mtimeMs, mtime);
  assert.equal(loadSkillsFromDir({ dir: join(f.cwd, 'dynamic-skill'), source: 'test' }).skills.length, 1);
  await rm(join(f.cwd, 'dynamic-skill', 'skills', 'development'), { recursive: true });
  synchronizeTrees([f.root]);
  assert.doesNotMatch(await readFile(f.root, 'utf8'), /Child skills/);
});

test('native write/edit/read update parent indexes without registering tools', async (t) => {
  const h = await harness(t);
  const created = await h.call('write', { path: h.child('testing'), content: skill('testing', 'First description') });
  assert.equal(created.block, undefined);
  assert.match(await readFile(h.root, 'utf8'), /First description/);
  await h.call('edit', { path: h.child('testing'), edits: [{ oldText: 'First description', newText: 'Updated description' }] });
  assert.match(await readFile(h.root, 'utf8'), /Updated description/);
  const rejected = await h.call('write', { path: h.child('testing'), content: skill('wrong-name') });
  assert.equal(rejected.block, true);
  assert.match(await readFile(h.child('testing'), 'utf8'), /Updated description/);
  assert.equal((await h.call('edit', { path: h.root, edits: [{ oldText: 'Updated description', newText: 'manual index edit' }] })).block, true);
  assert.equal((await h.call('write', { path: join(h.cwd, 'dynamic-skill', 'wrong', 'SKILL.md'), content: skill('wrong') })).block, true);
  await h.write(h.child('testing'), skill('testing', 'External update'));
  const result = await h.call('read', { path: h.root });
  assert.match(result.content.map((x) => x.text ?? '').join(''), /External update/);
  await writeFile(h.root, skill('dynamic-skill', 'Root', `${START}\nBroken block`));
  assert.equal((await h.call('write', { path: h.root, content: skill('dynamic-skill', 'Root', 'Repaired body') })).block, undefined);
  assert.match(await readFile(h.root, 'utf8'), /Repaired body/);
  assert.match(await readFile(h.root, 'utf8'), /External update/);
  // Unrelated files, including arbitrary SKILL.md files, remain ordinary files.
  assert.equal((await h.call('write', { path: join(h.cwd, 'unrelated', 'SKILL.md'), content: 'not YAML' })).block, undefined);
});

test('context auto-loads only root bodies and replaces its own projection', async (t) => {
  const h = await harness(t);
  await h.write(h.child('testing'), skill('testing', 'Child navigation', 'SECRET_CHILD_BODY'));
  const options = { skills: [{ name: 'dynamic-skill', filePath: h.root, disableModelInvocation: false }] };
  h.hooks.get('before_agent_start')({ systemPromptOptions: options }, h.ctx);
  const original = [{ role: 'user', content: 'Task', timestamp: 1 }];
  const first = h.hooks.get('context')({ messages: original }, h.ctx);
  assert.equal(original.length, 1);
  assert.equal(first.messages.length, 2);
  assert.match(first.messages[1].content, /My own instructions/);
  assert.match(first.messages[1].content, /Child navigation/);
  assert.doesNotMatch(first.messages[1].content, /SECRET_CHILD_BODY/);
  assert.equal(convertToLlm(first.messages).length, 2);
  await h.write(h.child('testing'), skill('testing', 'Fresh navigation'));
  const second = h.hooks.get('context')({ messages: first.messages }, h.ctx);
  assert.equal(second.messages.length, 2);
  assert.match(second.messages[1].content, /Fresh navigation/);
  assert.doesNotMatch(second.messages[1].content, /Child navigation/);
  h.hooks.get('before_agent_start')({ systemPromptOptions: { skills: [] } }, h.ctx);
  assert.deepEqual(h.hooks.get('context')({ messages: second.messages }, h.ctx).messages, original);
});

test('invalid, incomplete, and symlinked nodes are diagnosed without erasing authored files', async (t) => {
  const f = await fixture(t);
  await f.write(join(f.child('missing'), '..', 'skills', 'nested', 'SKILL.md'), skill('nested'));
  await f.write(f.child('invalid'), skill('other'));
  const outside = join(f.cwd, 'outside', 'SKILL.md');
  await f.write(outside, skill('linked'));
  await symlink(join(f.cwd, 'outside'), join(f.cwd, 'dynamic-skill', 'skills', 'linked'));
  const result = synchronizeTrees([f.root]);
  assert.equal(result.roots[0].children.length, 0);
  assert.equal(result.diagnostics.length, 3);
  assert.equal(await readFile(outside, 'utf8'), skill('linked'));
  const malformed = skill('dynamic-skill', 'Root', `${START}\nUnclosed`);
  await writeFile(f.root, malformed);
  assert.equal(synchronizeTrees([f.root]).roots.length, 0);
  assert.equal(await readFile(f.root, 'utf8'), malformed);
});

test('index writes wait while a native mutation of the parent is pending', async (t) => {
  const h = await harness(t);
  const input = { path: h.root, content: skill('dynamic-skill', 'Root entry', 'Replacement user body') };
  assert.equal(h.hooks.get('tool_call')({ toolName: 'write', toolCallId: 'pending', input }, h.ctx), undefined);
  const before = await readFile(h.root, 'utf8');
  await h.call('write', { path: h.child('testing'), content: skill('testing') });
  assert.equal(await readFile(h.root, 'utf8'), before);
  await createWriteToolDefinition(h.cwd).execute('pending', input, undefined, undefined, h.ctx);
  h.hooks.get('tool_result')({ toolName: 'write', toolCallId: 'pending', input, isError: false }, h.ctx);
  const after = await readFile(h.root, 'utf8');
  assert.match(after, /Replacement user body/);
  assert.match(after, /testing/);
  assert.ok(after.includes(END));
});
