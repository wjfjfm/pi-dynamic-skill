import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueFixture } from './queue-fixture.mjs';
import { createSkillContextRuntime, DESCRIPTION_BLOCK } from '../dist/runtime.js';
import { visibleSkills } from '../dist/context.js';

test('one surviving duplicate cannot impersonate the original raw source', t => {
  const f = queueFixture(t, 1, 1);
  f.record(f.root);
  const identical = { role: 'user', content: 'same source text', timestamp: 5 };
  const source = f.manager.appendMessage(identical);
  const first = f.runtime.project(f.ctx, [identical]);
  assert.ok(visibleSkills(first).has(f.paths[0]));
  const block = f.manager.getEntries().find(entry => entry.customType === DESCRIPTION_BLOCK);
  assert.equal(block.data.source, source);
  f.manager.appendMessage(structuredClone(identical));
  const folded = f.runtime.project(f.ctx, [identical]);
  assert.ok(!visibleSkills(folded).has(f.paths[0]));
  assert.deepEqual(f.runtime.state(f.ctx).discovery, []);
});

for (const mode of ['empty', 'ambiguous']) for (const resume of [false, true]) {
  test(`unanchored delivery does not resurrect discovery (${mode}, resume=${resume})`, t => {
    const f = queueFixture(t, 2, 2);
    f.seed([f.paths[1]]);
    f.record(f.root);
    const duplicate = { role: 'user', content: 'same', timestamp: 1 };
    const input = mode === 'empty' ? [] : [duplicate, structuredClone(duplicate)];
    const first = f.runtime.project(f.ctx, input);
    assert.ok(visibleSkills(first).has(f.paths[0]));
    assert.ok(visibleSkills(first).has(f.paths[1]));
    const blocks = f.manager.getEntries().filter(entry => entry.customType === DESCRIPTION_BLOCK);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].data.anchor, null);
    let runtime = f.runtime;
    if (resume) {
      runtime = createSkillContextRuntime(f.pi, f.options);
      runtime.start(f.ctx, 'resume');
    }
    // If a caller actually retains the description, it remains visible unchanged.
    assert.deepEqual(runtime.project(f.ctx, first), first);
    const replacement = { role: 'user', content: 'after fold', timestamp: 2 };
    const folded = runtime.project(f.ctx, [replacement]);
    assert.ok(!visibleSkills(folded).has(f.paths[0]), 'old read must not rediscover a delivered child');
    assert.ok(visibleSkills(folded).has(f.paths[1]), 'active intent survives losing descriptions');
    assert.deepEqual(runtime.state(f.ctx).discovery, []);
    assert.deepEqual(runtime.project(f.ctx, [replacement]), folded);
    f.record(f.root);
    const rediscovered = runtime.project(f.ctx, [replacement]);
    assert.ok(visibleSkills(rediscovered).has(f.paths[0]), 'a new successful read can discover it again');
  });
}
