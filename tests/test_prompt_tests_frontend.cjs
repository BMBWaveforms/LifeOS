/* Workbench task navigation and owner-scoped prompt experiments. No model calls. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const root=path.resolve(__dirname,'..');

class Element {
  constructor(tag,document){this.tagName=tag.toUpperCase();this.document=document;this.children=[];this.parentNode=null;this.attributes={};this.dataset={};this.value='';this.hidden=false;this.disabled=false;this._text='';}
  set id(value){this.attributes.id=value;this.document.ids.set(value,this);}get id(){return this.attributes.id||'';}
  set className(value){this.attributes.class=value;}get className(){return this.attributes.class||'';}
  get classList(){const node=this;return {toggle(name,on){const set=new Set(node.className.split(' ').filter(Boolean));on?set.add(name):set.delete(name);node.className=[...set].join(' ');}};}
  set textContent(value){this.replaceChildren();this._text=String(value??'');}get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  append(...nodes){for(const n of nodes){if(n.parentNode)n.remove();n.parentNode=this;this.children.push(n);}}
  replaceChildren(...nodes){for(const n of this.children)n.parentNode=null;this.children=[];this._text='';this.append(...nodes);}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
  setAttribute(key,value){if(key==='id')this.id=value;else if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,s)=>s.toUpperCase())]=String(value);else this.attributes[key]=String(value);}
  getAttribute(key){return key.startsWith('data-')?this.dataset[key.slice(5).replace(/-([a-z])/g,(_,s)=>s.toUpperCase())]:this.attributes[key];}
  matches(selector){if(selector.includes(','))return selector.split(',').some(s=>this.matches(s.trim()));const id=selector.match(/^#([\w-]+)/);if(id&&this.id!==id[1])return false;const tag=selector.match(/^[a-z][\w-]*/i);if(tag&&this.tagName!==tag[0].toUpperCase())return false;const cls=selector.match(/\.([\w-]+)/);if(cls&&!this.className.split(' ').includes(cls[1]))return false;const attr=selector.match(/\[([\w-]+)(?:="([^"]*)")?\]/);if(attr){const val=this.getAttribute(attr[1]);if(val===undefined||attr[2]!==undefined&&val!==attr[2])return false;}return true;}
  querySelectorAll(selector){return this.children.flatMap(n=>[...(n.matches(selector)?[n]:[]),...n.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  get isConnected(){return this===this.document.body||!!this.parentNode?.isConnected;}
  click(){if(!this.disabled)return this.onclick?.({preventDefault(){},target:this});}
}
function dom(){
  const document={ids:new Map(),listeners:{},createElement(tag){return new Element(tag,this);},getElementById(id){const found=this.ids.get(id);return found?.isConnected?found:null;},querySelectorAll(selector){return this.body.querySelectorAll(selector);},addEventListener(name,listener){(this.listeners[name]??=[]).push(listener);},dispatchEvent(event){for(const listener of this.listeners[event.type]||[])listener(event);}};
  document.body=document.createElement('body');
  const html=fs.readFileSync(path.join(root,'frontend/workbench.html'),'utf8');
  for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="[^"]+"[^>]*)>/gi)){
    const n=document.createElement(match[1]);for(const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g))n.setAttribute(attr[1],attr[2]);n.hidden=/\bhidden\b/.test(match[2]);document.body.append(n);
  }
  return document;
}
const clone=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{for(let i=0;i<70;i++)await Promise.resolve();};
const moduleLabels={understanding:'理解问题',retrieval:'检索指南',reply:'组织回复',memory:'提取记忆',summary:'生成摘要',home:'首页回访',judge:'评测判定'};
function fixture(options={}){
  const document=dom(),calls=[],records=[];
  const modules=Object.entries(moduleLabels).map(([id,label])=>({id,label,description:'检查'+label+'的输出',production_boundary:'这是固定上游输入的独立实验，不等同生产分段。',input_example:{query:'用户原始问题',memories:[]},current_version_id:id+'-current',current_prompt:{version_id:id+'-current',content:'当前'+label+'提示词',sha256:'a'.repeat(64)},versions:[{id:id+'-current',content:'当前'+label+'提示词',hash:'a'.repeat(64),note:'当前版本',active:true},{id:id+'-older',content:'旧'+label+'提示词',hash:'b'.repeat(64),note:'之前版本'}]}));
  const versions=modules.flatMap(m=>m.versions.map(v=>({...v,module:m.id,author:'团队'})));
  const catalog={modules:moduleLabels,versions,bundles:[{id:'bundle-active',name:'产品组合',versions:Object.fromEntries(modules.map(m=>[m.id,m.current_version_id]))}],active_bundle_id:'bundle-active',activations:[]};
  const api=async(url,data)=>{
    calls.push({url,data:clone(data===undefined?null:data)});
    if(url==='/api/prompt-tests/catalog'){if(options.catalogFailure)throw Error('单环节接口暂不可用');return {modules:clone(modules)};}
    if(url==='/api/prompt-tests'&&!data)return {runs:clone(records)};
    if(url==='/api/prompt-tests'&&data){
      if(options.staleCurrent)throw Error('当前版本已变更，请刷新后重试。');
      if(options.pending)return options.pending;
      const module=modules.find(m=>m.id===data.module),failed=options.failed;
      const saved={id:'experiment-'+(records.length+1),module:data.module,status:failed?'failed':'success',execution_status:failed?'not_started':'succeeded',quality_verdict:'pending',elapsed_ms:123,created:12345,input:data.input,prompt:{source:data.prompt_mode,version_id:data.version_id||module.current_version_id,content:data.prompt||module.current_prompt.content,sha256:'c'.repeat(64),effective_content:'模块原文\n固定实验契约',effective_sha256:'d'.repeat(64)},output:{raw:'<img src=x onerror=alert(1)>',parsed:failed?null:{explicit_facts:['明确原文']}},validation:{status:failed?'failed':'passed',checks:[{name:'来源校验',passed:!failed}],errors:failed?['固定输入缺少必要字段']:[]},model_call:{attempted:!failed,succeeded:!failed}};
      records.unshift(saved);return clone(saved);
    }
    if(url.startsWith('/api/prompt-tests/'))return clone(records.find(r=>r.id===url.split('/').at(-1)));
    if(url==='/api/prompts')return clone(catalog);
    if(url.startsWith('/api/prompts/versions/'))return clone(versions.find(v=>v.id===url.split('/').at(-1)));
    if(url==='/api/eval/datasets')return {datasets:[]};
    if(url==='/api/eval/jobs')return {jobs:[]};
    throw Error('Unexpected API '+url);
  };
  class CustomEvent{constructor(type,options={}){this.type=type;this.detail=options.detail;}}
  const context=vm.createContext({document,api,CustomEvent,Event:CustomEvent,Blob,URL,setTimeout:()=>0,clearTimeout(){},sessions:{},controls(){},message(){},labels:{'claude-sdk':'SDK'}});
  vm.runInContext(fs.readFileSync(path.join(root,'frontend/prompt-tests.js'),'utf8'),context);
  if(options.navigation)vm.runInContext(fs.readFileSync(path.join(root,'frontend/evaluation.js'),'utf8'),context);
  const $=id=>document.getElementById(id);
  const login=()=>document.dispatchEvent(new CustomEvent('lifeos-login',{detail:{id:'alice',name:'测试者'}}));
  const logout=()=>document.dispatchEvent(new CustomEvent('lifeos-logout'));
  const clickText=async(parent,label)=>{const found=parent.querySelectorAll('button').find(n=>n.textContent===label);assert.ok(found,'button '+label);await found.click();await settle();return found;};
  const chooseModule=async id=>{const found=$('prompt-test').querySelectorAll('[data-pt-module]').find(n=>n.dataset.ptModule===id);await found.click();await settle();};
  const mode=value=>{$('pt-source').value=value;$('pt-source').onchange();};
  login();return {document,context,$,calls,records,login,logout,clickText,chooseModule,mode};
}

test('workbench defaults to single-stage experiments and retains all overall and version functions',async()=>{
  const f=fixture({navigation:true});await settle();
  assert.deepEqual(f.$('bench-tabs').children.map(n=>n.textContent),['单环节测试','整体测试','提示词管理']);
  assert.equal(f.$('prompt-test').hidden,false);assert.equal(f.$('overall-test').hidden,true);
  await f.clickText(f.$('bench-tabs'),'整体测试');assert.equal(f.$('overall-test').hidden,false);assert.equal(f.$('free-test').hidden,false);
  await f.clickText(f.$('overall-tabs'),'批量对比与结果');assert.equal(f.$('ev-jobs').hidden,false);assert.equal(f.$('free-test').hidden,true);
  await f.clickText(f.$('overall-tabs'),'评测集');assert.equal(f.$('ev-dataset').hidden,false);
  await f.clickText(f.$('bench-tabs'),'提示词管理');assert.equal(f.$('ev-prompt').hidden,false);
  assert.ok(f.$('ev-base-bundle'));assert.ok(f.$('ev-activation-note'));assert.ok(f.$('ev-diff-version'));
});

test('all seven prompt stages have independent editable upstream inputs and honest production boundary',async()=>{
  const f=fixture();await settle();assert.equal(f.$('prompt-test').querySelectorAll('[data-pt-module]').length,7);
  for(const module of Object.keys(moduleLabels)){await f.chooseModule(module);assert.match(f.$('prompt-test').textContent,/固定上游输入的独立实验/);assert.deepEqual(JSON.parse(f.$('pt-input').value),{query:'用户原始问题',memories:[]});}
});

test('current prompt is read only and running records exact input, output, hashes and validation',async()=>{
  const f=fixture();await settle();assert.equal(f.$('pt-prompt').readOnly,true);
  f.$('pt-input').value=JSON.stringify({query:'我自己填写的准确输入'});await f.$('pt-run').click();await settle();
  const submitted=f.calls.find(c=>c.url==='/api/prompt-tests'&&c.data);
  assert.deepEqual(submitted.data,{module:'understanding',prompt_mode:'current',input:{query:'我自己填写的准确输入'},version_id:'understanding-current'});
  assert.match(f.$('pt-result').textContent,/执行与校验完成/);assert.match(f.$('pt-result').textContent,/待人工判断/);
  assert.match(f.$('pt-result').textContent,/我自己填写的准确输入/);assert.match(f.$('pt-result').textContent,/cccccccccccc/);assert.match(f.$('pt-result').textContent,/固定实验契约/);
  assert.equal(f.$('pt-result').querySelectorAll('img').length,0);
});

test('draft changes stay local, survive stage switching, and never activate a product version',async()=>{
  const f=fixture();await settle();f.mode('draft');f.$('pt-prompt').value='我的临时草稿\n逐字保留';f.$('pt-prompt').oninput();f.$('pt-input').value='{"query":"草稿输入"}';
  await f.chooseModule('reply');await f.chooseModule('understanding');assert.equal(f.$('pt-prompt').value,'我的临时草稿\n逐字保留');assert.equal(f.$('pt-input').value,'{"query":"草稿输入"}');
  await f.$('pt-run').click();await settle();const run=f.calls.find(c=>c.url==='/api/prompt-tests'&&c.data);
  assert.equal(run.data.prompt_mode,'draft');assert.equal(run.data.prompt,'我的临时草稿\n逐字保留');
  assert.equal(f.calls.some(c=>c.url.includes('/activate')||c.url==='/api/prompts/versions'),false);
});

test('saved version sends its actual ID and never sends editable content as current',async()=>{
  const f=fixture();await settle();f.mode('version');f.$('pt-version').value='understanding-older';f.$('pt-version').onchange();
  assert.equal(f.$('pt-prompt').value,'旧理解问题提示词');assert.equal(f.$('pt-prompt').readOnly,true);
  await f.$('pt-run').click();await settle();const run=f.calls.find(c=>c.url==='/api/prompt-tests'&&c.data);
  assert.equal(run.data.version_id,'understanding-older');assert.equal(run.data.prompt_mode,'version');assert.equal(run.data.prompt,undefined);
});

test('invalid JSON never calls the model and preserves user input for correction',async()=>{
  const f=fixture();await settle();f.$('pt-input').value='{"query":';await f.$('pt-run').click();
  assert.match(f.$('pt-status').textContent,/本次尚未调用模型/);assert.equal(f.$('pt-input').value,'{"query":');
  assert.equal(f.calls.some(c=>c.url==='/api/prompt-tests'&&c.data),false);
});

test('persisted validation failure remains visibly failed rather than successful output',async()=>{
  const f=fixture({failed:true});await settle();await f.$('pt-run').click();await settle();
  assert.match(f.$('pt-result').textContent,/实验失败/);assert.match(f.$('pt-result').textContent,/固定输入缺少必要字段/);assert.match(f.$('pt-result').textContent,/未调用模型/);
  assert.doesNotMatch(f.$('pt-result').textContent,/执行与校验完成|结构与来源校验通过/);
  assert.match(f.$('pt-history').textContent,/理解 · 失败/);
});

test('pending experiment disables duplicate submission and late output cannot reappear after logout',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;});const f=fixture({pending});await settle();
  const run=f.$('pt-run').click();await settle();assert.equal(f.$('pt-run').disabled,true);f.$('pt-run').click();
  assert.equal(f.calls.filter(c=>c.url==='/api/prompt-tests'&&c.data).length,1);f.logout();
  resolve({id:'late',module:'understanding',status:'success',input:{private:'私人结果'},output:{raw:'私人结果'}});await run;await settle();
  assert.equal(f.$('prompt-test').textContent,'');
});

test('history inspection does not rerun a model and can prepare a draft without submitting',async()=>{
  const f=fixture();await settle();await f.$('pt-run').click();await settle();const before=f.calls.filter(c=>c.url==='/api/prompt-tests'&&c.data).length;
  await f.clickText(f.$('pt-history'),'查看这次实验');await f.clickText(f.$('pt-result'),'用这次输入继续试');
  assert.equal(f.$('pt-source').value,'draft');assert.equal(f.$('pt-prompt').readOnly,false);
  assert.equal(f.calls.filter(c=>c.url==='/api/prompt-tests'&&c.data).length,before);
});

test('catalog failure is recoverable without hiding overall navigation',async()=>{
  const f=fixture({catalogFailure:true,navigation:true});await settle();assert.match(f.$('prompt-test').textContent,/单环节测试暂未能读取/);
  assert.ok(f.$('bench-tabs'));await f.clickText(f.$('bench-tabs'),'整体测试');assert.equal(f.$('overall-test').hidden,false);
});

test('current mode pins displayed version and a concurrent activation is shown as a failed request',async()=>{
  const f=fixture({staleCurrent:true});await settle();f.$('pt-input').value='{"query":"保留这个输入"}';
  await f.$('pt-run').click();await settle();
  assert.equal(f.calls.find(c=>c.url==='/api/prompt-tests'&&c.data).data.version_id,'understanding-current');
  assert.match(f.$('pt-result').textContent,/本次请求未取得结果/);assert.match(f.$('pt-result').textContent,/当前版本已变更/);
  assert.doesNotMatch(f.$('pt-result').textContent,/执行与校验完成/);assert.equal(f.$('pt-input').value,'{"query":"保留这个输入"}');
  await f.clickText(f.$('prompt-test'),'刷新当前版本');assert.equal(f.$('pt-input').value,'{"query":"保留这个输入"}');
});
