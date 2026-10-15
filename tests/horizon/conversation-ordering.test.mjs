import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedConversations,movedConversationIds} from '../../frontend/horizon/conversation-ordering.mjs';

const items=()=>Array.from({length:12},(_,i)=>({id:'c'+i,created:100-i,turns:[{query:'相同标题的不同对话'}]}));
const ids=list=>list.map(c=>c.id);

test('moving visible conversations saves the full bucket without discarding hidden history',()=>{
 const source=items(),before=structuredClone(source),order=movedConversationIds(source,[],'c0','c3');
 assert.deepEqual(order,['c1','c2','c3','c0','c4','c5','c6','c7','c8','c9','c10','c11']);
 assert.deepEqual(ids(orderedConversations(source,order)),order);assert.deepEqual(source,before);
 assert.deepEqual(movedConversationIds(source,order,'c0','c1'),ids(source));
});
test('saved order survives opening an existing chat; new conversations appear first',()=>{
 const source=items(),order=movedConversationIds(source,[],'c0','c3');source[5].lastOpened=999;
 assert.deepEqual(ids(orderedConversations(source,order)),order);
 const fresh={id:'fresh',created:1000,turns:[{query:'新问题'}]};
 assert.deepEqual(ids(orderedConversations([...source,fresh],order)),['fresh',...order]);
});
test('stale and duplicate preferences cannot duplicate rows or resurrect deleted chats',()=>{
 const source=items().filter(c=>c.id!=='c2');
 const ordered=ids(orderedConversations(source,['missing','c2','c4','c4',null,'c3']));
 assert.equal(ordered.length,source.length);assert.equal(new Set(ordered).size,source.length);
 assert.deepEqual(ordered.slice(-2),['c4','c3']);assert.ok(!ordered.includes('c2'));
 assert.deepEqual(ids(orderedConversations(source,{})),ids(source));
});
test('invalid targets, cross-group IDs and unchanged positions never produce a reorder',()=>{
 const source=items();assert.equal(movedConversationIds(source,[],'c0','project-chat'),null);
 assert.equal(movedConversationIds(source,[],'missing','c1'),null);
 assert.equal(movedConversationIds(source,[],'c1','c1'),null);
 assert.deepEqual(orderedConversations([{id:'empty',turns:[]}],[]),[]);
});

test('opening chats keeps default and manual row positions stable; new messages update the default list',()=>{
 const source=items(),initial=ids(orderedConversations(source));
 for(const c of source){c.lastOpened=Date.now();assert.deepEqual(ids(orderedConversations(source)),initial);}
 source[5].updated=1000;assert.deepEqual(ids(orderedConversations(source)),['c5',...initial.filter(id=>id!=='c5')]);
 const manual=movedConversationIds(source,[],'c5','c3');source[7].lastOpened=Date.now()+1000;
 assert.deepEqual(ids(orderedConversations(source,manual)),manual);
});
