export function resultOf(turn){let result=turn?.response?.result;if(typeof result==='string'){try{return JSON.parse(result);}catch{return null;}}return result||null;}
export function clarificationModel(result){
 if(result?.status!=='clarification')return null;
 const text=String(result.clarification||result.message||'').trim();if(!text)return null;
 return {text,intro:String(result.message||'').trim()===text?'':String(result.message||''),options:(Array.isArray(result.clarification_options)?result.clarification_options:[]).filter(o=>o&&typeof o.label==='string'&&typeof o.value==='string').slice(0,6),allowSkip:result.allow_skip===true};
}
export function usedMemories(result,memories=[]){
 const ids=[...new Set((result?.cards||[]).flatMap(c=>Array.isArray(c.memory_ids)?c.memory_ids:[]))];
 return ids.map(id=>{const m=memories.find(m=>m.id===id);return {id,available:Boolean(m),text:m?.text||'',topic:m?.problem||'',reasons:[...new Set((result.cards||[]).filter(c=>c.memory_ids?.includes(id)).map(c=>c.match_reason).filter(Boolean))]};});
}
export function recoverWaitingTurns(items){return items.map(c=>({...c,turns:c.turns.map(t=>t.status==='waiting'&&!t.response?{...t,status:'interrupted',error:'等待已中断，本轮结果尚未确认。'}:t)}));}

// The UI consumes text deltas, not a transport. Real HTTP/SSE/WebSocket adapters
// can call append() without changing the message component.
export function createTextStream({initial='',onText=()=>{}}={}){
 let text=String(initial),state='streaming';
 return {append(delta){if(state!=='streaming'||typeof delta!=='string')return text;text+=delta;onText(text);return text;},finish(){state='complete';return text;},stop(){state='stopped';return text;},fail(){state='failed';return text;},get text(){return text;},get state(){return state;}};
}

export function initChatViewport({getConversation}){
 const scroller=document.getElementById('conversation-scroll'),jump=document.getElementById('jump-to-latest');
 let renderedId='',hasNew=false,restoring=false;
 const nearBottom=()=>scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<72;
 function update(){if(nearBottom())hasNew=false;jump.hidden=scroller.scrollHeight<=scroller.clientHeight+72||nearBottom();jump.textContent=hasNew?'有新回复 · 回到最新消息':'回到最新消息';}
 scroller.addEventListener('scroll',()=>{if(!restoring){const c=getConversation();if(c?.id===renderedId)c.scrollTop=scroller.scrollTop;}update();},{passive:true});
 const observer=new ResizeObserver(update);observer.observe(scroller);
 jump.onclick=()=>{scroller.scrollTo({top:scroller.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});hasNew=false;update();};
 return {
  before(c){return {same:renderedId===c?.id,top:scroller.scrollTop,stick:nearBottom(),completed:(c?.turns||[]).filter(t=>t.response).length};},
  after(c,snapshot){renderedId=c?.id||'';restoring=true;scroller.scrollTop=snapshot.same?(snapshot.stick?scroller.scrollHeight:snapshot.top):Number(c?.scrollTop)||0;restoring=false;update();},
  end(){requestAnimationFrame(()=>{scroller.scrollTop=scroller.scrollHeight;hasNew=false;update();});},
  beforeDelta(){return {stick:nearBottom(),top:scroller.scrollTop};},
  afterDelta(position){if(position.stick)scroller.scrollTop=scroller.scrollHeight;else{scroller.scrollTop=position.top;hasNew=true;}update();},
  notifyReply(){if(!nearBottom())hasNew=true;update();},
 };
}
