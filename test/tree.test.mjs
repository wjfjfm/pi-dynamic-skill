import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { loadSkillsFromDir, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import extension from '../dist/index.js';
import { synchronizeTrees, isManagedSkill, START, END } from '../dist/tree.js';

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
  const pi = { registerCommand: () => {}, on: (name, handler) => hooks.set(name, handler), getCommands: () => commands,
    appendEntry: () => {}, registerTool: () => assert.fail('Extension must be tool free') };
  extension(pi);
  const ctx = { cwd: f.cwd, hasUI: true, sessionManager: { getBranch: () => [] }, ui: { notify: (...args) => warnings.push(args) } };
  await hooks.get('resources_discover')({ reason: 'startup' }, ctx);
  assert.deepEqual([...hooks.keys()].sort(), ['context', 'resources_discover', 'session_compact', 'tool_result']);
  const native = { read: createReadToolDefinition(f.cwd), write: createWriteToolDefinition(f.cwd), edit: createEditToolDefinition(f.cwd) };
  let sequence = 0;
  const call = async (toolName, input) => {
    const toolCallId = String(sequence++);
    const result = await native[toolName].execute(toolCallId, input, undefined, undefined, ctx);
    const event = { toolName, input, toolCallId, isError: false, ...result };
    const modified = await hooks.get('tool_result')(event, ctx);
    return { ...event, ...modified };
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

test('successful write/edit refresh node and parent; invalid writes stay successful with diagnostics', async (t) => {
  const h = await harness(t);
  const created = await h.call('write', { path: h.child('testing'), content: skill('testing', 'First description') });
  assert.equal(created.isError, false);
  assert.match(await readFile(h.root, 'utf8'), /First description/);
  await h.call('edit', { path: h.child('testing'), edits: [{ oldText: 'First description', newText: 'Updated description' }] });
  assert.match(await readFile(h.root, 'utf8'), /Updated description/);
  const invalid = await h.call('write', { path: h.child('testing'), content: '---\nname: testing\n---\nAuthor body' });
  assert.equal(invalid.isError, false);
  assert.match(invalid.content[0].text, /Successfully wrote/);
  assert.match(invalid.content.at(-1).text, /\[dynamic-skill\].*succeeded/);
  assert.match(invalid.content.at(-1).text, /description/);
  assert.match(await readFile(h.child('testing'), 'utf8'), /Author body/);
  assert.doesNotMatch(await readFile(h.root, 'utf8'), /Child skills/);
  await h.call('write', { path: h.child('testing'), content: skill('testing', 'Repaired description') });
  assert.match(await readFile(h.root, 'utf8'), /Repaired description/);
  // Generated text is not protected: successful edits are simply regenerated.
  const edited = await h.call('edit', { path: h.root, edits: [{ oldText: 'Repaired description', newText: 'manual index edit' }] });
  assert.equal(edited.isError, false);
  assert.match(await readFile(h.root, 'utf8'), /Repaired description/);
  assert.doesNotMatch(await readFile(h.root, 'utf8'), /manual index edit/);
  const malformed = await h.call('write', { path: h.root, content: skill('dynamic-skill', 'Root', `${START}\nBroken block`) });
  assert.equal(malformed.isError, false);
  assert.match(malformed.content.at(-1).text, /Malformed/);
  assert.match(await readFile(h.root, 'utf8'), /Broken block/);
});

test('only successful writes/edits to managed skill files trigger maintenance', async (t) => {
  const h = await harness(t);
  await h.write(h.child('testing'), skill('testing'));
  const before = await readFile(h.root, 'utf8');
  const event = { toolName: 'write', input: { path: h.child('testing') }, toolCallId: 'id', isError: true, content: [{ type: 'text', text: 'Failure' }] };
  assert.equal(h.hooks.get('tool_result')(event, h.ctx), undefined);
  await h.call('read', { path: h.root });
  await h.call('write', { path: join(h.cwd, 'outside', 'SKILL.md'), content: 'not YAML' });
  await h.call('write', { path: join(h.cwd, 'dynamic-skill', 'notes.txt'), content: 'supporting file' });
  assert.equal(await readFile(h.root, 'utf8'), before);
  const wrongPath = join(h.cwd, 'dynamic-skill', 'wrong', 'SKILL.md');
  const invalid = await h.call('write', { path: wrongPath, content: skill('wrong') });
  assert.equal(invalid.isError, false);
  assert.match(invalid.content.at(-1).text, /skills\/<name>\/SKILL.md/);
  assert.equal(await readFile(wrongPath, 'utf8'), skill('wrong'));
});

test('refresh is local and preserves tool result blocks and details', async (t) => {
  const h = await harness(t);
  await h.call('write', { path: h.child('development'), content: skill('development') });
  await h.call('write', { path: h.child('research'), content: skill('research') });
  const research = await readFile(h.child('research'), 'utf8');
  const researchTime = (await stat(h.child('research'))).mtimeMs;
  const nested = join(h.child('development'), '..', 'skills', 'testing', 'SKILL.md');
  await h.call('write', { path: nested, content: skill('testing', 'Nested tests') });
  assert.match(await readFile(h.child('development'), 'utf8'), /Nested tests/);
  assert.doesNotMatch(await readFile(h.root, 'utf8'), /Nested tests/);
  assert.equal(await readFile(h.child('research'), 'utf8'), research);
  assert.equal((await stat(h.child('research'))).mtimeMs, researchTime);
  await writeFile(nested, '---\nname: testing\n---\n');
  const content = [{ type: 'text', text: 'Original result' }, { type: 'image', data: 'abc', mimeType: 'image/png' }];
  const event = { toolName: 'edit', input: { path: nested }, isError: false, content, details: { diff: 'retained' } };
  const result = h.hooks.get('tool_result')(event, h.ctx);
  assert.deepEqual(result.content.slice(0, 2), content);
  assert.equal(content.length, 2);
  assert.equal(result.isError, undefined);
  assert.equal(result.details, undefined);
  assert.deepEqual(event.details, { diff: 'retained' });
  assert.doesNotMatch(await readFile(h.child('development'), 'utf8'), /Nested tests/);
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
  assert.ok(result.diagnostics.some((message) => message.includes('missing')));
  assert.ok(result.diagnostics.some((message) => message.includes('invalid')));
  assert.ok(result.diagnostics.some((message) => message.includes('linked')));
  assert.equal(await readFile(outside, 'utf8'), skill('linked'));
  const malformed = skill('dynamic-skill', 'Root', `${START}\nUnclosed`);
  await writeFile(f.root, malformed);
  assert.equal(synchronizeTrees([f.root]).roots.length, 0);
  assert.equal(await readFile(f.root, 'utf8'), malformed);
});

test('local refresh, full scan, and access eligibility agree on invalid child directories', async (t) => {
  const h = await harness(t);
  for (const kind of ['file', 'symlink', 'dangling-symlink']) {
    const path = h.child(kind);
    await h.call('write', { path, content: skill(kind) });
    const directory = join(path, '..', 'skills');
    if (kind === 'file') await writeFile(directory, 'not a directory');
    else await symlink(kind === 'symlink' ? h.cwd : join(h.cwd, 'missing'), directory);
    const result = await h.call('edit', { path, edits: [{ oldText: `${kind} instructions`, newText: 'Updated description' }] });
    assert.equal(result.isError, false);
    assert.match(result.content.at(-1).text, /skills must be a real directory/);
    assert.equal(isManagedSkill([h.root], path), false);
    const local = await readFile(h.root, 'utf8');
    assert.equal(local.includes(`./skills/${kind}/SKILL.md`), false);
    assert.ok(synchronizeTrees([h.root]).diagnostics.some((line) => line.includes(path) && line.includes('skills must be a real directory')));
    assert.equal(await readFile(h.root, 'utf8'), local);
    await rm(directory);
    await h.call('write', { path, content: skill(kind) });
    assert.equal(isManagedSkill([h.root], path), true);
    assert.ok((await readFile(h.root, 'utf8')).includes(`./skills/${kind}/SKILL.md`));
  }
});

test('every SKILL.md inside the root is checked, even in hidden or misplaced directories', async (t) => {
  const h = await harness(t);
  const misplaced = join(h.cwd, 'dynamic-skill', 'references', 'deep', 'SKILL.md');
  const result = await h.call('write', { path: misplaced, content: skill('wrong') });
  assert.equal(result.isError, false);
  assert.match(result.content.at(-1).text, /skills\/<name>\/SKILL.md/);
  assert.match(result.content.at(-1).text, /name must match its node name: deep/);
  const hidden = join(h.cwd, 'dynamic-skill', '.hidden', 'nested', 'SKILL.md');
  await h.write(hidden, 'Not a skill');
  const orphan = join(h.child('missing'), '..', 'skills', 'orphan', 'SKILL.md');
  await h.write(orphan, skill('incorrect'));
  const diagnostics = synchronizeTrees([h.root]).diagnostics.join('\n');
  assert.ok(diagnostics.includes(misplaced));
  assert.ok(diagnostics.includes(hidden));
  assert.ok(diagnostics.includes(orphan));
  assert.match(diagnostics, /YAML frontmatter/);
  assert.match(diagnostics, /name must match its node name: orphan/);
  assert.equal(await readFile(hidden, 'utf8'), 'Not a skill');
  const outside = await h.call('write', { path: join(h.cwd, 'outside', 'SKILL.md'), content: 'Not a skill' });
  assert.equal(outside.content.length, 1);
});

test('startup warns about invalid skills, silently repairs navigation, and keeps running', async (t) => {
  const h = await harness(t);
  await h.write(h.child('valid'), skill('valid', 'Current description'));
  await h.write(h.child('invalid'), '---\nname: invalid\n---\nAuthor text');
  await writeFile(h.root, skill('dynamic-skill', 'Root', `${START}\nOutdated navigation\n${END}\nKeep this text.`));
  const discover = h.hooks.get('resources_discover');
  await assert.doesNotReject(discover({ reason: 'startup' }, h.ctx));
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0][1], 'warning');
  assert.match(h.warnings[0][0], /\[dynamic-skill\] Skill warnings/);
  assert.match(h.warnings[0][0], /invalid\/SKILL.md.*description/);
  assert.doesNotMatch(h.warnings[0][0], /Outdated navigation|Current description/);
  const text = await readFile(h.root, 'utf8');
  assert.match(text, /Current description/);
  assert.match(text, /Keep this text/);
  assert.doesNotMatch(text, /Outdated navigation/);
  await h.write(h.child('invalid'), skill('invalid'));
  h.warnings.length = 0;
  await discover({ reason: 'reload' }, h.ctx);
  assert.deepEqual(h.warnings, []);
  // Even an unexpected discovery failure is a warning, not an extension error.
  Object.defineProperty(h.commands[0], 'source', { get() { throw new Error('Discovery unavailable'); } });
  await assert.doesNotReject(discover({ reason: 'startup' }, h.ctx));
  assert.match(h.warnings[0][0], /Discovery unavailable/);
});
