import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DemoService,searchGuides,DEMO_KEY,RealService} from '../../frontend/horizon/service.mjs';
const entries=JSON.parse(readFileSync(new URL('../../data/guide.json',import.meta.url))).entries;
const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)};};
const make=(s=storage())=>new DemoService(entries,s,0);

test('question → exact guide text → local memory → followup → delete removes followup',async()=>{
 const s=make(),r=await s.submit({query:'工作时总被手机通知打断',requestId:'one'});
 assert.equal(r.result.cards[0].guide_id,'03-01');assert.deepEqual(r.result.cards[0],entries.find(e=>e.guide_id==='03-01'));
 assert.equal(r.summary.saved,true);assert.equal((await s.getHome()).followups.length,1);
 const m=(await s.getMemories()).memories[0];assert.equal(m.text,'工作时总被手机通知打断');
 await s.deleteMemory(m.id);assert.equal((await s.getHome()).followups.length,0);assert.equal((await s.getMemories()).memories.length,0);
});
test('same request is idempotent, followup preserves immutable saved content, deletion is durable',async()=>{
 const store=storage(),s=make(store),input={query:'准备租房签合同',requestId:'one'};
 const one=await s.submit(input),two=await s.submit(input);assert.deepEqual(one,two);assert.equal(s.state.memories.length,1);
 const next=await s.submit({query:'租房时押金如何写进合同',followupId:one.summary.memory_id,requestId:'two'});assert.equal(s.state.memories.length,2);
 assert.equal(s.state.memories[0].text,input.query);assert.equal(s.state.memories[0].state,'superseded');
 assert.notEqual(next.summary.memory_id,one.summary.memory_id);
 await s.deleteMemory(next.summary.memory_id);assert.equal((await make(store).getHome()).followups.length,0);
});
test('legacy disabled setting cannot prevent automatic saving, and mutator APIs are absent',async()=>{
 const store=storage(),s=make(store);await s.submit({query:'手机总打断工作'});
 const persisted=JSON.parse(store.getItem(DEMO_KEY));persisted.enabled=false;store.setItem(DEMO_KEY,JSON.stringify(persisted));
 const restored=make(store);await restored.submit({query:'我现在准备租房'});
 assert.equal((await restored.getMemories()).enabled,true);assert.equal(restored.state.memories.length,2);
 assert.equal(typeof restored.setMemory,'undefined');assert.equal(typeof restored.updateMemory,'undefined');
});
test('abort never writes a late memory',async()=>{
 const store=storage(),s=new DemoService(entries,store,100),controller=new AbortController();
 const pending=s.submit({query:'工作总被手机打断',signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});
 assert.equal(s.state.memories.length,0);assert.equal(store.getItem(DEMO_KEY),null);
});
test('storage failure keeps answer separate from failed memory save and leaves state untouched',async()=>{
 const s=make({getItem:()=>null,setItem:()=>{throw Error('quota');}}),result=await s.submit({query:'租房押金'});
 assert.equal(result.result.status,'answer');assert.equal(result.summary.saved,false);assert.equal(s.state.memories.length,0);assert.match(result.summary.message,/未能保存/);
});
test('unknown topic does not fabricate a guide, greeting does not create memory',async()=>{
 const s=make();assert.equal(searchGuides(entries,'xyzzzx火星独角兽').length,0);
 const r=await s.submit({query:'xyzzzx火星独角兽'});assert.equal(r.result.status,'unsupported');assert.equal(r.result.cards.length,0);
 const hi=await s.submit({query:'你好'});assert.equal(hi.result.status,'acknowledged');assert.equal(s.state.memories.length,0);
});
test('real provider exposes deletion and has no disable or edit method',async()=>{
 const s=new RealService();let request;s.request=async(path,body)=>{request={path,body};return {};};
 await s.deleteMemory('memory-1');
 assert.deepEqual(request,{path:'/api/memory-action',body:{action:'delete',id:'memory-1'}});
 assert.equal(typeof s.setMemory,'undefined');assert.equal(typeof s.updateMemory,'undefined');
});

test('saved demo memory retains its originating conversation across reloads',async()=>{
 const store=storage(),s=make(store);
 const response=await s.submit({query:'租房前需要注意什么',conversationId:'original-chat',requestId:'origin'});
 const memory=(await make(store).getMemories()).memories[0];
 assert.equal(response.conversation_id,'original-chat');assert.equal(memory.source_conversation_id,'original-chat');
});
