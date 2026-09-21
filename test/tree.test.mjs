import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { readChildren, readSkillTrees, isManagedSkill } from '../dist/tree.js';
import extension from '../dist/index.js';
import { DISCOVERY_DETAILS } from '../dist/runtime.js';

const skill = (name, body = '') => `---\nname: ${name}\ndescription: ${name} instructions\n---\n${body}`;
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-tree-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'dynamic-skill', 'SKILL.md');
  const child = (name) => join(dirname(root), 'skills', name, 'SKILL.md');
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  write(root, skill('dynamic-skill', 'Authored text.\n<!-- dynamic-skill:children:start -->\nOld index left untouched.'));
  return { cwd, root, child, write };
}

test('one-level discovery and recursive browsing share validation and never write files', t => {
  const f = fixture(t);
  f.write(f.child('b'), skill('b'));
  f.write(f.child('a'), skill('a', 'Private body'));
  const nested = join(dirname(f.child('a')), 'skills', 'nested', 'SKILL.md');
  f.write(nested, skill('nested'));
  const before = [f.root, f.child('a')].map(path => [readFileSync(path, 'utf8'), statSync(path).mtimeMs]);
  assert.deepEqual(readChildren([f.root], f.root).roots.map(n => n.name), ['a', 'b']);
  assert.equal(readChildren([f.root], f.root).roots[0].children.length, 0);
  const tree = readSkillTrees([f.root, f.root]);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].children[0].children[0].name, 'nested');
  assert.deepEqual(tree.diagnostics, []);
  assert.equal(JSON.stringify(tree).includes('Private body'), false);
  assert.deepEqual([f.root, f.child('a')].map(path => [readFileSync(path, 'utf8'), statSync(path).mtimeMs]), before);
});

test('invalid ancestors, directories and symlinks cannot enter any queue or discovery', t => {
  const f = fixture(t);
  f.write(f.child('valid'), skill('valid'));
  f.write(f.child('invalid'), skill('wrong'));
  const orphan = join(dirname(f.child('missing')), 'skills', 'nested', 'SKILL.md');
  f.write(orphan, skill('nested'));
  const outside = join(f.cwd, 'outside', 'SKILL.md');
  f.write(outside, skill('linked'));
  symlinkSync(dirname(outside), dirname(f.child('linked')));
  f.write(f.child('bad-slug_'), skill('bad-slug_'));
  f.write(f.child('.hidden'), skill('hidden'));
  const children = readChildren([f.root], f.root);
  assert.deepEqual(children.roots.map(n => n.name), ['valid']);
  for (const name of ['invalid', 'missing', 'linked', 'bad-slug_']) assert.ok(children.diagnostics.some(d => d.includes(name)));
  for (const path of [orphan, outside, f.child('linked'), f.child('.hidden')]) assert.equal(isManagedSkill([f.root], path), false);
  assert.equal(isManagedSkill([f.root], f.child('valid')), true);
  assert.equal(readFileSync(outside, 'utf8'), skill('linked'));
});

test('same names in distinct roots keep distinct identities; overlapping roots are valid', t => {
  const f = fixture(t);
  const other = join(f.cwd, 'other', 'dynamic-skill', 'SKILL.md');
  const overlapping = f.child('dynamic-skill');
  f.write(other, skill('dynamic-skill'));
  f.write(overlapping, skill('dynamic-skill'));
  for (const root of [f.root, other, overlapping]) f.write(join(dirname(root), 'skills', 'example', 'SKILL.md'), skill('example'));
  const roots = [f.root, other, overlapping];
  const paths = roots.map(root => readChildren(roots, root).roots.find(node => node.name === 'example').filePath);
  assert.equal(new Set(paths).size, 3);
  assert.ok(paths.every(path => isManagedSkill(roots, path)));
  assert.deepEqual(readSkillTrees(roots).diagnostics, []);
});

test('only successful managed reads attach a snapshot; native content/details are preserved', t => {
  const f = fixture(t);
  f.write(f.child('a'), skill('a'));
  const hooks = new Map();
  extension({ registerCommand() {}, on: (name, handler) => hooks.set(name, handler),
    getCommands: () => [{ source: 'skill', name: 'skill:dynamic-skill', sourceInfo: { path: f.root } }] });
  const ctx = { cwd: f.cwd, hasUI: false };
  const content = [{ type: 'text', text: 'Native read' }, { type: 'image', data: 'abc', mimeType: 'image/png' }];
  const details = { truncation: { truncated: true }, other: 'preserved' };
  const event = { toolName: 'read', input: { path: f.root }, isError: false, content, details };
  const result = hooks.get('tool_result')(event, ctx);
  assert.equal(result.content, undefined, 'do not change the native renderer payload');
  assert.deepEqual(result.details.truncation, details.truncation);
  assert.equal(result.details.other, 'preserved');
  assert.deepEqual(result.details[DISCOVERY_DETAILS].children.map(n => n.filePath), [f.child('a')]);
  assert.deepEqual(event.details, details);
  for (const toolName of ['write', 'edit']) assert.equal(hooks.get('tool_result')({ ...event, toolName }, ctx), undefined);
  assert.equal(hooks.get('tool_result')({ ...event, isError: true }, ctx), undefined);
  assert.equal(hooks.get('tool_result')({ ...event, input: { path: join(f.cwd, 'outside') } }, ctx), undefined);
});
