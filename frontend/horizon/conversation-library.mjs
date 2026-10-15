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
