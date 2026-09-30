import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import { queueFixture } from './queue-fixture.mjs';
import { ACCESS_STATE } from '../dist/access.js';
import { createSkillContextRuntime, DESCRIPTION_BLOCK } from '../dist/runtime.js';
import { skillDetails } from '../dist/context.js';

// Fail before one individual append, not an invented transaction spanning all writes.
for (const stage of ['queue', 'description', 'projection', 'announcement']) {
  for (const resume of [false, true]) test(`pending grace survives interrupted ${stage} (${resume ? 'resume' : 'retry'})`, t => {
    const f = queueFixture(t, 3, 2);
    f.seed(f.paths.slice(0, 2), [f.paths[2]]);
    const access = f.record(f.paths[2]);
    let interrupted = false;
    const pi = { ...f.pi, appendEntry(type, data) {
      const match = stage === 'queue' ? type === ACCESS_STATE && !data.announced?.length
        : stage === 'description' ? type === DESCRIPTION_BLOCK
        : stage === 'projection' ? type === 'dynamic-skill:projection:v1'
        : type === ACCESS_STATE && data.announced?.includes(f.paths[1]);
      if (match && !interrupted) { interrupted = true; throw new Error(`interrupted ${stage}`); }
      return f.pi.appendEntry(type, data);
    } };
    let runtime = createSkillContextRuntime(pi, f.options);
    const request = () => runtime.project(f.ctx, f.manager.buildContextEntries().flatMap(sessionEntryToContextMessages));
    runtime.settle(f.ctx, false);
    assert.throws(request, new RegExp(`interrupted ${stage}`));
    if (resume) {
      runtime = createSkillContextRuntime(f.pi, f.options);
      runtime.start(f.ctx, 'resume');
    }
    const recovered = request();
    assert.deepEqual(f.state().active, [f.paths[0], f.paths[2]], 'access is promoted once, never replayed');
    assert.equal(f.state().cursor, access);
    assert.deepEqual(f.state().pendingEviction, [f.paths[1]]);
    assert.deepEqual(f.state().announced, [f.paths[1]]);
    assert.equal(recovered.filter(message => skillDetails(message)?.pendingPaths.includes(f.paths[1])).length, 1);
    assert.equal(f.manager.getEntries().filter(entry => entry.customType === DESCRIPTION_BLOCK).length, 1);
    const leaf = f.manager.getLeafId();
    assert.deepEqual(request(), recovered);
    assert.equal(f.manager.getLeafId(), leaf, 'retry adds neither queue revisions nor duplicate descriptions');
    f.manager.appendMessage({ role: 'user', content: 'Continue normally', timestamp: 3 });
    const ordinary = request();
    assert.deepEqual(f.state().pendingEviction, [f.paths[1]], 'ordinary continuation preserves grace');
    runtime.settle(f.ctx, false);
    assert.deepEqual(request(), ordinary, 'settlement does not rewrite already visible descriptions');
    assert.deepEqual(f.state().pendingEviction, [], 'only the later lifecycle cycle expires pending');
  });
}
