import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Key, matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { SkillSelector, skillRows } from '../dist/selector.js';
const theme = { fg: (_color, text) => text };
const keys = { matches: (data, action) => matchesKey(data, ({ 'tui.select.cancel': Key.escape, 'tui.select.confirm': Key.enter, 'tui.select.up': Key.up, 'tui.select.down': Key.down })[action]) };
const rows = [
  { path: '/root', name: 'dynamic-skill', description: '', depth: 0, root: true },
  ...['a', 'b', 'c'].map((name, i) => ({ path: `/${name}`, name, description: `${name} 中文说明`, depth: i + 1, root: false })),
];
test('selector defaults to ordered Queues, tabs to hierarchical All, toggles draft, applies explicitly', () => {
  let result;
  const selector = new SkillSelector(rows, ['/b', '/a'], theme, keys, (value) => { result = value; }, () => {});
  assert.match(selector.render(100).join('\n'), /\[Queues\]  All/);
  assert.match(selector.render(100).join('\n'), /1\. \[x\] b/);
  selector.handleInput(' '); // remove b
  assert.equal(result, undefined);
  selector.handleInput('\t');
  assert.match(selector.render(100).join('\n'), /Queues  \[All\]/);
  selector.handleInput(' '); // root not selectable
  selector.handleInput('c'); // search
  // Search also matches dynamic-skill. Move to c.
  selector.handleInput('\u001b[B');
  selector.handleInput(' ');
  selector.handleInput('\r');
  assert.deepEqual(result, ['/a', '/c']);
});
test('three queues share a draft; pending and discovery start unchecked', () => {
  let result;
  const selector = new SkillSelector(rows, ['/a'], theme, keys, value => { result = value; }, () => {}, () => 24,
    { pendingEviction: ['/b'], discovery: [{ path: '/c', source: 'read' }] });
  const rendered = selector.render(120).join('\n');
  assert.match(rendered, /active 1\. \[x\] a/);
  assert.match(rendered, /pending 2\. \[ \] b/);
  assert.match(rendered, /discovery 3\. \[ \] c/);
  selector.handleInput('\u001b[B'); selector.handleInput(' ');
  selector.handleInput('\u001b[B'); selector.handleInput(' ');
  selector.handleInput('\r');
  assert.deepEqual(result, ['/a', '/b', '/c']);
});
test('overlapping registered roots remain unselectable and appear only once', () => {
  const nested = { filePath: '/root/skills/dynamic-skill/SKILL.md', name: 'dynamic-skill', description: '', children: [] };
  const root = { filePath: '/root/SKILL.md', name: 'dynamic-skill', description: '', children: [nested] };
  const result = skillRows([root, nested]);
  assert.equal(result.length, 2);
  assert.ok(result.every(row => row.root));
});
test('cancel discards draft; narrow rendering remains bounded and IME focus is forwarded', () => {
  let result = 'unset';
  const selector = new SkillSelector(rows, ['/a'], theme, keys, (value) => { result = value; }, () => {}, () => 12);
  selector.focused = true;
  assert.equal(selector.focused, true);
  selector.handleInput(' ');
  for (const line of selector.render(18)) assert.ok(visibleWidth(line) <= 18);
  selector.handleInput('\u001b');
  assert.equal(result, undefined);
});
