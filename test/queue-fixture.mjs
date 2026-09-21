import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createSkillContextRuntime, DISCOVERY_DETAILS } from '../dist/runtime.js';
import { readChildren } from '../dist/tree.js';
import { ACCESS_STATE, latestAccessState } from '../dist/access.js';

export function queueFixture(t, count = 4, capacity = 2) {
  const cwd = mkdtempSync(join(tmpdir(), 'dynamic-queues-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'dynamic-skill', 'SKILL.md');
  const paths = Array.from({ length: count }, (_, i) => join(dirname(root), 'skills', `skill-${i}`, 'SKILL.md'));
  for (const path of [root, ...paths]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${dirname(path).split('/').at(-1)}\ndescription: Description ${path}\n---\nPRIVATE BODY\n`);
  }
  const manager = SessionManager.inMemory(cwd);
  const ctx = { cwd, sessionManager: manager };
  const pi = {
    appendEntry: (type, data) => manager.appendCustomEntry(type, structuredClone(data)),
    sendMessage: m => manager.appendCustomMessageEntry(m.customType, m.content, m.display, structuredClone(m.details)),
  };
  const options = { roots: () => [root], capacity: () => capacity, resolvePath: p => p };
  const runtime = createSkillContextRuntime(pi, options);
  let sequence = 0;
  const record = (path, name = 'read', isError = false, snapshot = true) => {
    const id = String(sequence++);
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path } }], timestamp: 1 });
    return manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, isError, content: [], timestamp: 2,
      details: snapshot && name === 'read' ? { [DISCOVERY_DETAILS]: { parent: path, children: readChildren([root], path).roots } } : {} });
  };
  const state = () => latestAccessState(manager.getEntries())?.state;
  const seed = (active, pendingEviction = [], extra = {}) => manager.appendCustomEntry(ACCESS_STATE, { version: 1, active, pendingEviction, ...extra });
  return { cwd, root, paths, manager, ctx, pi, options, runtime, record, state, seed };
}
