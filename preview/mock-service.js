/* Isolated prototype provider. Session data stays in memory; no real fetch or user-text persistence. */
(function(root) {
  const clone = value => JSON.parse(JSON.stringify(value));
  function createMockProduct(guides, options={}) {
    let account='alice', generation=0, sequence=0;
    const pending=new Set(), operations=new Map(), conflictedRequests=new Set();
    const now=()=>new Date().toISOString();
    const id=prefix=>prefix+'-'+(++sequence);
    const fixtureDate={value:'2026-11',precision:'month',raw:'下个月',anchor:'2026-10-14T07:00:00.000Z',timezone:'Asia/Shanghai'};
    const event=user=>({id:'mock-event-'+user+'-move',category:'生活事件',eventType:'move',title:'租房搬家',status:'planned',date:clone(fixtureDate),attributes:{housing:'rent',budget:null},version:1,confirmation:'confirmed',source:{conversationId:'mock-c-'+user+'-seed',messageId:'mock-message-'+user+'-seed'},createdAt:now(),updatedAt:now()});
    const fresh=(user,full)=>({settings:{allowSave:full,allowUse:full},revision:0,events:full?[event(user)]:[],conversations:full?[{id:'mock-c-'+user+'-seed',title:'租房搬家前，先关注什么？',messages:[{id:'mock-seed-turn',query:'我计划下个月租房搬家。',versions:[{result:{status:'answer',message:'【虚构示例】先确认所在地区和合同阶段，再核对指南适用条件。',cards:[clone(guides[0])]},summary:{saved:false,message:'示例对话；生活事件由虚构档案提供。'}}],versionIndex:0,status:'completed',context:{event:'租房搬家',date:clone(fixtureDate),housing:'rent',budget:null}}],context:{event:'租房搬家',date:clone(fixtureDate),housing:'rent',budget:null},draft:''}]:[],feedback:{},homeKind:full?'full':'empty',recommendationState:'ready',temporary:null,emptyReason:''});
    let accounts={alice:fresh('alice',true),bob:fresh('bob',false)};
    const capabilities=Object.freeze({events:true,independentSettings:true,history:true,stream:true,regenerate:true,radar:true,context:true,operationQuery:true});
    const requireAccount=()=>{if(!accounts[account]){const e=new Error('【模拟】登录已失效，请重新进入。');e.status=401;throw e;}return accounts[account];};
    const wait=(ms,signal)=>new Promise((resolve,reject)=>{
      if(signal?.aborted) {reject(new DOMException('Aborted','AbortError'));return;}
      const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(new DOMException('Aborted','AbortError'));};
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);
      signal?.addEventListener('abort',cancel,{once:true});
    });
    const scenario=()=>options.getScenario?.()||'normal';
    async function gate(kind) {
      const owner=account,stamp=generation,d=requireAccount(),rev=d.revision,sc=scenario();
      await wait(options.delay??220);
      if(owner!==account||stamp!==generation||rev!==d.revision)throw new DOMException('Aborted','AbortError');
      if(sc==='expired') {account='';generation++;const e=new Error('【模拟】登录已失效。');e.status=401;throw e;}
      if(sc==='busy') {const e=new Error('【模拟】上一轮仍在处理，请稍后重试。');e.status=409;throw e;}
      const failures={save:'savefail',update:'updatefail',delete:'deletefail',settings:'settingsfail',feedback:'feedbackfail',home:'homefail',memories:'listfail',history:'historyfail'};
      if(sc===failures[kind])throw new Error('【模拟】'+{save:'保存',update:'更新',delete:'删除',settings:'设置',feedback:'反馈',home:'推荐加载',memories:'列表加载',history:'历史读取'}[kind]+'失败，原有数据保留。');
      return {d,sc,owner};
    }
    function recommendations(d) {
      const basis=d.temporary||d.events.find(e=>e.status==='planned');
      if(!d.settings.allowUse||!basis||d.homeKind!=='full')return [];
      return guides.slice(0,2).map((g,i)=>({id:'mock-radar-'+basis.id+'-'+g.guide_id,title:i===0?'核对租房相关约定':'重新评估居住与通勤',guide:clone(g),basis:clone(basis),feedback:d.feedback['mock-radar-'+basis.id+'-'+g.guide_id]||'none',viewed:!!d.feedback['view-'+basis.id+'-'+g.guide_id],stale:d.recommendationState!=='ready',temporary:!!d.temporary})).filter(r=>!['ignored','paused'].includes(r.feedback));
    }
    const result=value=>clone(value);
    const service={
      mode:'mock',capabilities,getCapabilities:()=>capabilities,
      health:async()=>({model:{configured:false},backend:'isolated-mock'}),
      me:async()=>{requireAccount();return {id:account,name:account==='alice'?'Alice · 虚构账号':'Bob · 虚构账号'};},
      login:async(user,password)=>{if(!accounts[user]||password!=='preview'){const e=new Error('演示账号为 alice / bob，口令 preview。');e.status=401;throw e;}service.abortAll();account=user;return service.me();},
      logout:async()=>{service.abortAll();account='';},
      abortAll(){generation++;for(const c of pending)c.abort();pending.clear();},
      reset(kind='full'){service.abortAll();const user=account||'alice';accounts[user]=fresh(user,kind!=='empty');accounts[user].homeKind=kind;for(const key of operations.keys())if(key.startsWith(user+':'))operations.delete(key);},
      listConversations:async()=>result(requireAccount().conversations),
      getMemories:async()=>{const {d}=await gate('memories');return result({enabled:d.settings.allowSave&&d.settings.allowUse,settings:d.settings,revision:d.revision,events:d.events});},
      getHome:async()=>{
        const {d}=await gate('home');
        const recs=d.recommendationState!=='ready'&&d.previousRecommendations&&d.settings.allowUse?d.previousRecommendations.map(r=>({...r,stale:true,feedback:d.feedback[r.id]||r.feedback})).filter(r=>d.events.some(e=>e.id===r.basis.id&&e.status==='planned')&&!['ignored','paused'].includes(r.feedback)):recommendations(d);
        return result({recommendations:recs,followups:[],reason:!d.settings.allowUse?'记忆调用已关闭；仍可直接提问。':!d.events.length?'没有已确认的个人信息；仍可直接提问。':d.emptyReason|| (d.homeKind==='topics'?'有生活情境，但当前没有适合的关注事项。':'当前没有适合的关注事项。'),state:d.recommendationState});
      },
      markViewed(rec){const d=requireAccount();d.feedback['view-'+rec.basis.id+'-'+rec.guide.guide_id]=true;},
      rememberConversation(conversation){const d=requireAccount();const index=d.conversations.findIndex(c=>c.id===conversation.id);if(index<0)d.conversations.unshift(result(conversation));else d.conversations[index]=result(conversation);},
      async submitMessage(input) {
        const owner=account,stamp=generation,d=requireAccount(),rev=d.revision,sc=input.scenario||scenario();
        const controller=new AbortController();pending.add(controller);
        const signal=controller.signal, query=String(input.query||'').trim();
        if(!query||query.length>2000)throw new Error('请输入 1–2000 字的问题。');
        const anchor=input.anchor||now();
        const local=new Date(new Date(anchor).getTime()+8*3600000);
        const next=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+1,1));
        const date={value:next.toISOString().slice(0,7),precision:'month',raw:'下个月',anchor,timezone:'Asia/Shanghai'};
        try {
          await wait(Number(options.getDelay?.()??450),signal);
          if(sc==='network')throw new Error('【模拟】消息未送达。待发送的问题仍保留。');
          if(sc==='error')throw new Error('【模拟】回复生成失败，问题和当前情境仍保留。');
          if(sc==='nonjson')throw new Error('【模拟】服务返回了无法读取的响应，请稍后重试。');
          if(sc==='expired'){account='';generation++;const e=new Error('【模拟】登录已失效。');e.status=401;throw e;}
          if(sc==='busy'){const e=new Error('【模拟】上一轮仍在处理，请稍后重试。');e.status=409;throw e;}
          let context=input.context||{event:'租房搬家',date,housing:'rent',budget:null};
          if(sc==='notification')context={event:'工作时被手机通知打断',date:null,housing:null,budget:null};
          const supported=!['unsupported','clarification'].includes(sc);
          const card=clone(sc==='notification'?guides[2]:guides[0]);
          const missing=[!context.region?'地区':null,!['signed','unsigned'].includes(context.contract)?'合同阶段':null,'预算'].filter(Boolean).join('、');
          const text=sc==='unsupported'?'【模拟】当前指南不足以支持这个问题，不补写无来源的建议。':sc==='clarification'?'【模拟】你目前还没签租赁合同，还是已经签好了？这会影响适用范围。':sc==='partial'?'【模拟】只找到部分指南支持。无法覆盖全部问题，仍需确认适用范围。':'【模拟】根据本次情境整理指南。'+missing+'尚未说明，具体适用性仍需确认。';
          if(options.onChunk||input.onChunk){const onChunk=input.onChunk||options.onChunk;for(let end=12;end<text.length+12;end+=12){await wait(90,signal);if(owner!==account||stamp!==generation||rev!==d.revision)throw new DOMException('Aborted','AbortError');onChunk?.(text.slice(0,end));}}
          if(owner!==account||stamp!==generation||rev!==d.revision)throw new DOMException('Aborted','AbortError');
          const used=d.settings.allowUse?d.events.filter(e=>e.title===context.event):[];
          card.memory_ids=used.map(e=>e.id);card.match_reason='固定指南示例；请核对个人条件和原文限制。';
          const candidate=supported&&context.date&&!['notification','summaryfail'].includes(sc)?{id:input.turnId+'-candidate',category:'生活事件',eventType:'move',title:context.event,status:'planned',date:context.date,attributes:{housing:context.housing,budget:null},confirmation:'pending',source:{conversationId:input.conversationId,messageId:input.turnId},createdAt:anchor,updatedAt:anchor}:null;
          return result({conversation_id:input.conversationId,result:{status:sc==='clarification'?'clarification':sc==='unsupported'?'unsupported':sc==='partial'?'partial':'answer',message:text,clarification:sc==='clarification'?text:'',cards:supported?[card]:[],usedMemories:used},context,candidate,summary:{saved:false,message:sc==='summaryfail'?'【模拟】回答已完成，但候选整理失败；没有保存任何长期记忆。':'当前信息只用于本次对话。核对后可选择长期保存。'}});
        } finally {pending.delete(controller);}
      },
      async confirmEvent(candidate,scope,requestId) {
        const key=account+':save:'+requestId;
        if(operations.has(key))return result(operations.get(key).result);
        let guarded;
        try { guarded=await gate('save'); }
        catch(error) { if(operations.has(key))return result(operations.get(key).result);throw error; }
        const {d}=guarded;
        if(scope==='this_conversation')return {saved:false};
        if(!d.settings.allowSave)throw new Error('保存已关闭；可仅本次使用，或先在设置中开启保存。');
        const same=d.events.find(e=>e.source?.messageId===candidate.source?.messageId);
        if(same)return {saved:true,event:result(same)};
        const existing=d.events.find(e=>e.eventType===candidate.eventType&&e.status!=='cancelled');
        if(existing){const e=new Error('已有同类事件，请核对是否更新同一事件。');e.code='event_conflict';e.latest=result(existing);throw e;}
        const created={...result(candidate),id:id('mock-event-'+account),version:1,confirmation:'confirmed',updatedAt:now()};
        d.events.push(created);d.revision++;d.homeKind='full';d.recommendationState='ready';
        const output={saved:true,event:created};operations.set(key,{status:'confirmed',result:output});return result(output);
      },
      async updateEvent(eventId,changes,version,requestId) {
        const key=account+':update:'+requestId;
        if(operations.has(key))return result(operations.get(key).result);
        let guarded;
        try { guarded=await gate('update'); }
        catch(error) { if(operations.has(key))return result(operations.get(key).result);throw error; }
        const {d,sc}=guarded;
        const target=d.events.find(e=>e.id===eventId);
        if(!target)throw new Error('这条记忆已删除，请刷新列表。');
        if(sc==='conflict'&&!conflictedRequests.has(key)){conflictedRequests.add(key);target.version++;target.date={...target.date,value:'2027-01'};d.revision++;}
        if(target.version!==version){const e=new Error('这条记忆已被更新，请核对最新值后再选择。');e.code='version_conflict';e.latest=result(target);throw e;}
        d.previousRecommendations=clone(recommendations(d));
        Object.assign(target,result(changes),{id:eventId,version:target.version+1,updatedAt:now(),confirmation:'confirmed'});
        d.revision++;d.temporary=null;d.recommendationState='stale';
        if(target.status==='cancelled')d.emptyReason='生活计划已取消，暂无当前适合的关注事项。';
        const output=result(target);operations.set(key,{status:'confirmed',result:output});return output;
      },
      async deleteEvent(eventId,version) {
        const {d}=await gate('delete');const target=d.events.find(e=>e.id===eventId);
        if(!target)throw new Error('记录已不存在，请刷新。');
        if(target.version!==version){const e=new Error('记录已更新，请先核对最新内容。');e.code='version_conflict';e.latest=result(target);throw e;}
        d.events=d.events.filter(e=>e.id!==eventId);d.revision++;d.temporary=null;
        for(const key of Object.keys(d.feedback))if(key.includes(eventId))delete d.feedback[key];
        return {deleted:true};
      },
      async clearEvents(){const {d}=await gate('delete');d.events=[];d.feedback={};d.temporary=null;d.revision++;return {cleared:true};},
      async updateSettings(changes) {const {d}=await gate('settings');Object.assign(d.settings,changes);d.revision++;service.abortAll();return result(d.settings);},
      async refreshRecommendations() {const {d,sc}=await gate('home');if(sc==='recommendfail'){d.recommendationState='failed';throw new Error('【模拟】推荐更新失败；已保存的记忆不受影响。');}d.recommendationState='ready';return service.getHome();},
      useTemporary(eventId,changes){const d=requireAccount(),target=d.events.find(e=>e.id===eventId);if(!target)throw new Error('依据已删除。');d.temporary={...result(target),...result(changes)};d.recommendationState='ready';},
      async feedback(recId,kind,operationId) {
        const key=account+':feedback:'+operationId;
        if(operations.has(key))return result(operations.get(key));
        const {d,sc}=await gate('feedback');
        if(!['interested','ignored','paused','done','ineffective','undo'].includes(kind))throw new Error('未知的反馈类型。');
        const live=recommendations(d).find(r=>r.id===recId);
        if(!live)throw new Error('这条推荐依据已失效，请刷新。');
        if(sc==='unknown'||sc==='unknownfail'){const output={operationId,status:'unknown'};operations.set(key,{...output,recId,kind,resolveTo:sc==='unknownfail'?'failed':'confirmed'});return output;}
        d.feedback[recId]=kind==='undo'?'none':kind;d.emptyReason='关注反馈已将建议移出当前列表；生活资料仍保留。';
        const output={operationId,status:'confirmed'};operations.set(key,output);return result(output);
      },
      async readOperationResult(operationId) {
        const {d}=await gate('query');const op=operations.get(account+':feedback:'+operationId);
        if(!op)throw new Error('未找到这次操作。');
        if(op.status==='unknown') {op.status=op.resolveTo;if(op.status==='confirmed'){d.feedback[op.recId]=op.kind;d.emptyReason='关注反馈已将建议移出当前列表；生活资料仍保留。';}}
        return result(op);
      },
      guide:async guideId=>{const g=guides.find(g=>g.guide_id===guideId);if(!g)throw new Error('模拟环境没有这个条目。');return clone(g);}
    };
    // MVP provider extension. Legacy methods remain available for the prior contract regressions.
    const memoryRetries=new Map();
    const classify=(query,previous)=>/搬家|租房|住处|住房/.test(query)?'租房搬家':/工作|求职|通勤|通知/.test(query)?'工作与生活':/旅行|出行|周末|展览/.test(query)?'出行与休闲':previous||'其他';
    const normalizeConversation=c=>({...clone(c),group:c.group||classify(c.title),draft:c.draft||''});
    service.listMvpConversations=async()=>{const {d}=await gate('history');return d.conversations.map(normalizeConversation);};
    service.saveMvpConversation=c=>service.rememberConversation(c);
    service.deleteConversation=async conversationId=>{const {d}=await gate('delete');d.conversations=d.conversations.filter(c=>c.id!==conversationId);return {deleted:true};};
    service.renameConversation=async(conversationId,title,group)=>{const {d}=await gate('history');const c=d.conversations.find(c=>c.id===conversationId);if(!c)throw new Error('对话已不存在，请刷新历史。');c.title=String(title).trim().slice(0,80);c.group=group||c.group;return normalizeConversation(c);};
    service.getConversationSummary=async conversationId=>{const {d}=await gate('history');const c=d.conversations.find(c=>c.id===conversationId);if(!c)return {exists:false};const last=c.messages.at(-1);return {exists:true,conversation:normalizeConversation(c),summary:last?'上次你提到：'+last.query.slice(0,180):'这段对话尚未发送消息。'};};
    const galleryTitles={'15-01':'租房搬家','04-18':'居住与通勤','03-01':'工作与专注','02-11':'散步与日常活动','05-01':'财务与支出','21-07':'旅行与出行','15-06':'签约与安居','04-07':'计划与任务'};
    const mvpRecommendations=d=>guides.slice(0,options.extendedGallery?guides.length:3).map((g,i)=>({id:'mvp-rec-'+g.guide_id,title:galleryTitles[g.guide_id]||g.title,guide:clone(g),body:g.fields?.['说人话']||g.title,feedback:d.feedback['mvp-rec-'+g.guide_id]||'none',basis:i<3?(d.events.find(e=>i===2?e.eventType==='work':e.eventType==='move')||null):null})).filter(r=>r.feedback!=='ignored');
    service.getMvpHome=async()=>{
      const {d}=await gate('home');
      const followups=d.settings.allowUse?d.events.filter(e=>!['completed','cancelled','resolved'].includes(e.status)).map(e=>({memory_id:e.id,topic:e.title,progress_question:'【模拟回访】关于“'+e.title+'”，最近有进展吗？',guide_question:'是否需要继续咨询固定指南？'})):[];
      return {recommendations:mvpRecommendations(d),followups,state:'ready'};
    };
    service.mutate=async input=>{
      if(input.action==='settings'){
        if(typeof input.enabled!=='boolean')throw new Error('模拟记忆设置必须为布尔值。');
        await service.updateSettings({allowSave:input.enabled,allowUse:input.enabled});
        return service.getMemories();
      }
      if(input.action==='delete'){
        const event=requireAccount().events.find(e=>e.id===input.id);
        if(!event)throw new Error('这条模拟记忆已删除。');
        return service.deleteEvent(event.id,event.version);
      }
      throw new Error('静态演示未提供此操作。');
    };
    service.feedbackMvp=async(recId,operationId)=>{
      const key=account+':feedback:'+operationId;
      if(operations.has(key))return result(operations.get(key));
      const {d,sc}=await gate('feedback');
      if(!mvpRecommendations(d).some(r=>r.id===recId))throw new Error('这条推荐已移除，请刷新。');
      const uncertain=[...operations.values()].find(op=>op.owner===account&&op.recId===recId&&op.status==='unknown');
      if(uncertain)return {operationId:uncertain.operationId,status:'unknown'};
      const output={operationId,status:['unknown','unknownfail'].includes(sc)?'unknown':'confirmed',owner:account,recId,kind:'ignored',resolveTo:sc==='unknownfail'?'failed':'confirmed'};
      if(output.status==='confirmed')d.feedback[recId]='ignored';
      operations.set(key,output);return result(output);
    };
    function explicitMemory(input,context) {
      // Fixed demo rules extract only first-person statements, never infer a plan from a question.
      const q=input.query;
      if(/我(?:们)?(?:计划|准备|打算|要|正在|已经|最近|下个月)(?:先|去)?(?:了解|咨询|问|知道|看看|研究)/.test(q))return null;
      if(!/我(?:们)?(?:计划|准备|打算|要|正在|已经|最近|下个月)/.test(q))return null;
      let type,title;
      if(/搬家|租房|换个住处/.test(q)){type='move';title='租房搬家';}
      else if(/换工作|求职|找工作/.test(q)){type='work';title='求职换工作';}
      else if(/旅行|出行/.test(q)){type='trip';title='旅行出行';}
      else return null;
      const anchor=input.anchor||now(),local=new Date(new Date(anchor).getTime()+8*3600000);
      const month=q.match(/(20\d{2})[-年](\d{1,2})月?/);
      const date=/下个月/.test(q)?{value:new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+1,1)).toISOString().slice(0,7),precision:'month',raw:'下个月',anchor,timezone:'Asia/Shanghai'}:month&&Number(month[2])>=1&&Number(month[2])<=12?{value:month[1]+'-'+month[2].padStart(2,'0'),precision:'month',raw:month[0],anchor,timezone:'Asia/Shanghai'}:null;
      return {category:'生活事件',eventType:type,title,status:/取消|不再/.test(q)?'cancelled':/已经.*(?:搬完|搬好|换好)/.test(q)?'completed':'planned',date,attributes:{housing:/租房/.test(q)?'rent':/自有住房/.test(q)?'own':null,budget:null},source:{conversationId:input.conversationId,messageId:input.turnId},raw:q};
    }
    async function commitAutomatic(spec,turnId,followupId) {
      const key=account+':auto:'+turnId;
      if(operations.has(key)){const previous=operations.get(key).result;if(!requireAccount().events.some(e=>e.id===previous.event.id))return {saved:false,message:'这条记忆已删除，不会通过重新生成恢复。'};return result(previous);}
      const {d}=await gate('save');
      if(!d.settings.allowSave)return {saved:false,message:'【模拟】自动摘要已关闭，本轮未写入记忆。'};
      const existing=followupId?d.events.find(e=>e.id===followupId):d.events.find(e=>e.eventType===spec.eventType);
      if(followupId&&!existing)throw new Error('关联的模拟摘要已删除，请开启新对话。');
      let stored;
      if(existing){
        const changes={...spec,date:spec.date||existing.date,attributes:{...existing.attributes,...Object.fromEntries(Object.entries(spec.attributes).filter(([,v])=>v!==null))}};
        stored={...existing,...changes,id:id('mvp-memory-'+account),version:existing.version+1,updatedAt:now(),confirmation:'automatic'};
        d.events[d.events.indexOf(existing)]=stored;
      }else {stored={...clone(spec),id:id('mvp-memory-'+account),version:1,confirmation:'automatic',createdAt:now(),updatedAt:now()};d.events.push(stored);}
      d.revision++;
      const output={saved:true,memory_id:stored.id,event:clone(stored),message:'【模拟】本轮摘要已保存；真实服务由模型生成并校验摘要。'};
      operations.set(key,{status:'confirmed',result:output});memoryRetries.delete(account+':'+turnId);return output;
    }
    service.retryAutomaticMemory=async turnId=>{
      const pending=memoryRetries.get(account+':'+turnId);if(!pending)throw new Error('没有待重试的记忆保存。');
      return commitAutomatic(pending.spec,turnId,pending.followupId);
    };
    service.submitMvpMessage=async input=>{
      const owner=account,stamp=generation,d=requireAccount(),rev=d.revision,sc=input.scenario||scenario();
      const ctrl=new AbortController();pending.add(ctrl);
      const query=String(input.query||'').trim();if(!query||query.length>2000){pending.delete(ctrl);throw new Error('请输入1–2000字的问题。');}
      const check=()=>{if(owner!==account||stamp!==generation||ctrl.signal.aborted||rev!==d.revision)throw new DOMException('Aborted','AbortError');};
      try {
        await wait(Number(options.getDelay?.()??450),ctrl.signal);check();
        if(sc==='expired'){account='';generation++;const e=new Error('【模拟】登录已失效。');e.status=401;throw e;}
        if(['network','error','nonjson','busy'].includes(sc)){const e=new Error({network:'【模拟】消息未送达，请重试。',error:'【模拟】回复生成失败，问题仍保留。',nonjson:'【模拟】响应无法读取。',busy:'【模拟】上一轮仍在处理，请稍后重试。'}[sc]);if(sc==='busy')e.status=409;throw e;}
        const group=classify(query,input.group),restore=d.settings.allowUse?d.events.find(e=>e.id===(input.followupId||input.memoryId)):null;
        if(d.settings.allowUse&&input.followupId&&!restore)throw new Error('关联的模拟摘要已删除，请开启新对话。');
        const context={event:group,...(restore?{event:restore.title,date:restore.date}:{}),...(input.context||{})};
        const guide=input.guideId?guides.find(g=>g.guide_id===input.guideId):input.recommendationId?guides.find(g=>'mvp-rec-'+g.guide_id===input.recommendationId):/通知|专注|打断/.test(query)?guides[2]:/通勤/.test(query)?guides[1]:/搬家|租房|住房/.test(query)?guides[0]:null;
        const clarifying=sc==='clarification'&&!input.skipClarification;
        const message='【固定情境模拟】'+(clarifying?'这次是租房搬家，还是搬入自有住房？你也可以暂不补充，我会先给通用建议。':sc==='unsupported'?'当前演示资料不足以回答这个问题，不能给出确定建议。':sc==='web'?'【联网流程模拟】实际搜索尚未接入，没有检索到真实的最新网页；此处只演示等待与恢复流程。':guide?(guide.fields['说人话']||guide.title)+(input.skipClarification?'\n本次未补充条件，请结合实际情况判断适用性。':'\n具体情况尚未明确，可以继续补充影响选择的条件。'):'这是固定场景交互演示，没有调用真实模型。你可以从最想解决的一件事说起；任意问题的理解与回答需要后端接入。');
        const onChunk=input.onChunk||options.onChunk;
        if(onChunk)for(let end=18;end<message.length+18;end+=18){await wait(65,ctrl.signal);check();onChunk(message.slice(0,end));}
        check();
        const used=d.settings.allowUse?(restore?[clone(restore)]:d.events.filter(e=>e.title===group&&e.status!=='cancelled').map(clone)):[];
        let summary={saved:false,message:'【模拟】自动摘要已关闭，本轮未写入记忆。'};
        const explicit=explicitMemory({...input,query},context);
        // Fixed demo rules illustrate the summary lifecycle; they do not understand arbitrary input.
        const spec={...(explicit||{category:'会话摘要',eventType:'consultation-'+(guide?.guide_id||group),title:restore?.title||group,date:null,attributes:{housing:null,budget:null}}),status:/已解决|解决了/.test(query)?'resolved':'unresolved',problem:query,source:{conversationId:input.conversationId,messageId:input.turnId}};
        if(d.settings.allowSave){
          memoryRetries.set(owner+':'+input.turnId,{spec,followupId:input.followupId});
          if(sc==='summaryfail')summary={saved:false,retryable:true,message:'【模拟】回答已完成，摘要未保存，可单独重试。'};
          else try{summary=await commitAutomatic(spec,input.turnId,input.followupId);}catch(e){if(e.name==='AbortError')throw e;summary={saved:false,retryable:true,message:'回答已完成，记忆保存失败，可单独重试。'};}
        }
        if(owner!==account||stamp!==generation||ctrl.signal.aborted)throw new DOMException('Aborted','AbortError');
        return result({conversation_id:input.conversationId,group,context,result:{status:clarifying?'clarification':sc==='unsupported'?'unsupported':'answer',message,usedMemories:used,relatedGuide:!clarifying&&sc!=='unsupported'&&guide?clone(guide):null,cards:[]},summary});
      }finally{pending.delete(ctrl);}
    };
    return service;
  }
  root.createMockProduct=createMockProduct;
  if(typeof module!=='undefined')module.exports={createMockProduct};
})(typeof window!=='undefined'?window:globalThis);
