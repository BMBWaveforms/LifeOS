import test from 'node:test';
import assert from 'node:assert/strict';
import {findMemoryConversation,memoryResumeContext} from '../../frontend/memory-navigation.mjs';

test('exact saved turn wins over a later continuation and supports legacy memories',()=>{
 const origin={id:'old',turns:[{response:{summary:{memory_id:'m1'}}}]};
 const resumed={id:'new',resumedMemoryIds:['m1'],turns:[]};
 assert.equal(findMemoryConversation([resumed,origin],{id:'m1'}),origin);
});
test('persisted origin resolves older server IDs, never an unrelated conversation',()=>{
 const origin={id:'local',serverId:'server-new',turns:[{response:{conversation_id:'server-old'}}]};
 assert.equal(findMemoryConversation([origin],{id:'m1',source_conversation_id:'server-old'}),origin);
 assert.equal(findMemoryConversation([origin],{id:'m2',source_conversation_id:'unrelated'}),null);
});
test('deleted origin falls back to a restored chat without creating duplicates',()=>{
 const restored={id:'new',resumedMemoryIds:['m1'],turns:[]};
 assert.equal(findMemoryConversation([],{id:'m1'}),null);
 assert.equal(findMemoryConversation([restored],{id:'m1'}),restored);
});
test('restoration retains the exact immutable summary separately from the short prompt',()=>{
 const memory={id:'m',problem:'准备搬家',text:'原有摘要'.repeat(600)};
 const before=JSON.stringify(memory),context=memoryResumeContext(memory);
 assert.equal(context.text,memory.text);assert.equal(context.id,'m');assert.ok(context.query.length<2000);
 assert.equal(JSON.stringify(memory),before);
});
