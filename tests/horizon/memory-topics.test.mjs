import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {memoryDate,topicMemoryIds,topicSearchText,pruneMemorySnapshot,invalidateMemoryConversations,renderMemoryTopic} from '../../frontend/memory-topics.mjs';
import {DemoService,RealService} from '../../frontend/service.mjs';

class Node{
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.className='';this.listeners={};this._text='';}
 set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 append(...nodes){this.children.push(...nodes);}
 addEventListener(name,handler){this.listeners[name]=handler;}
 click(){return this.listeners.click?.();}
 findAll(selector){return this.children.flatMap(child=>[...(selector.startsWith('.')?child.className.split(' ').includes(selector.slice(1)):child.tagName===selector)?[child]:[],...child.findAll(selector)]);}
}
const document={createElement:tag=>new Node(tag)};
const source=(id,query,state='active')=>({id,query,text:query,created:1792051200,state});
const old=source('old','预算原为 3500。','superseded'),latest=source('latest','预算已经调整为 5000。');
const topic={id:'moving-topic',title:'搬家',text:'[2026-10-15T08:00:00Z]旧的技术拼接正文',created:old.created,updated:latest.created,current_memory_id:latest.id,sources:[old,latest],source_count:2,excerpts:[{source_id:latest.id,quote:latest.query,created:latest.created}],consolidation:{status:'not_needed'}};
const snapshot=()=>({enabled:true,topics:[topic,{id:'other',title:'睡眠',current_memory_id:'sleep',sources:[source('sleep','另一个话题')]}],memories:[old,latest,source('sleep','另一个话题')],effective:[latest,source('sleep','另一个话题')]});

test('topic card shows structured quotes with friendly dates and collapsed source details',()=>{
 const card=renderMemoryTopic(topic,{document});assert.equal(card.dataset.topicId,topic.id);
 assert.match(card.findAll('.memory-excerpt')[0].textContent,/预算已经调整为 5000/);assert.doesNotMatch(card.textContent,/T08:00:00Z|旧的技术拼接正文/);
 const details=card.findAll('details')[0];assert.ok(!details.open);assert.equal(details.findAll('summary')[0].textContent,'查看来源记录（2 条）');
 assert.equal(details.findAll('.memory-source').length,2);assert.equal(details.findAll('.memory-source')[0].textContent.split(old.query).length-1,1);assert.doesNotMatch(details.textContent,/来源内容/);
 assert.equal(card.findAll('.memory-excerpt')[0].findAll('small')[0].textContent,memoryDate(latest.created));
});
test('topic actions use the current source for continuation and exact IDs for each deletion',()=>{
 const calls=[],card=renderMemoryTopic(topic,{document,onContinue:topic=>calls.push(['continue',topic.current_memory_id]),onDeleteTopic:topic=>calls.push(['topic',topic.id]),onDeleteSource:(source,topic)=>calls.push(['source',source.id,topic.id])});
 const buttons=card.findAll('button');buttons.find(button=>button.textContent==='继续聊').click();buttons.find(button=>button.textContent==='删除主题').click();buttons.find(button=>button.textContent==='删除记录').click();
 assert.deepEqual(calls,[['continue','latest'],['topic','moving-topic'],['source','old','moving-topic']]);
 const historical=renderMemoryTopic({...topic,current_memory_id:''},{document});assert.equal(historical.findAll('button').some(button=>button.textContent==='继续聊'),false);
});
test('a differing source summary remains distinguishable and user text is never interpreted as HTML',()=>{
 const query='<img src=x onerror=alert(1)>我的原话',card=renderMemoryTopic({...topic,sources:[{...latest,query,text:'当次独立摘要'}]},{document});
 assert.equal(card.findAll('.memory-source-query')[0].textContent,query);assert.match(card.findAll('details')[0].textContent,/来源内容/);assert.equal(card.findAll('img').length,0);
 assert.equal(memoryDate(1792051200),memoryDate(1792051200000));assert.match(memoryDate(1792051200),/2026/);assert.equal(memoryDate('broken'),'');
});
test('topic search includes old source wording and incomplete organization has readable status',()=>{
 assert.match(topicSearchText(topic),/3500/);
 for(const [status,copy]of [['pending','正在整理这个话题'],['failed','暂未整理完成']])assert.match(renderMemoryTopic({...topic,consolidation:{status}},{document}).textContent,new RegExp(copy));
});
test('successful source deletion clears derived topic cache before any potentially failed refresh',()=>{
 const original=snapshot(),result=pruneMemorySnapshot(original,{topic,sourceId:'old'});
 assert.deepEqual(result.topics.map(item=>item.id),['other']);assert.deepEqual(result.memories.map(item=>item.id),['latest','sleep']);
 assert.doesNotMatch(JSON.stringify(result),/3500|技术拼接正文/);assert.equal(original.topics.length,2);
});
test('whole-topic and clear deletion remove exactly the authorized cached records',()=>{
 const result=pruneMemorySnapshot(snapshot(),{topic});assert.deepEqual(result.memories.map(item=>item.id),['sleep']);assert.deepEqual(result.effective.map(item=>item.id),['sleep']);
 const clear=pruneMemorySnapshot(snapshot(),{clear:true});assert.deepEqual(clear.topics,[]);assert.deepEqual(clear.memories,[]);assert.deepEqual(clear.effective,[]);
});
test('deletion invalidates all topic followups and recovered summaries without removing displayed conversations',()=>{
 const conversations=[{id:'one',serverId:'first',followupId:'old',recoveredMemory:{id:'old',text:'deleted'},resumedMemoryIds:['old']},{id:'two',serverId:'second',followupId:'latest',recoveredMemory:{id:'latest',text:'derived'},resumedMemoryIds:['latest']},{id:'other',serverId:'third',followupId:'sleep'}];
 invalidateMemoryConversations(conversations,topicMemoryIds(topic));assert.equal(conversations.length,3);
 for(const conversation of conversations.slice(0,2)){assert.equal(conversation.followupId,'');assert.equal(conversation.serverId,'');assert.equal(conversation.recoveredMemory,undefined);assert.deepEqual(conversation.resumedMemoryIds,[]);}
 assert.equal(conversations[2].followupId,'sleep');assert.equal(conversations[2].serverId,'');
});
test('demo uses the same topic/source interface and deleting latest cannot revive superseded history',async()=>{
 const entries=JSON.parse(readFileSync(new URL('../../data/guide.json',import.meta.url))).entries,map=new Map(),store={getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)},service=new DemoService(entries,store,0);
 const first=await service.submit({query:'准备租房签合同',requestId:'first'}),second=await service.submit({query:'租房时押金怎么处理',followupId:first.summary.memory_id,requestId:'second'});
 let state=await service.getMemories();assert.equal(state.topics.length,1);assert.equal(state.topics[0].source_count,2);assert.equal(state.topics[0].current_memory_id,second.summary.memory_id);
 await service.deleteMemory(second.summary.memory_id);state=await service.getMemories();assert.equal(state.topics[0].current_memory_id,'');assert.equal((await service.getHome()).followups.length,0);
 await service.deleteTopic(state.topics[0].id);assert.equal((await service.getMemories()).topics.length,0);assert.equal((await service.getMemories()).memories.length,0);
});
test('real adapter sends deletion-only topic and conversation requests',async()=>{
 const service=new RealService(),calls=[];service.request=async(path,body)=>{calls.push({path,body});return {};};
 await service.deleteTopic(topic.id);await service.deleteConversation('conversation-id');
 assert.deepEqual(calls,[{path:'/api/memory-action',body:{action:'delete_topic',id:topic.id}},{path:'/api/conversation-action',body:{action:'delete',conversation_id:'conversation-id'}}]);
});
