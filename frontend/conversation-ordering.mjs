import {conversationActivity} from './conversation-library.mjs';

// Opening a conversation never moves its row. Actual message activity orders
// the default list; manual preferences store IDs and keep new conversations first.
export function orderedConversations(items, preference=[]){
 const activity=c=>conversationActivity({created:c.created,updated:c.updated});
 const sorted=items.filter(c=>c.turns?.length).slice().sort((a,b)=>activity(b)-activity(a));
 if(!Array.isArray(preference)||!preference.length)return sorted;
 const available=new Map(sorted.map(c=>[c.id,c])),seen=new Set();
 const ordered=[];
 for(const id of preference)if(typeof id==='string'&&available.has(id)&&!seen.has(id)){seen.add(id);ordered.push(available.get(id));}
 return [...sorted.filter(c=>!seen.has(c.id)),...ordered];
}
export function movedConversationIds(items,preference,sourceId,targetId){
 const ids=orderedConversations(items,preference).map(c=>c.id),from=ids.indexOf(sourceId),to=ids.indexOf(targetId);
 if(from<0||to<0||from===to)return null;
 const next=ids.slice();next.splice(from,1);next.splice(to,0,sourceId);return next;
}

export function initHistoryReordering(root,{onMove,enabled=()=>true}){
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');let pending=null,drag=null,frame=0,suppressClick=false;
 const allRows=()=>[...root.querySelectorAll('.history-row')];
 function finish(commit=false){
  pending=null;const current=drag;if(!current)return;drag=null;cancelAnimationFrame(frame);frame=0;
  const before=new Map(current.rows.map(row=>[row.dataset.conversationId,row.getBoundingClientRect().top]));
  before.set(current.id,current.ghost.getBoundingClientRect().top);
  if(root.hasPointerCapture(current.pointerId))root.releasePointerCapture(current.pointerId);
  current.ghost.remove();document.body.classList.remove('is-history-reordering');root.classList.remove('is-dragging');suppressClick=true;
  for(const row of current.rows){row.classList.remove('is-ordering-origin','is-ordering-neighbor');row.style.removeProperty('transform');}
  if(commit&&current.valid&&current.to!==current.from)onMove({group:current.group,sourceId:current.id,targetId:current.rows[current.to].dataset.conversationId});
  const rows=allRows();
  if(!reduced.matches)for(const row of rows){const top=before.get(row.dataset.conversationId);if(top===undefined)continue;const delta=top-row.getBoundingClientRect().top;if(Math.abs(delta)>.5)row.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:240,easing:'cubic-bezier(.22,1,.36,1)'});}
  rows.find(row=>row.dataset.conversationId===current.id)?.querySelector('.history-select')?.focus({preventScroll:true});
 }
 function paint(){
  frame=0;const d=drag;if(!d)return;
  const bounds=root.getBoundingClientRect(),edge=28;
  if(d.y<bounds.top+edge)root.scrollTop-=Math.min(8,(bounds.top+edge-d.y)/4);
  if(d.y>bounds.bottom-edge)root.scrollTop+=Math.min(8,(d.y-bounds.bottom+edge)/4);
  const offset=root.scrollTop-d.scrollStart,first=d.rects[0].top-offset,last=d.rects.at(-1).bottom-offset;
  d.valid=d.x>=bounds.left-16&&d.x<=bounds.right+16&&d.y>=first-16&&d.y<=last+16;
  let to=d.from,nearest=Infinity;
  if(d.valid)d.rects.forEach((r,i)=>{const distance=Math.abs(d.y-(r.top+r.height/2-offset));if(distance<nearest){nearest=distance;to=i;}});
  d.to=to;
  d.ghost.style.transform=`translate3d(${Math.max(-18,Math.min(18,(d.x-d.startX)*.15))}px,${d.y-d.startY}px,0) scale(${reduced.matches?1:1.02})`;
  d.ghost.style.opacity=d.valid?'1':'.6';
  for(const [i,row]of d.rows.entries()){
   const shift=i===d.from?d.rects[to].top-d.rects[d.from].top:i>d.from&&i<=to?-d.height:i<d.from&&i>=to?d.height:0;
   row.style.transform=`translateY(${shift}px)`;
  }
  frame=requestAnimationFrame(paint);
 }
 function startDrag(event){
  const candidate=pending;pending=null;if(!candidate||!enabled()||!candidate.origin.isConnected)return;
  const {origin,pointerId,startX,startY}=candidate,group=origin.dataset.orderGroup,rows=allRows().filter(row=>row.dataset.orderGroup===group);
  if(rows.length<2)return;
  for(const row of rows)row.getAnimations().forEach(animation=>animation.cancel());
  const rects=rows.map(row=>row.getBoundingClientRect()),from=rows.indexOf(origin),rect=rects[from],ghost=origin.cloneNode(true);
  ghost.classList.add('conversation-drag-preview');ghost.classList.remove('active');ghost.setAttribute('aria-hidden','true');ghost.inert=true;
  Object.assign(ghost.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});
  document.getElementById('workspace').append(ghost);
  rows.forEach(row=>row.classList.add(row===origin?'is-ordering-origin':'is-ordering-neighbor'));
  drag={id:origin.dataset.conversationId,group,rows,rects,from,to:from,height:rect.height,ghost,pointerId,startX,startY,x:event.clientX,y:event.clientY,scrollStart:root.scrollTop,valid:true};
  root.setPointerCapture(pointerId);document.body.classList.add('is-history-reordering');root.classList.add('is-dragging');frame=requestAnimationFrame(paint);
 }
 root.addEventListener('pointerdown',event=>{
  const select=event.target.closest('.history-select');if(!select||event.button!==0||!event.isPrimary||!enabled())return;
  finish();suppressClick=false;pending={origin:select.closest('.history-row'),pointerId:event.pointerId,startX:event.clientX,startY:event.clientY};
 });
 root.addEventListener('click',event=>{if(suppressClick&&event.detail!==0){event.preventDefault();event.stopImmediatePropagation();}},true);
 // Keep tracking outside the panel too: dropping over the chat must cancel,
 // even if a browser releases pointer capture while moving a focused row.
 window.addEventListener('pointermove',event=>{if(pending?.pointerId===event.pointerId&&Math.hypot(event.clientX-pending.startX,event.clientY-pending.startY)>=8)startDrag(event);if(drag?.pointerId===event.pointerId){event.preventDefault();drag.x=event.clientX;drag.y=event.clientY;}},true);
 window.addEventListener('pointerup',event=>{if(pending?.pointerId===event.pointerId)pending=null;if(drag?.pointerId===event.pointerId){drag.x=event.clientX;drag.y=event.clientY;cancelAnimationFrame(frame);paint();finish(true);}if(suppressClick)setTimeout(()=>{suppressClick=false;},0);},true);
 window.addEventListener('pointercancel',()=>finish(),true);root.addEventListener('lostpointercapture',()=>finish());
 window.addEventListener('keydown',event=>{if((drag||pending)&&event.key==='Escape'){event.preventDefault();event.stopPropagation();finish();}},true);
 root.addEventListener('keydown',event=>{
  const handle=event.target.closest('.history-select');if(!handle||!event.altKey||event.ctrlKey||event.metaKey||!['ArrowUp','ArrowDown'].includes(event.key)||!enabled())return;
  event.preventDefault();const row=handle.closest('.history-row'),group=row.dataset.orderGroup,rows=allRows().filter(item=>item.dataset.orderGroup===group),from=rows.indexOf(row),to=from+(event.key==='ArrowUp'?-1:1);
  if(to<0||to>=rows.length)return;
  const id=row.dataset.conversationId;onMove({group,sourceId:id,targetId:rows[to].dataset.conversationId});
  allRows().find(item=>item.dataset.conversationId===id)?.querySelector('.history-select')?.focus({preventScroll:true});
 });
 window.addEventListener('blur',()=>finish());document.addEventListener('visibilitychange',()=>{if(document.hidden)finish();});
 return {cancel:()=>finish()};
}
