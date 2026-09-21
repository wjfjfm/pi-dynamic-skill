// Real host event ordering, final tool-result overrides, and next-request payloads.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, test } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { getModel, streamSimple } from '@earendil-works/pi-ai/compat';
import { AgentSession, SessionManager, SettingsManager, convertToLlm, loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { AuthStorage } from 'native-core/auth-storage';
import { createModelRegistry, getModelRuntime } from 'native-test/model-runtime-test-utils';
import { createTestExtensionsResult, createTestResourceLoader } from 'native-test/utilities';
import dynamicSkill from '../src/index.ts';
import { ACCESS_STATE, latestAccessState } from '../src/access.ts';
import { DISCOVERY_DETAILS } from '../src/runtime.ts';
import { skillDetails } from '../src/context.ts';

for (const mode of ['sequential', 'parallel']) for (const override of ['none', 'error', 'details', 'terminate']) {
  test(`native batch discovery and cross-batch promotion: ${mode}, override=${override}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dynamic-native-discovery-'));
    let session;
    let terminate = override === 'terminate';
    const discovers = override === 'none' || override === 'terminate';
    try {
      const root = join(cwd, 'dynamic-skill', 'SKILL.md');
      const paths = ['a', 'b', 'c', 'd', 'e'].map(name => join(dirname(root), 'skills', name, 'SKILL.md'));
      for (const path of [root, ...paths]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `---\nname: ${dirname(path).split('/').at(-1)}\ndescription: Description ${path}\n---\nPRIVATE BODY\n`);
      }
      const sm = SessionManager.create(cwd, cwd);
      sm.appendMessage({ role: 'user', content: 'prefix', timestamp: 1 });
      sm.appendCustomEntry(ACCESS_STATE, { version: 1, active: paths.slice(0, 4), pendingEviction: [] });
      const fixtures = pi => {
        for (const name of ['read', 'write', 'edit']) pi.registerTool({ name, label: name, description: 'fixture access',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          async execute() { return { content: [{ type: 'text', text: 'native tool content' }], details: { truncation: { truncated: false } }, terminate }; } });
        pi.on('tool_result', event => {
          if (event.input.path !== root) return;
          if (override === 'error') return { isError: true };
          if (override === 'details') return { details: { replaced: true } };
        });
      };
      const extensionsResult = await createTestExtensionsResult([dynamicSkill, fixtures], cwd);
      const resourceLoader = createTestResourceLoader({ extensionsResult });
      resourceLoader.getSkills = () => loadSkillsFromDir({ dir: dirname(root), source: 'test' });
      const auth = AuthStorage.create(join(cwd, 'auth.json'));
      await auth.modify('anthropic', async () => ({ type: 'api_key', key: 'test-key' }));
      const registry = await createModelRegistry(auth, cwd);
      session = new AgentSession({
        agent: new Agent({ streamFn: streamSimple, convertToLlm,
          transformContext: messages => session.extensionRunner.emitContext(messages),
          initialState: { model: getModel('anthropic', 'claude-sonnet-4-5') } }),
        sessionManager: sm, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
        cwd, modelRuntime: getModelRuntime(registry), resourceLoader,
      });
      const errors = [];
      await session.bindExtensions({ onError: error => errors.push(error) });
      session.agent.toolExecution = mode;
      session.agent.state.messages = sm.buildSessionContext().messages;
      const requests = [];
      const positions = [];
      session.agent.streamFunction = (model, context) => {
        requests.push(JSON.stringify(context.messages.map(({ role, content }) => ({ role, content }))));
        positions.push(latestAccessState(sm.getEntries()).state.active.indexOf(paths[3]));
        const n = requests.length;
        const calls = n === 1 ? [
          { id: 'parent', name: 'read', arguments: { path: root } },
          ...['read', 'write', 'edit'].map((name, i) => ({ id: `child-${i}`, name, arguments: { path: paths[3] } })),
        ] : n === 2 ? [{ id: 'again', name: 'read', arguments: { path: paths[3] } }] : [];
        const message = { ...fauxAssistantMessage('done'), api: model.api, provider: model.provider, model: model.id,
          ...(calls.length ? { content: calls.map(call => ({ type: 'toolCall', ...call })), stopReason: 'toolUse' } : {}) };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: 'done', reason: calls.length ? 'toolUse' : 'stop', message }));
        return stream;
      };
      await session.prompt('start');
      if (terminate) {
        expect(requests).toHaveLength(1); // Context-only delivery must not restart a terminated batch.
        terminate = false;
        await session.prompt('continue');
      }
      expect(errors).toEqual([]);
      expect(positions).toEqual([3, 1, 0]);
      expect(requests).toHaveLength(3);
      expect(requests[1].includes('### Discovered skills')).toBe(discovers);
      expect(requests[1].match(/<name>d<\/name>/g)).toHaveLength(1);
      expect(requests[1].match(/<name>e<\/name>/g)?.length ?? 0).toBe(discovers ? 1 : 0);
      expect(requests[1]).not.toContain(DISCOVERY_DETAILS);
      expect(requests[1]).not.toContain('PRIVATE BODY');
      expect(requests[1].lastIndexOf('native tool content')).toBeLessThan(discovers ? requests[1].indexOf('### Discovered skills') : Infinity);
      const state = latestAccessState(sm.getEntries()).state;
      expect(state.discovery.map(d => d.path)).toEqual(discovers ? [paths[4]] : []);
      expect(state.active).not.toContain(root);
      expect(sm.buildSessionContext().messages.filter(skillDetails)).toHaveLength(discovers ? 2 : 1);
      const result = sm.getEntries().find(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'parent').message;
      expect(result.content).toEqual([{ type: 'text', text: 'native tool content' }]);
      if (override !== 'details') expect(result.details.truncation).toEqual({ truncated: false });
      expect(SessionManager.open(sm.getSessionFile()).getEntries()).toEqual(sm.getEntries());
    } finally { session?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
  });
}
