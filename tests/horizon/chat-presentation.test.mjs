import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clarificationModel,createTextStream,recoverWaitingTurns,usedMemories} from '../../frontend/horizon/chat-presentation.mjs';
import {conversationPreview,matchingConversationTurn,matchesConversation,recentConversations,sortConversations} from '../../frontend/horizon/conversation-library.mjs';
import {DemoService} from '../../frontend/horizon/service.mjs';
const entries=JSON.parse(readFileSync(new URL('../../frontend/horizon/assets/guide.json',import.meta.url))).entries;
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};};

test('sidebar limits never discard stored conversations and most recently used wins',()=>{
 const items=Array.from({length:48},(_,i)=>({id:String(i),created:i+1,turns:[{query:'租房'}]}));items[0].lastOpened=1000;
 assert.equal(recentConversations(items).length,6);assert.equal(recentConversations(items)[0].id,'0');assert.equal(sortConversations(items).length,48);assert.equal(items.length,48);assert.equal(items[1].id,'1');
});
test('search finds original message content and the preview reveals the matching passage',()=>{
 const c={title:'搬家这件事',turns:[{id:'earlier',query:'预算3000元，要求通勤45分钟以内'},{id:'later',query:'继续聊'}]};
 assert.ok(matchesConversation(c,'3000'));assert.ok(conversationPreview(c,'3000').includes('3000'));assert.equal(matchesConversation(c,'6000'),false);
 assert.equal(matchingConversationTurn(c,'3000'),'earlier');
});
test('clarification is rendered once, optional controls require actual option data',()=>{
 const c=clarificationModel({status:'clarification',message:'租房还是购房？',clarification:'租房还是购房？',clarification_options:[{label:'租房',value:'租房'},null,{label:'不能发送'}],allow_skip:true});
 assert.equal(c.intro,'');assert.equal(c.options.length,1);assert.equal(c.allowSkip,true);assert.equal(clarificationModel({status:'answer',clarification:'忽略'}),null);
});
test('memory references use only cited IDs and never replace a deleted source with unrelated memory',()=>{
 const r=usedMemories({cards:[{memory_ids:['a','deleted']},{memory_ids:['a']}]},[{id:'a',text:'原话',problem:'通勤'},{id:'b',text:'不相关'}]);
 assert.equal(r.length,2);assert.equal(r[0].text,'原话');assert.equal(r[1].available,false);assert.equal(r[1].text,'');
});
test('refresh turns an abandoned wait into an uncertain recoverable state while preserving partial text',()=>{
 const input=[{id:'c',turns:[{status:'waiting',partial:'已展示内容'},{status:'completed',response:{result:{}}}]}];const [c]=recoverWaitingTurns(input);
 assert.equal(c.turns[0].status,'interrupted');assert.equal(c.turns[0].partial,'已展示内容');assert.equal(c.turns[1].status,'completed');assert.equal(input[0].turns[0].status,'waiting');
});
test('stream lifecycle retains text and rejects late chunks after completion, failure or stop',()=>{
 for(const end of ['finish','fail','stop']){const stream=createTextStream();stream.append('第一段');stream.append('第二段');stream[end]();stream.append('不能再追加');assert.equal(stream.text,'第一段第二段');}
});
test('demo clarification supports a choice and a skip without inventing personal facts',async()=>{
 const service=new DemoService(entries,storage(),0);
 const first=await service.submit({query:'我下个月准备搬家，有什么要先确认？',conversationId:'a'});
 assert.equal(first.result.status,'clarification');assert.equal((await service.getMemories()).memories.length,0);
 const skipped=await service.submit({query:'暂不补充',clarification:{query:'搬家'},conversationId:'a'});assert.equal(skipped.result.cards.length,0);
 const answered=await service.submit({query:'这次是租房搬家。',clarification:{query:'搬家'},conversationId:'a'});assert.equal(answered.result.status,'answer');
});
test('stopping during demo streaming preserves the partial display but cannot save a late memory',async()=>{
 const service=new DemoService(entries,storage(),0),controller=new AbortController(),chunks=[];
 await assert.rejects(service.submit({query:'手机通知总打断工作',signal:controller.signal,onProgress:event=>{chunks.push(event.text);controller.abort();}}),e=>e.name==='AbortError');
 assert.equal(chunks.length,1);assert.equal((await service.getMemories()).memories.length,0);
});
