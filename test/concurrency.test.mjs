import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { readChildren } from '../dist/tree.js';

test('a child removed during discovery is diagnosed without writing or retrying authored files', t => {
  const cwd = fs.mkdtempSync(join(tmpdir(), 'dynamic-race-'));
  const directory = join(cwd, 'dynamic-skill');
  const root = join(directory, 'SKILL.md');
  const child = join(directory, 'skills', 'child', 'SKILL.md');
  const skill = name => `---\nname: ${name}\ndescription: Test\n---\n`;
  fs.mkdirSync(join(child, '..'), { recursive: true });
  fs.writeFileSync(root, skill('dynamic-skill'));
  fs.writeFileSync(child, skill('child'));
  const readdir = fs.readdirSync;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(cwd, { recursive: true, force: true }); });
  t.mock.method(fs, 'readdirSync', (path, ...args) => {
    const result = readdir(path, ...args);
    if (String(path) === join(directory, 'skills')) fs.unlinkSync(child);
    return result;
  });
  t.mock.method(fs, 'writeFileSync', () => assert.fail('discovery must not write'));
  t.mock.method(fs, 'renameSync', () => assert.fail('discovery must not replace files'));
  syncBuiltinESMExports();
  const result = readChildren([root], root);
  assert.deepEqual(result.roots, []);
  assert.match(result.diagnostics.join('\n'), /child.*ENOENT/);
  assert.equal(fs.readFileSync(root, 'utf8'), skill('dynamic-skill'));
});
