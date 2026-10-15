/* Contract and state regressions. The DOM double checks product behavior, not layout. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '..');

class Node {
  constructor(tag, document) { this.tagName=tag.toUpperCase();this.document=document;this.children=[];this.parentNode=null;this.attributes={};this.dataset={};this.style={};this.value='';this.hidden=false;this.disabled=false;this._text='';this.scrollHeight=500;this.clientHeight=500;this.scrollTop=0;this.clientWidth=1200;this.offsetHeight=300;this.offsetWidth=225;this.listeners={}; }
  set id(value) {this.attributes.id=value;this.document.ids.set(value,this);} get id() {return this.attributes.id||'';}
  set className(value) {this.attributes.class=value;} get className() {return this.attributes.class||'';}
  get classList() {const node=this;return {contains:name=>node.className.split(' ').includes(name),add(...names){node.className=[...new Set([...node.className.split(' ').filter(Boolean),...names])].join(' ');},remove(...names){node.className=node.className.split(' ').filter(x=>!names.includes(x)).join(' ');},toggle(name,enabled){const on=enabled===undefined?!this.contains(name):enabled;on?this.add(name):this.remove(name);return on;}};}
  set textContent(value) {this.children=[];this._text=String(value??'');} get textContent() {return this._text+this.children.map(child=>child.textContent).join('');}
  append(...nodes) {for(let node of nodes){if(typeof node==='string')node=this.document.createTextNode(node);if(node.parentNode)node.remove();node.parentNode=this;this.children.push(node);}}
  replaceChildren(...nodes) {for(const child of this.children)child.parentNode=null;this.children=[];this._text='';this.append(...nodes);}
  remove() {if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}
  setAttribute(name,value) {value=String(value);if(name==='id')this.id=value;else if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;else this.attributes[name]=value;}
  getAttribute(name) {return name.startsWith('data-')?this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]:this.attributes[name];}
  matches(selector) {if(selector.includes(','))return selector.split(',').some(value=>this.matches(value.trim()));if(selector===':hover'||selector===':focus-visible')return false;const tag=selector.match(/^[a-z][\w-]*/i)?.[0];if(tag&&this.tagName!==tag.toUpperCase())return false;const classes=[...selector.matchAll(/\.([\w-]+)/g)].map(match=>match[1]);if(classes.some(cls=>!this.classList.contains(cls)))return false;const attr=selector.match(/\[([\w-]+)(?:="([^"]*)")?\]/);if(attr){const value=this.getAttribute(attr[1]);if(value===undefined||attr[2]!==undefined&&value!==attr[2])return false;}return true;}
  querySelectorAll(selector) {return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector) {return this.querySelectorAll(selector)[0]||null;}
  closest(selector) {return this.matches(selector)?this:this.parentNode?.closest(selector)||null;}
  contains(node) {return node===this||this.children.some(child=>child.contains(node));}
  addEventListener(name,fn) {(this.listeners[name]??=[]).push(fn);}
  focus() {this.document.activeElement=this;}
  click() {if(!this.disabled)return this.onclick?.({target:this,preventDefault(){}});}
  get isConnected() {return this===this.document.body||!!this.parentNode?.isConnected;}
  getClientRects() {return [{}];}
  showModal() {this.open=true;}
  close() {this.open=false;}
  cloneNode(deep) {const node=new Node(this.tagName,this.document);node.attributes={...this.attributes};node.dataset={...this.dataset};node._text=this._text;if(deep)node.append(...this.children.map(child=>child.cloneNode(true)));return node;}
  hasPointerCapture() {return false;}
}
function dom() {
  const document={ids:new Map(),listeners:{},createElement(tag){return new Node(tag,this);},createElementNS(ns,tag){return this.createElement(tag);},createTextNode(text){const node=new Node('#text',this);node.textContent=text;return node;},getElementById(id){return this.ids.get(id);},querySelectorAll(selector){return this.body.querySelectorAll(selector);},addEventListener(name,fn){this.listeners[name]=fn;}};
  document.body=document.createElement('body');document.activeElement=document.body;
  const html=fs.readFileSync(path.join(root,'frontend/index.html'),'utf8');
  for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="[^"]+"[^>]*)>/gi)){
    const node=document.createElement(match[1]);for(const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g))node.setAttribute(attr[1],attr[2]);node.hidden=/\bhidden\b/.test(match[2]);document.body.append(node);
  }
  for(const id of ['loginform','todayform','askform','view-today','view-agent','history-panel','modal-form']){const node=document.getElementById(id);if(id==='modal-form')document.getElementById('modal').append(node);}
  document.getElementById('view-today').append(document.getElementById('home'),document.getElementById('followups'));
  document.getElementById('modal-form').append(document.getElementById('modal-body'),document.getElementById('modal-actions'),document.getElementById('modal-close'));
  return document;
}
const guide={guide_id:'03-01',title:'关掉非必要通知',fields:{'说人话':'工作时把手机放到视线之外。','成本':'少量设置时间','备注':'按工作需要保留必要通知','证据等级':'B'},source_url:'https://github.com/eternity4719/HowToLiveBetter/blob/main/README.md',source_locator:'第3节第1条'};
const settle=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function fixture() {
  const document=dom(),calls=[],state={loggedIn:false,enabled:false,records:[],number:0,nextStatus:'answer',summaryFailure:false};
  const memory=()=>({enabled:state.enabled,memories:state.records,effective:state.enabled?state.records.filter(m=>m.state==='active'):[]});
  const request=async(url,data)=>{
    calls.push({url,data});
    if(url==='/api/me'){if(!state.loggedIn)throw Object.assign(Error('请登录'),{status:401});return {user:{id:'test10',name:'测试用户'}};}
    if(url==='/api/login'){state.loggedIn=true;return {user:{id:'test10',name:'测试用户'}};}
    if(url==='/api/memories')return memory();
    if(url.startsWith('/api/guide-entry'))return guide;
    if(url==='/api/memory-action'){
      if(data.action==='settings')state.enabled=data.enabled;
      if(data.action==='delete')state.records=state.records.filter(m=>m.id!==data.id);
      return memory();
    }
    if(url==='/api/run'&&data.mode==='home')return {result:{followups:memory().effective.filter(m=>m.problem_status!=='resolved').map(m=>({memory_id:m.id,topic:m.problem,progress_question:'上次的事情解决了吗？',guide_question:'还想继续咨询吗？'}))}};
    if(url==='/api/run'){
      let summary={saved:false,message:'记忆已关闭，本轮不保存摘要。'};
      if(state.enabled&&!state.summaryFailure){state.records=state.records.map(m=>({...m,state:'superseded'}));const id='memory-'+(++state.number);state.records.push({id,state:'active',problem:'手机通知打断工作',text:'用户咨询减少手机通知的指南。',problem_status:data.query.includes('已经解决')?'resolved':'unresolved'});summary={saved:true,message:'本轮摘要已保存。',memory_id:id};}
      if(state.summaryFailure)summary={saved:false,message:'摘要生成失败，未写入记忆；答复仍可查看。'};
      return {conversation_id:'server-conversation',result:{status:state.nextStatus,message:state.nextStatus==='clarification'?'你想改善工作还是学习时的专注？':'找到以下指南条目。',clarification:state.nextStatus==='clarification'?'你想改善工作还是学习时的专注？':'',cards:state.nextStatus==='clarification'?[]:[guide]},summary};
    }
    return {};
  };
  const window={LifeAPI:{request,abortAll(){}},addEventListener(){},dispatchEvent(){}};
  const context=vm.createContext({window,document,location:{hash:'#/today'},history:{replaceState(){}},navigator:{clipboard:{writeText:async()=>{}}},matchMedia:()=>({matches:true,addEventListener(){}}),AbortController,URL,Intl,Date,Math,performance:{now:()=>0},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout:()=>1,clearTimeout(){},Event:class {}});
  for(const name of ['ui.js','services.js','scenes.js','app.js'])vm.runInContext(fs.readFileSync(path.join(root,'frontend',name),'utf8'),context,{filename:name});
  const $=id=>document.getElementById(id);
  const clickText=async(box,text)=>{const node=box.querySelectorAll('button').find(node=>node.textContent===text);assert.ok(node,`button ${text}`);await node.click();await settle();return node;};
  const submit=async(id)=>{const button={askform:'ask',todayform:'today-send',loginform:'login-submit'}[id];if(button)assert.equal($(button).disabled,false,`${button} must be reachable before submitting`);$(id).onsubmit({preventDefault(){}});await settle();};
  const fill=(id,value)=>{$(id).value=value;$(id).oninput?.();};
  const chats=()=>calls.filter(call=>call.url==='/api/run'&&call.data.mode==='chat');
  return {window,document,state,calls,$,clickText,submit,chats,fill};
}

test('real API adapter submits the selected fixed guide without trusting display copy',async()=>{
  const calls=[],window={};vm.runInNewContext(fs.readFileSync(path.join(root,'frontend/services.js'),'utf8'),{window});
  await window.RealProduct({request:async(url,data)=>{calls.push({url,data});}}).submitMessage({query:'我的原始问题',guideId:'03-01',conversationId:'c',followupId:'m',guideTitle:'不应上传'});
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{url:'/api/run',data:{mode:'chat',query:'我的原始问题',conversation_id:'c',followup_memory_id:'m',guide_id:'03-01'}});
});

test('anonymous fixed entry stays editable through login and sends only after user submission',async()=>{
  const f=fixture();await settle();
  const cards=f.$('home').querySelectorAll('.radar-card[data-recommendation]');assert.equal(cards.length,8);assert.equal(cards[2].querySelector('button').disabled,false);
  cards[2].querySelector('button').click();assert.match(f.$('query').value,/手机/);assert.equal(f.$('ask').disabled,false,'anonymous draft can open login through send');assert.equal(f.chats().length,0);
  f.fill('query','这是我改过的专注问题');f.$('query').oninput();await f.submit('askform');assert.equal(f.$('login').hidden,false);
  f.$('username').value='test10';f.$('password').value='test';await f.submit('loginform');
  assert.equal(f.$('query').value,'这是我改过的专注问题');assert.equal(f.chats().length,0);assert.equal(f.calls.some(c=>c.url==='/api/memory-action'),false);
  await f.submit('askform');assert.equal(f.chats()[0].data.query,'这是我改过的专注问题');assert.equal(f.chats()[0].data.guide_id,'03-01');assert.match(f.$('chat').textContent,/工作时把手机放到视线之外/);
  await f.clickText(f.$('chat'),'查看指南详情');assert.ok(f.calls.some(c=>c.url==='/api/guide-entry?guide_id=03-01'));assert.equal(f.$('modal-title').textContent,guide.title);
});

test('enabled summaries replace followup IDs, resolved progress leaves followups, and disabling clears association',async()=>{
  const f=fixture();await settle();f.fill('today-query','手机通知太多');await f.submit('todayform');await f.submit('loginform');assert.equal(f.$('today-query').value,'手机通知太多');
  await f.$('profile-entry').click();await settle();const toggle=f.$('memory-enabled');assert.equal(toggle.checked,false);toggle.checked=true;await toggle.onchange();await settle();assert.equal(f.state.enabled,true);f.$('modal-close').click();
  await f.submit('todayform');assert.equal(f.$('followups').querySelectorAll('.followup-card').length,1);
  f.fill('query','还有什么限制？');await f.submit('askform');assert.equal(f.chats()[1].data.followup_memory_id,'memory-1');
  await f.clickText(f.$('followups'),'已经解决');assert.equal(f.chats()[2].data.followup_memory_id,'memory-2');assert.equal(f.$('followups').querySelectorAll('.followup-card').length,0);
  await f.$('profile-entry').click();await settle();const off=f.$('memory-enabled');off.checked=false;await off.onchange();await settle();assert.match(f.$('modal-body').textContent,/用户咨询减少手机通知/);f.$('modal-close').click();
  f.fill('query','我想再了解一下');await f.submit('askform');assert.equal(f.chats().at(-1).data.followup_memory_id,'');assert.equal(f.chats().at(-1).data.conversation_id,'');
});

test('arbitrary clarification has no unrelated choices and summary failure keeps the valid answer',async()=>{
  const f=fixture();await settle();f.state.loggedIn=true;await f.submit('loginform');f.state.nextStatus='clarification';f.fill('query','我想专注');await f.submit('askform');assert.match(f.$('chat').textContent,/工作还是学习/);assert.doesNotMatch(f.$('chat').textContent,/租房搬家|自有住房/);
  f.state.nextStatus='answer';f.state.summaryFailure=true;f.state.enabled=true;await f.$('profile-entry').click();await settle();f.$('modal-close').click();f.fill('query','工作时');await f.submit('askform');assert.match(f.$('chat').textContent,/工作时把手机放到视线之外/);assert.match(f.$('chat').textContent,/未写入记忆/);assert.equal(f.$('chat').querySelectorAll('.summary-note.error').length,1);
});


test('deleting a saved summary clears its linked conversation and refreshes the progress cards',async()=>{
  const f=fixture();await settle();await f.submit('loginform');
  await f.$('profile-entry').click();await settle();const on=f.$('memory-enabled');on.checked=true;await on.onchange();await settle();f.$('modal-close').click();
  f.fill('query','工作时被手机打断');await f.submit('askform');assert.equal(f.$('followups').querySelectorAll('.followup-card').length,1);
  await f.$('profile-entry').click();await settle();await f.clickText(f.$('modal-body'),'删除');await f.clickText(f.$('modal-actions'),'确认删除');
  assert.equal(f.$('followups').querySelectorAll('.followup-card').length,0);assert.equal(f.state.records.length,0);f.$('modal-close').click();
  f.fill('query','我想继续了解');await f.submit('askform');assert.equal(f.chats().at(-1).data.followup_memory_id,'');assert.equal(f.chats().at(-1).data.conversation_id,'');
});

test('the eight fixed starters point to current canonical guides and bundled images',()=>{
  const window={};vm.runInNewContext(fs.readFileSync(path.join(root,'frontend/scenes.js'),'utf8'),{window});
  const entries=new Map(JSON.parse(fs.readFileSync(path.join(root,'data/guide.json'),'utf8')).entries.map(entry=>[entry.guide_id,entry]));
  assert.equal(window.LifeScenes.length,8);assert.equal(new Set(window.LifeScenes.map(scene=>scene.id)).size,8);
  for(const scene of window.LifeScenes){assert.equal(scene.guide_title,entries.get(scene.guide_id)?.title);assert.ok(fs.existsSync(path.join(root,'frontend',scene.image)));assert.ok(scene.draft.length>0&&scene.draft.length<=2000);}
});
