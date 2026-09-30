// Differential audit against an explicitly selected pre-refactor runtime.
// node scripts/audit-injection.mjs /absolute/path/to/baseline/dist/runtime.js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager, sessionEntryToContextMessages, convertToLlm } from '@earendil-works/pi-coding-agent';
import { queueFixture } from '../test/queue-fixture.mjs';
import { createSkillContextRuntime, DISCOVERY_DETAILS } from '../dist/runtime.js';
import { readChildren } from '../dist/tree.js';
import { MANUAL_SELECTION } from '../dist/access.js';

if (!process.argv[2]) throw new Error('Provide the baseline dist/runtime.js explicitly.');
const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
const cleanups = [];
try {
  const f = queueFixture({ after: fn => cleanups.push(fn) }, 3, 2);
  const oldManager = SessionManager.inMemory(f.cwd);
  const oldCtx = { ...f.ctx, sessionManager: oldManager };
  const oldPi = {
    appendEntry: (type, data) => oldManager.appendCustomEntry(type, structuredClone(data)),
    sendMessage: message => oldManager.appendCustomMessageEntry(message.customType, message.content, message.display, structuredClone(message.details)),
  };
  let oldRuntime = baseline.createSkillContextRuntime(oldPi, f.options);
  let runtime = f.runtime;
  const raw = manager => manager.buildContextEntries().flatMap(sessionEntryToContextMessages);
  // Timestamps and internal custom details are not instruction text. Compare
  // the actual public LLM conversion, retaining roles and content ordering.
  const llm = messages => convertToLlm(messages).map(({ timestamp, ...message }) => message);
  function compare(stage) {
    oldRuntime.reconcile(oldCtx);
    runtime.reconcile(f.ctx);
    const actual = runtime.project(f.ctx, raw(f.manager));
    assert.deepEqual(llm(actual), llm(raw(oldManager)), stage);
    console.log(`PASS ${stage}`);
  }
  function append(message) {
    for (const manager of [oldManager, f.manager]) manager.appendMessage(structuredClone(message));
  }
  let sequence = 0;
  function access(path, name) {
    const id = `call-${sequence++}`;
    append({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path } }], timestamp: sequence });
    append({ role: 'toolResult', toolCallId: id, toolName: name, isError: false,
      content: [{ type: 'text', text: `BODY ${id}` }], timestamp: sequence,
      details: name === 'read' ? { [DISCOVERY_DETAILS]: { parent: path, children: readChildren([f.root], path).roots } } : {} });
    compare(name + ' ' + id);
  }
  append({ role: 'user', content: 'Task', timestamp: 0 });
  compare('initial request');
  access(f.root, 'read');
  access(f.paths[0], 'read');
  access(f.paths[1], 'write');
  access(f.paths[1], 'edit');
  for (const manager of [oldManager, f.manager]) manager.appendCustomEntry(MANUAL_SELECTION, { add: [f.paths[2]], remove: [f.paths[0]] });
  compare('manual selection');
  append({ role: 'user', content: 'Continue', timestamp: 10 });
  compare('next user');
  oldRuntime.settle(oldCtx, false); runtime.settle(f.ctx, false);
  compare('reload settlement');
  for (const manager of [oldManager, f.manager]) {
    const boundary = manager.appendCustomEntry('audit-boundary', {});
    manager.appendCompaction('SUMMARY', boundary, 1000);
  }
  oldRuntime.compact(oldCtx); runtime.settle(f.ctx, true);
  compare('compact rebuild');
  oldRuntime = baseline.createSkillContextRuntime(oldPi, f.options);
  runtime = createSkillContextRuntime(f.pi, f.options);
  oldRuntime.start(oldCtx, 'resume'); runtime.start(f.ctx, 'resume');
  compare('runtime recreation');
} finally {
  for (const cleanup of cleanups.reverse()) cleanup();
}
