import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSkillContextRuntime,NESTED_ACCESS} from '../dist/runtime.js';
import {anchorSources,anchorKey} from '../dist/projection.js';
import {readChildren} from '../dist/tree.js';
import {queueFixture} from './queue-fixture.mjs';

const request = f => f.manager.buildSessionProjection().messages.filter(message=>message.role!=='system');

test('native system declarations do not create a missing-context settlement',t=>{
 const f=queueFixture(t);
 f.seed(f.paths.slice(0,2),[f.paths[2]],{announced:[f.paths[2]],pendingTokens:{[f.paths[2]]:'pending'}});
 f.manager.appendMessage({role:'system',content:'System instructions',timestamp:1});
 f.manager.appendMessage({role:'user',content:'Task',timestamp:2});
 f.runtime.project(f.ctx,request(f));
 assert.deepEqual(f.state().pendingEviction,[f.paths[2]]);
 f.manager.appendMessage({role:'system',content:'Updated instructions',timestamp:3});
 f.runtime.project(f.ctx,request(f));
 assert.deepEqual(f.state().pendingEviction,[f.paths[2]]);
});

for(const reduction of ['context_edit','compaction'])test(`native ${reduction} settles pending once without a lifecycle notification`,t=>{
 const f=queueFixture(t);
 f.seed(f.paths.slice(0,2),[f.paths[2]],{announced:[f.paths[2]],pendingTokens:{[f.paths[2]]:'pending'}});
 const id=f.manager.appendMessage({role:'user',content:'Task',timestamp:2});
 f.runtime.project(f.ctx,request(f));
 assert.deepEqual(f.state().pendingEviction,[f.paths[2]]);
 if(reduction==='context_edit')f.manager.appendContextEdit(id,{content:'Edited task'});
 else f.manager.appendCompaction('Summary',id,100);
 f.runtime.project(f.ctx,request(f));
 assert.deepEqual(f.state().pendingEviction,[]);
 const settled=structuredClone(f.state());
 f.runtime.project(f.ctx,request(f));
 assert.deepEqual(f.state(),settled);
});

test('description provenance follows native replacements and omissions',t=>{
 const f=queueFixture(t);
 const id=f.manager.appendMessage({role:'user',content:'old',timestamp:2});
 f.manager.appendContextEdit(id,{content:'new'});
 let projection=f.manager.buildSessionProjection();
 assert.equal(anchorSources(projection.entries).get(anchorKey(projection.messages[0])),id);
 f.manager.appendContextEdit(id,null);
 projection=f.manager.buildSessionProjection();
 assert.equal(anchorSources(projection.entries).size,0);
});

test('nested accesses are consumed once across reconciliation and runtime recovery',t=>{
 const f=queueFixture(t);
 const id=f.manager.appendCustomEntry(NESTED_ACCESS,{name:'read',path:f.paths[0]});
 f.runtime.reconcile(f.ctx);
 assert.deepEqual(f.state().active,[f.paths[0]]);
 assert.equal(f.state().cursor,id);
 const leaf=f.manager.getLeafId();
 f.runtime.reconcile(f.ctx);
 assert.equal(f.manager.getLeafId(),leaf);
 const reopened=createSkillContextRuntime(f.pi,f.options);
 reopened.start(f.ctx,'resume');reopened.reconcile(f.ctx);
 assert.equal(f.manager.getLeafId(),leaf);
});

test('nested discovery snapshots remain available without a transcript tool result',t=>{
 const f=queueFixture(t);
 f.manager.appendMessage({role:'user',content:'Discover',timestamp:1});
 f.manager.appendCustomEntry(NESTED_ACCESS,{name:'read',path:f.root,
  discovery:{parent:f.root,children:readChildren([f.root],f.root).roots}});
 const messages=f.runtime.project(f.ctx,request(f));
 for(const path of f.paths)assert.ok(JSON.stringify(messages).includes(path));
 assert.equal(f.state().discovery.length,f.paths.length);
});
