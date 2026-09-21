// Run with the experimental native host's Vitest aliases, not the published SDK.
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
import { skillDetails, visibleSkills } from '../src/context.ts';

for (const order of ['skills-first', 'skills-last']) {
  for (const mode of ['sequential', 'parallel']) {
    for (const retain of [false, true]) {
      test(`native fold reconciles once: ${order}, ${mode}, retained=${retain}`, async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'dynamic-native-host-'));
        let session;
        try {
          const root = join(cwd, 'dynamic-skill', 'SKILL.md');
          const paths = ['a', 'b'].map(name => join(dirname(root), 'skills', name, 'SKILL.md'));
          for (const [path, name] of [[root, 'dynamic-skill'], [paths[0], 'a'], [paths[1], 'b']]) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, `---\nname: ${name}\ndescription: ${name} description\n---\n`);
          }
          const sm = SessionManager.create(cwd, cwd);
          const prefix = sm.appendMessage({ role: 'user', content: 'stable prefix', timestamp: 1 });
          sm.appendCustomEntry(ACCESS_STATE, { version: 1, active: [paths[0]], pendingEviction: [] });
          const loaded = sm.appendCustomMessageEntry('dynamic-skill:context', 'Original loaded A', false,
            { id: 'original-a', paths: [paths[0]], pendingPaths: [] });
          const tools = pi => {
            pi.registerTool({ name: 'read', label: 'read', description: 'fixture successful access',
              parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
              async execute() { return { content: [{ type: 'text', text: 'read completed' }], details: {} }; } });
            pi.registerTool({ name: 'trim_history', label: 'trim', description: 'fixture native fold',
              parameters: { type: 'object', properties: {} }, supportsBacktrack: true,
              async execute(id, _args, _signal, _update, ctx) {
                ctx.requestBacktrack(id, { keepThroughEntryId: retain ? loaded : prefix, messages: [] });
                return { content: [{ type: 'text', text: 'fold committed' }], details: {} };
              } });
          };
          const extensionsResult = await createTestExtensionsResult(order === 'skills-first' ? [dynamicSkill, tools] : [tools, dynamicSkill], cwd);
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
          session.agent.streamFunction = (model, context) => {
            requests.push(JSON.stringify(context.messages));
            const first = requests.length === 1;
            const message = { ...fauxAssistantMessage('done'), api: model.api, provider: model.provider, model: model.id,
              ...(first ? { content: [
                { type: 'toolCall', id: 'access', name: 'read', arguments: { path: paths[1] } },
                { type: 'toolCall', id: 'fold', name: 'trim_history', arguments: {} },
              ], stopReason: 'toolUse' } : {}) };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message }));
            return stream;
          };
          await session.prompt('start');
          expect(errors).toEqual([]);
          expect(requests).toHaveLength(2);
          expect(requests[1]).not.toContain('read completed');
          expect(requests[1]).not.toContain('fold committed');
          expect(requests[1].match(/<name>b<\/name>/g)).toHaveLength(1);
          expect(requests[1].includes('Original loaded A')).toBe(retain);
          const messages = sm.buildSessionContext().messages;
          expect(new Set(visibleSkills(messages))).toEqual(new Set(paths));
          const delta = messages.filter(skillDetails).at(-1);
          expect(new Set(skillDetails(delta).paths)).toEqual(new Set(retain ? [paths[1]] : paths));
          expect(new Set(latestAccessState(sm.getBranch()).state.active)).toEqual(new Set(paths));
          const reduction = sm.getBranch().find(e => e.type === 'backtrack');
          const leaf = sm.getLeafId();
          await session.extensionRunner.emit({ type: 'session_backtrack', backtrackEntry: reduction });
          expect(sm.getLeafId()).toBe(leaf);
          expect(SessionManager.open(sm.getSessionFile()).buildSessionContext()).toEqual(sm.buildSessionContext());
        } finally {
          session?.dispose();
          rmSync(cwd, { recursive: true, force: true });
        }
      });
    }
  }
}
