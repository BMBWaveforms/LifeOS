// Local navigation only: the limit affects the sidebar, never saved history.
export const RECENT_CONVERSATION_LIMIT=6;
const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
export function conversationActivity(c){return Math.max(...['created','updated','lastOpened'].map(key=>{const v=c?.[key];const n=typeof v==='number'?v:Date.parse(v||'');return Number.isFinite(n)?n:0;}));}
export function sortConversations(items){return items.filter(c=>c.turns?.length).slice().sort((a,b)=>conversationActivity(b)-conversationActivity(a));}
function texts(c){return (c.turns||[]).flatMap(t=>{let result=t.response?.result;if(typeof result==='string'){try{result=JSON.parse(result);}catch{result=null;}}return [t.query,result?.message,result?.clarification,...(result?.cards||[]).flatMap(g=>[g.title,...Object.values(g.fields||{})])].filter(x=>typeof x==='string'&&x);});}
export function matchesConversation(c,query=''){const q=compact(query).toLocaleLowerCase();return !q||[c.title,c.projectTitle,...texts(c)].some(x=>compact(x).toLocaleLowerCase().includes(q));}
export function matchingConversationTurn(c,query=''){const q=compact(query).toLocaleLowerCase();if(!q)return null;return (c.turns||[]).slice().reverse().find(t=>texts({turns:[t]}).some(x=>compact(x).toLocaleLowerCase().includes(q)))?.id||null;}
export function conversationPreview(c,query='',limit=90){
 const all=texts(c),q=compact(query).toLocaleLowerCase();
 let text=q?all.slice().reverse().find(x=>compact(x).toLocaleLowerCase().includes(q)):null;
 text=compact(text||(c.turns||[]).at(-1)?.query||'');
 const found=q?text.toLocaleLowerCase().indexOf(q):-1,start=found>20?found-16:0;
 return (start?'…':'')+text.slice(start,start+limit)+(text.length>start+limit?'…':'');
}
export function recentConversations(items){return sortConversations(items).slice(0,RECENT_CONVERSATION_LIMIT);}


// Message timestamps distinguish repeated scene titles without changing saved names.
export function conversationMeta(c){
 const activity=conversationActivity({created:c.created,updated:c.updated});
 const stamp=activity>0?new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'}).format(new Date(activity)):'';
 return [stamp,`${c.turns?.length||0} 次交流`].filter(Boolean).join(' · ');
}

// A small, event-driven interpretation of Line Sidebar: text stays in its row,
// nearby markers react together, and no animation loop runs while idle.
export function initHistoryLineNavigation(root){
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');let pointerY=null,frame=0;
 const rows=()=>[...root.querySelectorAll('.history-row')];
 function paint(){frame=0;const targets=rows().map(row=>{const rect=row.getBoundingClientRect(),distance=pointerY===null?Infinity:Math.abs(pointerY-(rect.top+rect.height/2)),p=Math.max(0,1-distance/80);return [row,reduced.matches||root.classList.contains('is-dragging')?0:p*p*(3-2*p)];});for(const [row,value]of targets)row.style.setProperty('--line-proximity',value.toFixed(3));}
 function refresh(){if(!frame)frame=requestAnimationFrame(paint);}
 root.addEventListener('pointermove',event=>{if(event.pointerType==='touch')return;pointerY=event.clientY;refresh();});
 root.addEventListener('pointerleave',()=>{pointerY=null;refresh();});
 root.addEventListener('scroll',refresh,{passive:true});
 reduced.addEventListener('change',()=>{pointerY=null;refresh();});
 return {refresh};
}
