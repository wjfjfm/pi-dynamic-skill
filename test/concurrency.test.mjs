import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { synchronizeTrees } from '../dist/tree.js';

const skill = (name, body = '') => `---\nname: ${name}\ndescription: ${name} instructions\n---\n${body}`;

for (const persistent of [false, true]) {
  test(persistent ? 'repeated conflicts preserve concurrent edits and report failure' : 'a conflicting edit rebases navigation and rescans children', (t) => {
    const cwd = fs.mkdtempSync(join(tmpdir(), 'dynamic-conflict-'));
    const directory = join(cwd, 'dynamic-skill');
    const root = join(directory, 'SKILL.md');
    const write = fs.writeFileSync;
    fs.mkdirSync(join(directory, 'skills', 'first'), { recursive: true });
    write(root, skill('dynamic-skill', 'Original body.\n'));
    write(join(directory, 'skills', 'first', 'SKILL.md'), skill('first'));
    let conflicts = 0;
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      fs.rmSync(cwd, { recursive: true, force: true });
    });
    // Inject another writer after a patch is prepared, before it is applied.
    t.mock.method(fs, 'writeFileSync', (path, ...args) => {
      const result = write(path, ...args);
      if (String(path).endsWith('.tmp') && (persistent || conflicts === 0)) {
        conflicts++;
        write(root, skill('dynamic-skill', `Concurrent body ${conflicts}.\n`));
        fs.mkdirSync(join(directory, 'skills', 'second'), { recursive: true });
        write(join(directory, 'skills', 'second', 'SKILL.md'), skill('second'));
      }
      return result;
    });
    syncBuiltinESMExports();
    const result = synchronizeTrees([root]);
    const content = fs.readFileSync(root, 'utf8');
    assert.match(content, new RegExp(`Concurrent body ${conflicts}\\.`));
    assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
    if (persistent) {
      assert.equal(conflicts, 3);
      assert.match(result.diagnostics.join('\n'), /kept changing/);
      assert.equal(content, skill('dynamic-skill', 'Concurrent body 3.\n'));
    } else {
      assert.equal(conflicts, 1);
      assert.deepEqual(result.diagnostics, []);
      assert.match(content, /\.\/skills\/first\/SKILL.md/);
      assert.match(content, /\.\/skills\/second\/SKILL.md/);
    }
  });
}
