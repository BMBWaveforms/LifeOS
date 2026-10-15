/* Providers are deliberately separate. Demo never falls through to a live API. */
export const DEMO_KEY='lifeos.horizon.demo.v1';
export const uid=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
const clone=value=>JSON.parse(JSON.stringify(value));
const initial=()=>({enabled:true,revision:0,memories:[],operations:{}});
export function delay(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted){reject(new DOMException('已停止','AbortError'));return;}const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(finish,ms);const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('已停止','AbortError'));};signal?.addEventListener('abort',abort,{once:true});});}

const bundles=[
  {pattern:/通勤|上下班路上/,ids:['04-18']},
  {pattern:/通知|专注|分心|打断|集中注意|刷手机/,ids:['03-01','03-06']},
  {pattern:/租房|房租|房东|押金|搬家/,ids:['15-01','15-06']},
  {pattern:/拖延|拖着|拖到|不想做/,ids:['04-09','04-13']},
  {pattern:/睡眠|失眠|熬夜|睡不好|作息/,ids:['03-03','03-08']},
  {pattern:/习惯/,ids:['04-12']},
];
export function searchGuides(entries,query){
  const curated=bundles.find(x=>x.pattern.test(query));
  if(curated){const ids=curated.ids.includes('04-18')&&/租房|搬家/.test(query)?['15-01','15-06',...curated.ids]:curated.ids;return ids.map(id=>entries.find(e=>e.guide_id===id)).filter(Boolean);}
  const compact=query.replace(/[\s\p{P}a-z0-9]/giu,'');
  const grams=[...new Set(Array.from({length:Math.max(0,compact.length-1)},(_,i)=>compact.slice(i,i+2)))];
  return entries.map(entry=>({entry,score:grams.reduce((score,g)=>score+(entry.title.includes(g)?5:0)+(entry.fields['说人话']?.includes(g)?1:0),0)})).filter(x=>x.score>=10).sort((a,b)=>b.score-a.score).slice(0,2).map(x=>x.entry);
}

export class DemoService{
  constructor(entries,storage,latency=1050){this.mode='demo';this.user={id:'local-demo',name:'访客体验'};this.entries=entries;this.storage=storage;this.latency=latency;this.state=initial();try{const parsed=JSON.parse(storage?.getItem(DEMO_KEY)||'null');if(parsed&&typeof parsed.enabled==='boolean'&&Array.isArray(parsed.memories)&&parsed.operations&&typeof parsed.operations==='object')this.state={...parsed,enabled:true};}catch{ /* A new demo remains usable if stored data is damaged. */ }}
  commit(update){const next=clone(this.state);const result=update(next);next.revision++;const keys=Object.keys(next.operations);for(const id of keys.slice(0,-50))delete next.operations[id];try{if(!this.storage)throw Error();this.storage.setItem(DEMO_KEY,JSON.stringify(next));}catch{throw new Error('浏览器未能保存记录。请允许本机存储后重试；本次没有写入记忆。');}this.state=next;return result;}
  async getMemories(){return {...clone(this.state),enabled:true,effective:clone(this.state.memories.filter(m=>m.state==='active'))};}
  async getHome(){return {followups:clone(this.state.memories.filter(m=>m.state==='active'&&m.problem_status!=='resolved').slice().reverse().slice(0,3).map(m=>({memory_id:m.id,topic:m.problem,progress_question:'上次聊到的这件事，有新进展了吗？',guide_question:'要不要接着聊？'})))};}
  async submit({query,conversationId,followupId,requestId=uid(),signal,onProgress,clarification}){
    await delay(this.latency,signal);
    if(signal?.aborted)throw new DOMException('已停止','AbortError');
    if(this.state.operations[requestId])return clone(this.state.operations[requestId]);
    const base={conversation_id:conversationId||uid(),summary:{saved:false,message:'本轮没有创建咨询主题。'}};
    if(clarification&&(clarification.optionId==='skip'||/暂不补充/.test(query)))return {...base,result:{status:'acknowledged',message:'可以，先不补充。搬家方式仍然未知，暂时不展开租赁合同相关建议。可以先说说，这次搬家最想改善什么？',cards:[]}};
    if(clarification&&(clarification.optionId==='buy'||/购房|买房/.test(query)))return {...base,result:{status:'unsupported',message:'收到，这次是购房搬家。当前演示的固定场景主要覆盖租房，暂时没有足够适用的指南，不把租赁建议套用到购房情境。',cards:[]}};
    if(!clarification&&/搬家/.test(query)&&!/租房|房租|买房|购房|签约|押金|房东|通勤/.test(query))return {...base,result:{status:'clarification',message:'这次是租房搬家，还是购房搬家？',clarification:'这次是租房搬家，还是购房搬家？',clarification_options:[{id:'rent',label:'租房搬家',value:'这次是租房搬家。'},{id:'buy',label:'购房搬家',value:'这次是购房搬家。'}],allow_skip:true,cards:[]}};
    const cards=searchGuides(this.entries,query);

    const greeting=/^(你好|您好|嗨|hello|hi|谢谢|谢谢你)[！!。\s]*$/i.test(query);
    const response={conversation_id:conversationId||uid(),result:{status:cards.length?'answer':greeting?'acknowledged':'unsupported',message:cards.length?'先把眼前的事拆小一点。以下是固定指南里与这个话题相关的条目，你可以先挑一条了解。':greeting?'你好。可以先说说最近正在经历的一件事，不用组织得很完整。':'这次关键词检索没有找到足够相关的条目。可以补充一下具体情境，或试试“手机总打断工作”“租房押金”“重要的事总拖着”这些示例。',cards:clone(cards)},summary:{saved:false,message:'本轮没有创建咨询主题。'}};
    const selectedMemory=followupId?this.state.memories.find(m=>m.id===followupId&&m.state==='active'):null;
    if(selectedMemory)response.result.cards=response.result.cards.map(card=>({...card,memory_ids:[selectedMemory.id],match_reason:'接续你明确选择的咨询主题。'}));
    if(cards.length&&typeof onProgress==='function'){
      for(const chunk of response.result.message.match(/.{1,5}/gu)||[]){if(signal?.aborted)throw new DOMException('已停止','AbortError');onProgress({type:'text_delta',text:chunk});await delay(90,signal);}
    }
    if(cards.length){
      try{this.commit(s=>{
        const previous=followupId?s.memories.find(m=>m.id===followupId&&m.state==='active'):null;
        if(followupId&&!previous)throw new Error('关联记忆已失效，请开始新话题。');
        const now=Date.now();
        const memory={id:uid(),text:query,problem:previous?.problem||query.slice(0,60),problem_status:'unresolved',state:'active',created:now,updated:now,guide_ids:[...new Set([...(previous?.guide_ids||[]),...cards.map(c=>c.guide_id)])],followup_of:previous?.id||'',origin:'demo_topic',source_conversation_id:response.conversation_id};
        // Continuing a conversation appends a new record, preserving saved content.
        if(previous)previous.state='superseded';
        s.memories.push(memory);
        response.summary={saved:true,memory_id:memory.id,message:'已自动记住本次咨询，可在“我的记忆”查看或删除。'};
        s.operations[requestId]=clone(response);
      });}
      catch(error){response.summary={saved:false,message:error.message};}
    }
    return response;
  }
  async deleteMemory(id){this.commit(s=>{if(!s.memories.some(m=>m.id===id))throw Error('这条记忆已不存在。');s.memories=s.memories.filter(m=>m.id!==id);s.operations={};});return this.getMemories();}
  async clearMemories(){this.commit(s=>{s.memories=[];s.operations={};});return this.getMemories();}
}

export class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
export class RealService{
  constructor(){this.mode='real';this.user=null;}
  async request(path,data,signal){let response;try{response=await fetch(path,{method:data===undefined?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal});}catch(e){if(e.name==='AbortError')throw e;throw new ApiError('连接没有成功。请检查服务后重试，你的输入已保留。',0);}let body;try{body=await response.json();}catch{throw new ApiError('服务暂时没有返回可读的结果，请稍后重试。',response.status);}if(!response.ok)throw new ApiError(body.message||'服务暂时无法完成操作。',response.status);return body;}
  async me(){this.user=(await this.request('/api/me')).user;return this.user;}
  async login(username,password){this.user=(await this.request('/api/login',{username,password})).user;return this.user;}
  async logout(){await this.request('/api/logout',{});this.user=null;}
  async getMemories(){return this.request('/api/memories');}
  async getHome(){const data=await this.request('/api/run',{mode:'home',query:'',conversation_id:'',followup_memory_id:''});const result=typeof data.result==='string'?JSON.parse(data.result):data.result;return {followups:result?.followups||[]};}
  async submit({query,conversationId,followupId,signal}){const memory=await this.request('/api/memories',undefined,signal);if(memory.enabled!==true)throw new ApiError('当前账号的自动记忆尚未由后端启用，请联系部署者完成接入。你的输入已保留。',409);return this.request('/api/run',{mode:'chat',query,conversation_id:conversationId||'',followup_memory_id:followupId||''},signal);}
  async deleteMemory(id){return this.request('/api/memory-action',{action:'delete',id});}
  async clearMemories(){return this.request('/api/memory-action',{action:'clear',confirmed:true});}
}
