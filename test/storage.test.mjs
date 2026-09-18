import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initializeStorage, storagePaths } from '../dist/storage.js';

test('storage uses a sibling directory and creates templates without overwriting authored files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, 'agent');
  const paths = storagePaths(agentDir);
  assert.equal(paths.directory, join(directory, 'dynamic-skill'));
  await Promise.all([initializeStorage(agentDir), initializeStorage(agentDir)]);
  assert.equal(await readFile(paths.root, 'utf8'), await readFile('templates/dynamic-skill/SKILL.md', 'utf8'));
  assert.equal(await readFile(paths.config, 'utf8'), await readFile('templates/dynamic-skill.json', 'utf8'));
  await writeFile(paths.root, 'Authored root');
  await writeFile(paths.config, '{"capacity":7}');
  await initializeStorage(agentDir);
  assert.equal(await readFile(paths.root, 'utf8'), 'Authored root');
  assert.equal(await readFile(paths.config, 'utf8'), '{"capacity":7}');
  await rm(paths.config);
  await initializeStorage(agentDir);
  assert.equal(await readFile(paths.root, 'utf8'), 'Authored root');
  assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')), { capacity: 20 });
});

test('initialization failures are reported rather than destroying conflicting files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-storage-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, 'agent');
  const paths = storagePaths(agentDir);
  await writeFile(paths.directory, 'Not a directory');
  await assert.rejects(initializeStorage(agentDir));
  assert.equal(await readFile(paths.directory, 'utf8'), 'Not a directory');
});
