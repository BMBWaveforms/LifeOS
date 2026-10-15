'use strict';
// Experiments are owner-scoped; all model and user content stays plain text.
const PromptTests = (() => {
  let generation = 0, account = null, catalog = null, selected = 'understanding';
  let busy = false, drafts = {}, lastRecord = null;
  const q = id => document.getElementById(id);
  const box = () => q('prompt-test');
  const labels = {understanding:'理解',retrieval:'检索',reply:'回复',memory:'记忆',summary:'摘要',home:'首页',judge:'判定'};
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const add = (parent, tag, text, cls) => {const n=node(tag,text,cls);parent.append(n);return n;};
  function button(parent, text, action, cls) {
    const n=add(parent,'button',text,cls);n.type='button';
    n.onclick=()=>protect(action);return n;
  }
  function field(parent, label, id, tag='textarea') {
    const l=add(parent,'label',label);l.htmlFor=id;
    const n=add(parent,tag);n.id=id;return n;
  }
  function select(parent, label, id, choices, value) {
    const n=field(parent,label,id,'select');
    for(const [key,text] of choices){const item=add(n,'option',text);item.value=key;}
    n.value=value;return n;
  }
  function detail(parent, label, value, open=false) {
    const n=add(parent,'details');n.open=open;add(n,'summary',label);
    add(n,'pre',typeof value==='string'?value:JSON.stringify(value,null,2));return n;
  }
  const currentModule = () => catalog.modules.find(item=>item.id===selected);
  const text = value => typeof value==='string'?value:JSON.stringify(value,null,2);
  const stamp = value => Number.isFinite(Number(value))?new Date(Number(value)*1000).toLocaleString():'时间未提供';
  const duration = value => Number.isFinite(Number(value))?(Number(value)/1000).toFixed(2)+' 秒':'耗时未提供';
  function notice(message, error=false) {
    if(q('pt-status')){q('pt-status').textContent=message;q('pt-status').className=error?'error':'';}
  }
  async function request(path, data) {
    const version=generation,result=await api(path,data);
    if(version!==generation||!account)throw Error('账号已变更，请重新操作。');
    return result;
  }
  async function protect(action) {
    const version=generation;
    try{await action();}catch(error){if(version===generation)notice(error.message,true);}
  }
  function capture() {
    const state=drafts[selected];
    if(!state||!q('pt-input'))return;
    state.input=q('pt-input').value;
    state.mode=q('pt-source').value;
    state.version=q('pt-version').value;
    if(state.mode==='draft')state.draft=q('pt-prompt').value;
  }
  function formState(module) {
    if(!drafts[module.id])drafts[module.id]={mode:'current',version:module.current_version_id,
      draft:module.current_prompt?.content||'',input:JSON.stringify(module.input_example||{},null,2)};
    return drafts[module.id];
  }
  function updatePrompt() {
    const module=currentModule(),state=drafts[selected],mode=q('pt-source').value;
    state.mode=mode;
    const saved=(module.versions||[]).find(item=>item.id===q('pt-version').value);
    q('pt-prompt').value=mode==='draft'?state.draft:
      mode==='current'?(module.current_prompt?.content||''):(saved?.content||'');
    q('pt-prompt').readOnly=mode!=='draft';
    q('pt-version').disabled=busy||mode!=='version';
    q('pt-prompt-help').textContent=mode==='draft'?
      '只用于这次实验。运行不会保存版本，也不会启用到产品。':
      '已保存版本只读；需要改动时切换为“临时草稿”。';
    q('pt-prompt').classList.toggle('read-only',mode!=='draft');
  }
  function controls() {
    if(!box())return;
    for(const control of box().querySelectorAll('button,input,textarea,select'))control.disabled=busy;
    if(q('pt-version'))q('pt-version').disabled=busy||q('pt-source').value!=='version';
    if(q('pt-run'))q('pt-run').textContent=busy?'正在运行独立实验…':'运行单环节测试';
  }
  function render() {
    box().replaceChildren();
    const intro=add(box(),'section',undefined,'prompt-intro');
    add(intro,'span','固定输入 · 独立实验','eyebrow');
    add(intro,'h2','单独检查一段提示词');
    add(intro,'p','选择一个环节，固定它收到的上游内容，再比较提示词的实际输出。');
    add(intro,'small','独立实验不能证明整条流程通过。理解、检索、回复在产品中共用一次问答；记忆与摘要共用一次整理。');
    const status=add(box(),'p');status.id='pt-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const layout=add(box(),'div',undefined,'prompt-layout');
    const menu=add(layout,'aside',undefined,'prompt-module-menu');
    add(menu,'h3','选择环节');
    for(const module of catalog.modules){
      const b=button(menu,labels[module.id]||module.label,async()=>{if(busy)return;capture();selected=module.id;render();await refreshHistory();},'module-choice');
      b.dataset.ptModule=module.id;b.setAttribute('aria-pressed',String(module.id===selected));
      add(b,'small',module.label);
    }
    const main=add(layout,'div',undefined,'prompt-editor-column');
    const module=currentModule(),state=formState(module);
    const setup=add(main,'section',undefined,'prompt-editor');
    add(setup,'h2',module.label+'提示词');add(setup,'p',module.description,'muted');
    add(setup,'p',module.production_boundary,'boundary-note');
    button(setup,'刷新当前版本',refreshCatalog);
    const sources=add(setup,'div',undefined,'split');
    select(sources,'提示词来源','pt-source',[
      ['current','产品当前版本'],['version','已保存的其他版本'],['draft','临时草稿'],
    ],state.mode).onchange=()=>{state.draft=q('pt-prompt').readOnly?state.draft:q('pt-prompt').value;updatePrompt();};
    select(sources,'已保存版本','pt-version',(module.versions||[]).map(item=>[
      item.id,(item.active?'当前 · ':'')+(item.note||item.id.slice(0,8))+' · '+(item.hash||item.sha256||'').slice(0,8),
    ]),state.version).onchange=()=>{state.version=q('pt-version').value;updatePrompt();};
    const prompt=field(setup,'本次要测试的提示词','pt-prompt');prompt.className='code prompt-code';prompt.maxLength=24000;
    prompt.oninput=()=>{if(q('pt-source').value==='draft')state.draft=prompt.value;};
    add(setup,'small').id='pt-prompt-help';
    const upstream=add(main,'section',undefined,'prompt-input');
    const bar=add(upstream,'div',undefined,'row');add(bar,'h2','固定上游输入');
    button(bar,'填入示例',()=>{q('pt-input').value=JSON.stringify(module.input_example||{},null,2);capture();notice('已填入本环节的示例，可按实际场景修改。');});
    add(upstream,'p','这里填写这一环节实际能看到的内容。保持输入一致，才能判断提示词改动带来的差别。','muted');
    const input=field(upstream,'输入内容（JSON 对象）','pt-input');input.className='code';input.value=state.input;input.maxLength=100000;input.oninput=capture;
    const actions=add(upstream,'div',undefined,'form-actions');button(actions,'运行单环节测试',run,'primary').id='pt-run';
    button(actions,'管理版本与组合',()=>document.dispatchEvent(new CustomEvent('lifeos-bench-navigate',{detail:'prompt'})));
    add(upstream,'small','运行会调用模型并保存当前账号的实验记录；不修改产品记忆或产品启用版本。');
    const output=add(main,'section',undefined,'prompt-output');output.id='pt-result';output.setAttribute('aria-live','polite');
    if(lastRecord)renderResult(lastRecord);else{add(output,'span','等待实验','eyebrow');add(output,'h2','输出与校验');add(output,'p','运行后在这里查看模型输出、准确输入、提示词版本和校验依据。','empty');}
    const history=add(layout,'aside',undefined,'prompt-history');
    const heading=add(history,'div',undefined,'row');add(heading,'h3','我的实验记录');button(heading,'刷新',refreshHistory);
    add(history,'small','仅当前账号可见。查看记录不会再次调用模型。');add(history,'div').id='pt-history';
    updatePrompt();controls();
  }
  function renderResult(record) {
    const target=q('pt-result');if(!target)return;target.replaceChildren();
    const success=record.status==='success';
    const head=add(target,'div',undefined,'row');add(head,'h2',(labels[record.module]||record.module)+' · 实验结果');
    add(head,'span',success?'执行与校验完成':'实验失败',success?'badge verdict-pass':'badge verdict-fail');
    add(target,'p','回答效果：待人工判断。独立实验结果不等同整体流程验收。','boundary-note');
    add(target,'small',stamp(record.created)+' · '+duration(record.elapsed_ms)+' · '+
      (record.model_call?.attempted===false?'未调用模型':record.model_call?.succeeded?'模型已返回':'模型调用未确认成功'));
    if(record.message)add(target,'p',record.message,success?'muted':'error');
    add(target,'h3','本次输出');
    add(target,'pre',record.output?.parsed!==undefined&&record.output?.parsed!==null?
      text(record.output.parsed):(record.output?.raw||'没有可展示的输出。'));
    const validation=record.validation||{status:'not_run'};
    const validationLabels={passed:'本环节约束校验通过',failed:'校验失败',not_run:'未执行校验'};
    add(target,'h3',validationLabels[validation.status]||'校验状态未知');
    for(const error of validation.errors||[])add(target,'p',typeof error==='string'?error:text(error),'error');
    detail(target,'查看校验依据',validation);
    detail(target,'本次实际输入',record.input,true);
    detail(target,'模型实际收到的内容',record.transport_input??record.model_input??record.input);
    detail(target,'本次提示词与版本',{
      source:record.prompt?.source,version_id:record.prompt?.version_id||'临时草稿',
      sha256:record.prompt?.sha256,content:record.prompt?.content,
      effective_sha256:record.prompt?.effective_sha256,effective_content:record.prompt?.effective_content,
    });
    detail(target,'原始模型输出',record.output?.raw||'');
    detail(target,'完整实验记录',record);
    button(target,'用这次输入继续试',async()=>{
      capture();selected=record.module;
      const module=currentModule();if(!module)throw Error('此记录的模块当前不可用。');
      const state=formState(module);state.input=JSON.stringify(record.input||{},null,2);
      state.mode='draft';state.draft=record.prompt?.content||'';render();await refreshHistory();
      notice('已载入原输入和提示词草稿，点击运行后才会发起新实验。');
    });
  }
  async function refreshHistory() {
    const data=await request('/api/prompt-tests');
    const list=q('pt-history');if(!list)return;list.replaceChildren();
    if(!data.runs?.length){add(list,'p','还没有单环节实验记录。','empty');return;}
    for(const record of data.runs.slice(0,30)){
      const row=add(list,'div',undefined,'history-item');
      add(row,'strong',(labels[record.module]||record.module)+' · '+(record.status==='success'?'完成':'失败'));
      add(row,'small',stamp(record.created)+' · '+duration(record.elapsed_ms));
      button(row,'查看这次实验',async()=>{lastRecord=await request('/api/prompt-tests/'+encodeURIComponent(record.id));renderResult(lastRecord);});
    }
  }
  async function refreshCatalog() {
    if(busy)return;capture();const version=generation;busy=true;controls();
    try{
      const fresh=await request('/api/prompt-tests/catalog');if(version!==generation)return;
      if(!Array.isArray(fresh.modules)||!fresh.modules.length)throw Error('目前没有可用的测试环节。');
      catalog=fresh;
      for(const module of catalog.modules)if(drafts[module.id]?.mode==='current')drafts[module.id].version=module.current_version_id;
      render();await refreshHistory();notice('已刷新产品当前版本；临时草稿与固定输入已保留。');
    }finally{if(version===generation){busy=false;controls();}}
  }
  async function run() {
    if(busy)return;capture();
    let input;
    try{input=JSON.parse(q('pt-input').value);}catch{notice('输入格式有误，请检查 JSON 的括号、引号和逗号。本次尚未调用模型。',true);return;}
    if(!input||typeof input!=='object'||Array.isArray(input)){notice('输入需要是 JSON 对象。本次尚未调用模型。',true);return;}
    const state=drafts[selected],payload={module:selected,prompt_mode:state.mode,input};
    if(state.mode==='draft'){
      if(!q('pt-prompt').value.trim()){notice('请填写要测试的提示词草稿。',true);return;}
      payload.prompt=q('pt-prompt').value;
    }else if(state.mode==='version')payload.version_id=q('pt-version').value;
    else payload.version_id=currentModule().current_version_id;
    const version=generation;busy=true;lastRecord=null;controls();notice('正在运行独立实验，输入和提示词保持固定…');
    q('pt-result').replaceChildren();add(q('pt-result'),'h2','正在运行独立实验…');
    try{
      lastRecord=await request('/api/prompt-tests',payload);if(version!==generation)return;
      renderResult(lastRecord);notice(lastRecord.status==='success'?'执行与校验完成；请继续检查实际效果。':'本次实验失败，失败记录已保留，请查看原因。',lastRecord.status!=='success');
      try{await refreshHistory();}catch(error){if(version===generation)notice('实验结果已显示，记录列表暂未能刷新：'+error.message,true);}
    }catch(error){if(version===generation){
      notice(error.message,true);q('pt-result').replaceChildren();
      add(q('pt-result'),'h2','本次请求未取得结果');add(q('pt-result'),'p',error.message,'error');
      add(q('pt-result'),'p','原输入已保留。可刷新实验记录确认本次状态，再决定是否重试。','muted');
      detail(q('pt-result'),'本次提交的内容',payload);
    }}
    finally{if(version===generation){busy=false;controls();}}
  }
  async function enter(user) {
    const version=++generation;account=user;busy=false;drafts={};lastRecord=null;
    box().replaceChildren();const loading=add(box(),'section');add(loading,'h2','正在读取单环节测试…');
    try{
      catalog=await request('/api/prompt-tests/catalog');if(version!==generation)return;
      if(!Array.isArray(catalog.modules)||!catalog.modules.length)throw Error('目前没有可用的测试环节。');
      if(!catalog.modules.some(item=>item.id===selected))selected=catalog.modules[0].id;
      render();await refreshHistory();
    }catch(error){
      if(version!==generation)return;
      if(q('pt-status'))notice(error.message,true);
      else{box().replaceChildren();const failed=add(box(),'section');add(failed,'h2','单环节测试暂未能读取');add(failed,'p',error.message,'error');button(failed,'重试读取',()=>enter(user));}
    }
  }
  function stop() {generation++;account=null;busy=false;catalog=null;drafts={};lastRecord=null;box()?.replaceChildren();}
  return {enter,stop};
})();
document.addEventListener('lifeos-login',event=>PromptTests.enter(event.detail));
document.addEventListener('lifeos-logout',()=>PromptTests.stop());
