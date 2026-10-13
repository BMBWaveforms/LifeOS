/* Static preview only. This file is never loaded by the real application. */
(() => {
  const key='gouhuo-static-preview-v1', sessionKey=key+'-account';
  const guide=window.PREVIEW_GUIDE, originalFetch=window.fetch.bind(window);
  const topic='手机通知打断工作';
  const now=()=>Math.floor(Date.now()/1000);
  const seed=()=>({alice:{enabled:true,memories:[{
    id:'preview-alice-1',text:'【虚构演示摘要】用户工作时被手机通知打断，咨询过减少通知的指南，尚未说明问题已解决。',
    user_state:'工作时被手机通知打断',problem:topic,problem_status:'unresolved',
    origin:'model_summary',state:'active',guides:[{guide_id:guide.guide_id,title:guide.title}],
    created:now(),updated:now()
  }]},bob:{enabled:true,memories:[]}});
  let data;
  try {data=JSON.parse(localStorage.getItem(key))||seed();} catch {data=seed();}
  if(!data.alice||!data.bob)data=seed();
  let account=sessionStorage.getItem(sessionKey)||'';
  const save=()=>localStorage.setItem(key,JSON.stringify(data));
  const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  const requireAccount=()=>{if(!data[account])throw Error('请先进入虚构演示账号。');return data[account]};
  const state=()=>{const d=requireAccount();return {enabled:d.enabled,memories:d.memories,effective:d.enabled?d.memories.filter(m=>m.state==='active'):[]}};
  const followups=()=>{const d=requireAccount();return d.enabled?d.memories.filter(m=>m.state==='active'&&m.problem&&m.problem_status!=='resolved').slice(-3).reverse():[]};
  const home=()=>({markdown:'暂无待回访问题。这里仅展示本浏览器中的模拟记录。',result:{followups:followups().map(m=>({
    memory_id:m.id,topic:m.problem,progress_question:'上次提到“'+m.problem+'”，现在解决了吗？',
    guide_question:'还需要继续咨询相关指南吗？',guides:m.guides||[]
  }))}});
  window.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.pathname!=='/health'&&!url.pathname.startsWith('/api/'))return originalFetch(input,options);
    let body={};
    try {
      if(options.body)body=JSON.parse(options.body);
      if(url.pathname==='/health')return reply({model:{configured:true,model:'static-preview-no-model'},backend:'browser-simulation'});
      if(url.pathname==='/api/login'){
        if(!['alice','bob'].includes(body.username)||body.password!=='preview')return reply({message:'静态演示账号为 alice 或 bob，口令为 preview。'},401);
        account=body.username;sessionStorage.setItem(sessionKey,account);
        return reply({user:{id:account,name:account==='alice'?'Alice（虚构预览）':'Bob（虚构预览）'}});
      }
      if(url.pathname==='/api/logout'){account='';sessionStorage.removeItem(sessionKey);return reply({ok:true})}
      requireAccount();
      if(url.pathname==='/api/me')return reply({user:{id:account,name:account==='alice'?'Alice（虚构预览）':'Bob（虚构预览）'}});
      if(url.pathname==='/api/memories')return reply(state());
      if(url.pathname==='/api/memory-action'){
        const d=requireAccount(),m=d.memories.find(m=>m.id===body.id);
        if(body.action==='settings')d.enabled=!!body.enabled;
        else if(body.action==='clear')d.memories=[];
        else if(body.action==='delete')d.memories=d.memories.filter(m=>m.id!==body.id);
        else if(body.action==='correct_summary'&&m){
          for(const field of ['problem','user_state','problem_status'])if(body[field]!==undefined)m[field]=body[field];
          m.text=body.text||m.text;m.updated=now();
        }else return reply({message:'模拟记录已不存在。'},400);
        save();return reply(state());
      }
      if(url.pathname==='/api/run'){
        if(body.mode==='home')return reply(home());
        if(body.mode!=='chat')return reply({message:'不支持的演示操作。'},400);
        const d=requireAccount(),q=String(body.query||'').trim();
        if(!q)return reply({message:'请输入问题，建议使用页面所示的手机通知案例。'},400);
        const parent=d.memories.find(m=>m.id===body.followup_memory_id&&m.state==='active');
        if(body.followup_memory_id&&!parent)return reply({message:'这条模拟回访已更新，请刷新后重试。'},400);
        const progress=parent&&(/暂时先帮我记录进展|的问题已经解决了/.test(q));
        const known=!!parent||/手机|通知/.test(q);
        const problem=parent?.problem||(known?topic:q.slice(0,80));
        const guides=parent?.guides||(known?[{guide_id:guide.guide_id,title:guide.title}]:[]);
        const status=progress&&q.includes('已经解决了')?'resolved':'unresolved';
        let markdown='【静态预览：没有调用模型】\n';
        if(progress)markdown+='仅模拟记录你点击的问题进展。';
        else if(known)markdown+='### '+guide.title+'\n'+guide.fields['说人话']+'\n成本：'+guide.fields['成本']+'\n证据等级：'+guide.fields['证据等级']+'\n限制：'+guide.fields['备注']+'\n['+guide.source_locator+']('+guide.source_url+')\n以上为固定指南示例，不是针对本轮输入生成的答案。';
        else markdown+='静态预览无法理解或检索这个问题。你可以用“工作时被手机通知打断”体验固定指南示例；真实问答请运行 Docker 版。';
        const summary={saved:false,message:'【静态预览】记忆已关闭，本轮不保存模拟记录。'};
        if(d.enabled){
          const previous=parent||d.memories.find(m=>m.problem===problem&&m.state==='active');
          if(previous)previous.state='superseded';
          const m={id:'preview-'+account+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7),
            text:'【前端模拟摘要，非模型生成】用户输入：'+q+'；演示进展：'+(status==='resolved'?'已解决':'尚未解决')+'。',
            user_state:progress?(parent.user_state||''):q,problem,problem_status:status,guides,
            state:'active',origin:'model_summary',created:now(),updated:now()};
          d.memories.push(m);save();summary.saved=true;summary.message='【静态预览】模拟摘要保存在当前浏览器；未调用模型或服务器。';
        }
        return reply({markdown:markdown+'\n\n'+summary.message,result:{status:progress?'acknowledged':known?'answer':'unsupported'},summary,conversation_id:'preview-conversation'});
      }
      return reply({message:'静态预览不支持这个接口。'},404);
    }catch(error){return reply({message:error.message},data[account]?400:401)}
  };
  for(const user of ['alice','bob'])document.getElementById('demo-'+user).onclick=()=>{
    document.getElementById('username').value=user;document.getElementById('password').value='preview';document.getElementById('loginform').requestSubmit();
  };
  document.getElementById('demo-reset').onclick=()=>{
    if(confirm('重置本浏览器的虚构演示记录？不会影响真实服务。')){
      localStorage.removeItem(key);sessionStorage.removeItem(sessionKey);location.reload();
    }
  };
})();
