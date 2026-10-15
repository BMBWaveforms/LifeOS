import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RealService} from '../../frontend/horizon/service.mjs';
import {loadRuntimeConfig} from '../../frontend/horizon/runtime-config.mjs';
import {resultOf,clarificationModel,usedMemories} from '../../frontend/horizon/chat-presentation.mjs';
const guide=JSON.parse(readFileSync(new URL('../../data/guide.json',import.meta.url))).entries.find(e=>e.guide_id==='03-01');

// These are public baseline payloads. Unknown execution metadata is deliberately not consumed.
test('real JSON provider preserves server IDs, validated cards and separate summary failure',async()=>{
 const calls=[],service=new RealService();
 const response={conversation_id:'server-rotated',result:{status:'answer',cards:[guide],message:'固定指南'},summary:{saved:false,message:'摘要未能保存。'},execution:{runtime:'claude-sdk'}};
 service.request=async(path,body,signal)=>{calls.push({path,body,signal});return path==='/api/memories'?{enabled:true}:response;};
 const signal=new AbortController().signal;
 const result=await service.submit({query:'手机打断工作',conversationId:'previous',followupId:'memory-a',requestId:'future-only',onProgress:()=>assert.fail('no fake real stream'),signal});
 assert.equal(result,response);assert.deepEqual(resultOf({response:result}).cards[0],guide);
 assert.deepEqual(calls.map(c=>c.path),['/api/memories','/api/run']);
 assert.deepEqual(calls[1].body,{mode:'chat',query:'手机打断工作',conversation_id:'previous',followup_memory_id:'memory-a'});
 assert.equal(calls[0].signal,signal);assert.equal(calls[1].signal,signal);assert.equal(result.summary.saved,false);
});

test('disabled memory blocks real chat without an implicit settings write',async()=>{
 const service=new RealService(),calls=[];
 service.request=async(path,body)=>{calls.push({path,body});return {enabled:false};};
 await assert.rejects(service.submit({query:'不应发送'}),/自动记忆尚未/);
 assert.deepEqual(calls,[{path:'/api/memories',body:undefined}]);
});

test('real home accepts current JSON-string result and does not invent recommendations',async()=>{
 const service=new RealService(),followups=[{memory_id:'m',topic:'租房',progress_question:'有进展吗？'}];
 service.request=async(path,body)=>{assert.equal(path,'/api/run');assert.equal(body.mode,'home');return {result:JSON.stringify({followups})};};
 assert.deepEqual(await service.getHome(),{followups});
 assert.deepEqual(clarificationModel({status:'clarification',message:'租还是买？',clarification:'租还是买？'}),{text:'租还是买？',intro:'',options:[],allowSkip:false});
 assert.deepEqual(usedMemories({cards:[{memory_ids:['missing']}]}),[{id:'missing',available:false,text:'',topic:'',reasons:[]}]);
});

test('runtime discovery uses health and missing config fails closed without API access',async()=>{
 const calls=[];
 const config=await loadRuntimeConfig(async(path)=>{calls.push(String(path));return {ok:true,json:async()=>calls.length===1?{real_api_enabled:true}:{model:{configured:true}}};});
 assert.deepEqual(config,{real_api_enabled:true,real_model_configured:true});assert.equal(calls[1],'/health');assert.equal(calls.length,2);
 for(const request of [async()=>({ok:true,json:async()=>({real_api_enabled:false})}),async()=>{throw Error('offline');}])assert.deepEqual(await loadRuntimeConfig(request),{real_api_enabled:false,real_model_configured:false});
 let count=0;await loadRuntimeConfig(async()=>{assert.equal(++count,1);return {ok:true,json:async()=>({real_api_enabled:false})};});
});

test('real transport is same-origin, forwards abort and surfaces authentication errors',async()=>{
 const original=globalThis.fetch;const calls=[];globalThis.fetch=async(path,options)=>{calls.push({path,options});return {ok:false,status:401,json:async()=>({message:'请先登录。'})};};
 try{const signal=new AbortController().signal;await assert.rejects(new RealService().request('/api/run',{mode:'chat'},signal),e=>e.status===401&&e.message==='请先登录。');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.signal,signal);assert.deepEqual(JSON.parse(calls[0].options.body),{mode:'chat'});}finally{globalThis.fetch=original;}
});

test('published candidate guide and attribution stay identical to authoritative data',()=>{
 for(const name of ['guide.json','ATTRIBUTION.txt','GUIDE-LICENSE.txt'])assert.deepEqual(readFileSync(new URL('../../frontend/horizon/assets/'+name,import.meta.url)),readFileSync(new URL('../../data/'+name,import.meta.url)));
});
