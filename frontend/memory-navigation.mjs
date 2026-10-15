// Prefer the exact turn that saved the memory; server conversation IDs can rotate.
export function findMemoryConversation(conversations,memory){
 if(!memory?.id)return null;
 const exact=conversations.find(c=>c.turns?.some(t=>t.response?.summary?.memory_id===memory.id));
 if(exact)return exact;
 const origin=memory.source_conversation_id;
 if(origin){const source=conversations.find(c=>c.id===origin||c.serverId===origin||c.turns?.some(t=>t.response?.conversation_id===origin));if(source)return source;}
 return conversations.find(c=>c.resumedMemoryIds?.includes(memory.id))||null;
}
export function memoryResumeContext(memory){
 const topic=String(memory.problem||'上次的话题').slice(0,160);
 return {id:memory.id,topic,text:String(memory.text||''),query:'上次聊到“'+topic+'”。请结合已保存的记忆，接着帮我梳理下一步。'};
}
