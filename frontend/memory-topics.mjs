// Sources are the facts; summaries are replaceable views and must disappear on deletion.
export function memoryDate(value){
 if(value===undefined||value===null||value==='')return '';
 const date=new Date(typeof value==='number'&&Math.abs(value)<1e12?value*1000:value);
 return Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(date);
}
export function topicMemoryIds(topic){return [...new Set([topic?.current_memory_id,...(topic?.sources||[]).map(source=>source.id)].filter(Boolean))];}
export function topicSearchText(topic){return [topic.title,topic.text,...(topic.excerpts||[]).map(item=>item.quote),...(topic.sources||[]).flatMap(source=>[source.query,source.text])].filter(Boolean).join(' ').toLocaleLowerCase();}
export function demoTopics(records){
 const lookup=new Map(records.map(record=>[record.id,record])),groups=new Map();
 for(const record of records){
  let ancestor=record;const visited=new Set();
  while(!ancestor.topic_id&&ancestor.followup_of&&lookup.has(ancestor.followup_of)&&!visited.has(ancestor.id)){visited.add(ancestor.id);ancestor=lookup.get(ancestor.followup_of);}
  const id=record.topic_id||ancestor.topic_id||ancestor.followup_of||ancestor.id;
  if(!groups.has(id))groups.set(id,[]);groups.get(id).push(record);
 }
 return [...groups].map(([id,items])=>{
  const latest=items.at(-1),current=items.filter(item=>item.state==='active').at(-1);
  const sources=items.map(item=>({id:item.id,query:item.query||item.text,text:item.text,created:item.created,state:item.state,guide_ids:item.guide_ids||[]}));
  return {id,title:latest.problem||'生活话题',text:latest.text,created:items[0].created,updated:latest.updated||latest.created,problem_status:current?.problem_status||'unknown',current_memory_id:current?.id||'',sources,source_count:sources.length,excerpts:sources.map(source=>({source_id:source.id,quote:source.query,created:source.created})),consolidation:{status:'not_needed'}};
 });
}
export function pruneMemorySnapshot(snapshot,{topic=null,sourceId='',clear=false}={}){
 if(!snapshot)return snapshot;
 const ids=new Set(clear?(snapshot.memories||[]).map(item=>item.id):sourceId?[sourceId]:topicMemoryIds(topic));
 return {...snapshot,memories:(snapshot.memories||[]).filter(item=>!ids.has(item.id)),effective:(snapshot.effective||[]).filter(item=>!ids.has(item.id)),...(Array.isArray(snapshot.topics)?{topics:clear?[]:snapshot.topics.filter(item=>item.id!==topic?.id&&!(item.sources||[]).some(source=>source.id===sourceId))}: {})};
}
export function invalidateMemoryConversations(conversations,ids){
 const affected=ids?new Set(ids):null;
 for(const conversation of conversations){
  conversation.serverId='';
  if(!affected||affected.has(conversation.followupId)){conversation.followupId='';conversation.followupTitle='';}
  if(conversation.recoveredMemory&&(!affected||affected.has(conversation.recoveredMemory.id)))delete conversation.recoveredMemory;
  conversation.resumedMemoryIds=(conversation.resumedMemoryIds||[]).filter(id=>affected&&!affected.has(id));
 }
}
export function renderMemoryTopic(topic,{document=globalThis.document,onContinue,onDeleteTopic,onDeleteSource}={}){
 const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
 const button=(text,callback,cls='')=>{const node=el('button',text,cls);node.type='button';node.addEventListener('click',callback);return node;};
 const card=el('article',undefined,'memory-item memory-topic');card.dataset.topicId=topic.id;
 const meta=el('div',undefined,'memory-meta');meta.append(el('span',memoryDate(topic.updated||topic.created)),el('span',topic.problem_status==='resolved'?'已解决':topic.current_memory_id?'咨询主题':'历史记录','memory-status'));
 card.append(meta,el('h3',topic.title||'生活话题'));
 if(topic.excerpts?.length){for(const excerpt of topic.excerpts){if(!excerpt.quote)continue;const section=el('div',undefined,'memory-excerpt');section.append(el('p',excerpt.quote),el('small',memoryDate(excerpt.created)));card.append(section);}}
 else if(topic.text)card.append(el('p',topic.text,'memory-topic-summary'));
 if(topic.consolidation?.status==='pending')card.append(el('p','正在整理这个话题，来源记录已保留。','dialog-muted'));
 else if(topic.consolidation?.status==='failed')card.append(el('p','这个话题暂未整理完成，来源记录已保留。','dialog-muted'));
 const details=el('details',undefined,'memory-sources');details.append(el('summary',`查看来源记录（${topic.source_count??topic.sources?.length??0} 条）`));
 for(const source of topic.sources||[]){
  const record=el('article',undefined,'memory-source');record.dataset.memoryId=source.id;
  record.append(el('small',memoryDate(source.created)));
  if(source.query)record.append(el('p','当时说的','memory-source-label'),el('p',source.query,'memory-source-query'));
  if(source.text&&source.text!==source.query)record.append(el('p','来源内容','memory-source-label'),el('p',source.text,'memory-source-summary'));
  const controls=el('div',undefined,'memory-actions');controls.append(button('删除记录',()=>onDeleteSource?.(source,topic),'danger'));record.append(controls);details.append(record);
 }
 card.append(details);const controls=el('div',undefined,'memory-actions');
 if(topic.current_memory_id)controls.append(button('继续聊',()=>onContinue?.(topic)));
 controls.append(button('删除主题',()=>onDeleteTopic?.(topic),'danger'));card.append(controls);return card;
}
