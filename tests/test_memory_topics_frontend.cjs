/* Topic memory interactions. The DOM double checks user actions and submitted IDs, not layout. */
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
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const clone=value=>JSON.parse(JSON.stringify(value));
const source=(id,query,state='active')=>({id,query,text:'当次摘要：'+query,created:'2026-10-15T08:00:00Z',state,guide_ids:['03-01']});
const topic=(id,title,sources,extra={})=>({id,title,text:title+'的主题摘要',problem_status:'unresolved',current_memory_id:sources.at(-1)?.id,source_count:sources.length,sources,consolidation:{status:'ready'},...extra});
function fixture(initial={}) {
  const document=dom(),calls=[],state={enabled:true,topics:[],records:[],memoryFailures:0,deleteFailures:0,...initial};
  const memory=()=>clone({enabled:state.enabled,memories:state.records,effective:state.enabled?state.records.filter(record=>record.state==='active'):[],...(state.topics===undefined?{}:{topics:state.topics})});
  const request=async(url,data)=>{
    calls.push({url,data});
    if(url==='/api/me')return {user:{id:'topic-test',name:'主题记忆测试'}};
    if(url==='/api/memories'){if(state.memoryFailures>0){state.memoryFailures--;throw Object.assign(Error('档案读取失败'),{status:502});}return memory();}
    if(url==='/api/memory-action'){
      if(state.deleteFailures>0){state.deleteFailures--;throw Object.assign(Error('删除暂时失败'),{status:502});}
      if(data.action==='settings')state.enabled=data.enabled;
      if(data.action==='delete_topic'){
        const deleted=state.topics.find(item=>item.id===data.id),ids=new Set((deleted?.sources||[]).map(item=>item.id));
        state.topics=state.topics.filter(item=>item.id!==data.id);state.records=state.records.filter(item=>!ids.has(item.id));
      }
      if(data.action==='delete'){
        state.records=state.records.filter(item=>item.id!==data.id);
        if(state.topics)state.topics=state.topics.map(item=>{
          if(!item.sources.some(record=>record.id===data.id))return item;
          const sources=item.sources.filter(record=>record.id!==data.id);
          return {...item,sources,source_count:sources.length,current_memory_id:sources.at(-1)?.id||'',text:'已重新整理：'+sources.map(record=>record.query).join('；')};
        }).filter(item=>item.sources.length);
      }
      return memory();
    }
    if(url==='/api/run'&&data.mode==='home')return {result:{followups:memory().effective.map(record=>({memory_id:record.id,topic:record.problem||'搬家',progress_question:'后来怎么样？',guide_question:'继续咨询吗？'}))}};
    if(url==='/api/run')return {conversation_id:data.conversation_id,result:{status:'acknowledged',message:'本轮答复。',cards:[]},summary:{saved:false,message:'本次未保存新摘要。'}};
    return {};
  };
  const window={LifeAPI:{request,abortAll(){}},addEventListener(){},dispatchEvent(){}};
  const context=vm.createContext({window,document,location:{hash:'#/today'},history:{replaceState(){}},navigator:{clipboard:{writeText:async()=>{}}},matchMedia:()=>({matches:true,addEventListener(){}}),AbortController,URL,Intl,Date,Math,performance:{now:()=>0},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout:()=>1,clearTimeout(){},Event:class {}});
  for(const name of ['ui.js','services.js','scenes.js','app.js'])vm.runInContext(fs.readFileSync(path.join(root,'frontend',name),'utf8'),context,{filename:name});
  const $=id=>document.getElementById(id);
  const clickText=async(box,text)=>{const node=box.querySelectorAll('button').find(item=>item.textContent===text);assert.ok(node,`button ${text}`);assert.equal(node.disabled,false);await node.click();await settle();return node;};
  const openProfile=async()=>{await $('profile-entry').click();await settle();};
  const fill=(id,value)=>{$(id).value=value;$(id).oninput?.();};
  const send=async query=>{fill('query',query);assert.equal($('ask').disabled,false);$('askform').onsubmit({preventDefault(){}});await settle();};
  const chats=()=>calls.filter(call=>call.url==='/api/run'&&call.data.mode==='chat');
  const mutations=()=>calls.filter(call=>call.url==='/api/memory-action');
  return {document,state,calls,$,clickText,openProfile,fill,send,chats,mutations};
}

test('profile groups memory by topic and keeps exact source expressions inside collapsed details',async()=>{
  const old=source('source-old','我之前的预算是 3500。','superseded'),latest=source('source-new','<img src=x onerror=alert(1)>现在预算调整为 5000。');
  const f=fixture({topics:[topic('topic-moving','搬家',[old,latest])],records:[old,latest]});await settle();await f.openProfile();
  const cards=f.$('modal-body').querySelectorAll('.memory-topic');assert.equal(cards.length,1);assert.equal(cards[0].dataset.topicId,'topic-moving');
  assert.match(cards[0].textContent,/搬家的主题摘要/);assert.equal(cards[0].querySelectorAll('h3').length,1);
  const details=cards[0].querySelector('details');assert.ok(!details.open);assert.equal(details.querySelector('summary').textContent,'查看来源记录（2 条）');
  details.open=true;assert.equal(details.querySelectorAll('.memory-source').length,2);
  assert.equal(details.querySelectorAll('.memory-source-query')[1].textContent,latest.query);assert.equal(details.querySelectorAll('img').length,0);
  assert.match(details.textContent,/当时说的/);assert.match(details.textContent,/当次摘要/);
});

test('continuing a topic submits its current memory ID and never submits the topic ID',async()=>{
  const latest=source('source-current','现在正在考虑搬家。');
  const f=fixture({topics:[topic('topic-moving','搬家',[latest])],records:[latest]});await settle();await f.openProfile();
  await f.clickText(f.$('modal-body'),'继续聊');assert.equal(f.$('query').value,'关于“搬家”，我想继续咨询。');await f.send('继续帮我看看通勤问题。');
  assert.equal(f.chats().at(-1).data.followup_memory_id,'source-current');assert.notEqual(f.chats().at(-1).data.followup_memory_id,'topic-moving');
});

test('source dates display Unix seconds and milliseconds as the same date',async()=>{
  const timestamp=Date.parse('2026-10-15T08:00:00Z'),seconds={...source('source-seconds','秒级时间'),created:timestamp/1000},milliseconds={...source('source-milliseconds','毫秒级时间'),created:timestamp};
  const f=fixture({topics:[topic('topic-moving','搬家',[seconds,milliseconds])],records:[seconds,milliseconds]});await settle();await f.openProfile();
  const dates=f.$('modal-body').querySelectorAll('.memory-source-time');assert.equal(dates.length,2);assert.equal(dates[0].textContent,dates[1].textContent);
  assert.match(dates[0].textContent,/2026/);assert.doesNotMatch(dates[0].textContent,/1970/);
});

test('structured topic excerpts show their quotes with friendly dates instead of raw fallback timestamps',async()=>{
  const saved=source('source-latest','现在预算是 5000。'),timestamp=Date.parse('2026-10-15T08:00:00Z');
  const f=fixture({topics:[topic('topic-moving','搬家',[saved],{text:'[2026-10-15T08:00:00Z]不应展示的旧拼接正文',excerpts:[{source_id:saved.id,quote:'现在预算是 5000。',created:timestamp/1000},{source_id:'source-earlier',quote:'还要考虑通勤时间。',created:'2026-10-14T08:00:00Z'}]})],records:[saved]});await settle();await f.openProfile();
  const card=f.$('modal-body').querySelector('.memory-topic'),excerpts=card.querySelectorAll('.memory-excerpt');assert.equal(excerpts.length,2);
  assert.equal(excerpts[0].querySelector('.memory-summary').textContent,'现在预算是 5000。');assert.equal(excerpts[1].querySelector('.memory-summary').textContent,'还要考虑通勤时间。');
  assert.equal(excerpts[0].querySelector('.memory-excerpt-time').textContent,new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(timestamp)));
  assert.match(excerpts[1].querySelector('.memory-excerpt-time').textContent,/2026/);assert.doesNotMatch(card.textContent,/T08:00:00Z|旧拼接正文/);
});

test('a source whose safe summary is its original expression does not repeat the expression',async()=>{
  const query='刚才明确说的预算是 5000。',saved={...source('source-first',query),text:query};
  const f=fixture({topics:[topic('topic-moving','搬家',[saved])],records:[saved]});await settle();await f.openProfile();
  const record=f.$('modal-body').querySelector('.memory-source');assert.equal(record.textContent.split(query).length-1,1);
  assert.match(record.textContent,/当时说的/);assert.doesNotMatch(record.textContent,/当次摘要/);
});

test('a topic with only superseded sources stays readable without offering continue',async()=>{
  const old=source('source-old','之前说过的事实','superseded');const f=fixture({topics:[topic('topic-moving','搬家',[old],{current_memory_id:''})],records:[old]});await settle();await f.openProfile();
  assert.equal(f.$('modal-body').querySelectorAll('.memory-source').length,1);assert.match(f.$('modal-body').textContent,/之前说过的事实/);
  assert.equal(f.$('modal-body').querySelectorAll('button').some(item=>item.textContent==='继续聊'),false);
});

test('deleting one source refreshes the topic and retains other sources',async()=>{
  const old=source('source-old','旧预算是 3500。','superseded'),latest=source('source-new','新预算是 5000。');
  const f=fixture({topics:[topic('topic-moving','搬家',[old,latest])],records:[old,latest]});await settle();await f.openProfile();
  await f.clickText(f.$('modal-body').querySelector('.memory-source'),'删除记录');assert.equal(f.$('modal-title').textContent,'删除这条来源记录？');
  await f.clickText(f.$('modal-actions'),'确认删除');assert.deepEqual(clone(f.mutations()[0].data),{action:'delete',id:'source-old'});
  assert.equal(f.$('modal-body').querySelectorAll('.memory-source').length,1);assert.doesNotMatch(f.$('modal-body').textContent,/旧预算是 3500/);
  assert.match(f.$('modal-body').textContent,/已重新整理：新预算是 5000/);assert.equal(f.$('modal-body').querySelector('summary').textContent,'查看来源记录（1 条）');
});

test('a successful source deletion hides cached topic facts when refreshing fails and retry only reads',async()=>{
  const deleted=source('source-secret','应删除的私密事实'),retained=source('source-retained','保留的事实'),other=source('source-other','另一个话题');
  const f=fixture({topics:[topic('topic-moving','搬家',[deleted,retained],{text:'旧摘要还含应删除的私密事实'}),topic('topic-sleep','睡眠',[other])],records:[deleted,retained,other]});await settle();await f.openProfile();
  await f.clickText(f.$('modal-body').querySelector('.memory-source'),'删除记录');f.state.memoryFailures=1;await f.clickText(f.$('modal-actions'),'确认删除');
  assert.equal(f.$('modal-title').textContent,'个人档案与设置');assert.doesNotMatch(f.$('modal-body').textContent,/应删除的私密事实|旧摘要|保留的事实/);assert.match(f.$('modal-body').textContent,/另一个话题/);
  assert.match(f.$('modal-body').textContent,/记忆已删除，个人档案暂时未能刷新/);assert.equal(f.$('modal-actions').querySelectorAll('button').some(item=>item.textContent==='确认删除'),false);
  await f.clickText(f.$('modal-actions'),'重试读取');assert.equal(f.mutations().length,1);assert.match(f.$('modal-body').textContent,/保留的事实/);assert.doesNotMatch(f.$('modal-body').textContent,/应删除的私密事实/);
});

test('deleting a topic invalidates every linked conversation and never repeats a successful deletion after a read failure',async()=>{
  const first=source('source-first','第一次咨询'),second=source('source-second','第二次咨询');
  const f=fixture({topics:[topic('topic-moving','搬家',[first,second],{current_memory_id:first.id})],records:[first,second]});await settle();await f.openProfile();
  await f.clickText(f.$('modal-body'),'继续聊');await f.send('第一次继续咨询');const firstChat=f.chats().at(-1);assert.equal(firstChat.data.followup_memory_id,first.id);
  f.state.topics[0].current_memory_id=second.id;await f.openProfile();await f.clickText(f.$('modal-body'),'继续聊');await f.send('第二次继续咨询');assert.equal(f.chats().at(-1).data.followup_memory_id,second.id);
  await f.openProfile();await f.clickText(f.$('modal-body'),'删除主题');assert.equal(f.$('modal-title').textContent,'删除整个记忆主题？');assert.match(f.$('modal-body').textContent,/全部来源记录都会删除/);
  f.state.memoryFailures=1;await f.clickText(f.$('modal-actions'),'确认删除');assert.deepEqual(clone(f.mutations()[0].data),{action:'delete_topic',id:'topic-moving'});
  assert.equal(f.$('modal-body').querySelectorAll('.memory-topic').length,0);assert.equal(f.$('followups').querySelectorAll('.followup-card').length,0);
  await f.clickText(f.$('modal-actions'),'重试读取');assert.equal(f.mutations().length,1);f.$('modal-close').click();
  await f.send('当前对话再问');assert.equal(f.chats().at(-1).data.followup_memory_id,'');
  const prior=f.$('topics').querySelectorAll('.topic-row').at(-1).querySelector('button');await prior.click();await settle();await f.send('早先对话再问');
  assert.equal(f.chats().at(-1).data.followup_memory_id,'');assert.notEqual(f.chats().at(-1).data.conversation_id,firstChat.data.conversation_id);
});

test('failed topic deletion keeps confirmation retryable and retains the sources',async()=>{
  const saved=source('source-first','仍应保留');const f=fixture({topics:[topic('topic-moving','搬家',[saved])],records:[saved],deleteFailures:1});await settle();await f.openProfile();
  await f.clickText(f.$('modal-body'),'删除主题');await f.clickText(f.$('modal-actions'),'确认删除');assert.equal(f.$('modal-title').textContent,'删除整个记忆主题？');assert.match(f.$('modal-error').textContent,/删除暂时失败/);assert.equal(f.state.records.length,1);
  await f.clickText(f.$('modal-actions'),'确认删除');assert.equal(f.state.records.length,0);assert.equal(f.$('modal-title').textContent,'个人档案与设置');
});

test('a closed memory setting still shows topic sources and hides continue controls',async()=>{
  const saved=source('source-first','过去明确说过的事实');const f=fixture({enabled:false,topics:[topic('topic-moving','搬家',[saved],{consolidation:{status:'pending'}})],records:[saved]});await settle();await f.openProfile();
  assert.match(f.$('modal-body').textContent,/正在整理这个话题，来源记录已保留/);assert.equal(f.$('modal-body').querySelectorAll('.memory-source').length,1);
  assert.equal(f.$('modal-body').querySelectorAll('button').some(item=>item.textContent==='继续聊'),false);
  f.state.topics[0].consolidation.status='failed';await f.openProfile();assert.match(f.$('modal-body').textContent,/暂未整理完成，来源记录已保留/);
  assert.doesNotMatch(f.$('modal-body').textContent,/token|SDK|pending|failed/);
});

test('an old backend without topics retains the individual-memory interface',async()=>{
  const f=fixture({topics:undefined,records:[{id:'legacy-memory',state:'active',problem:'旧版话题',text:'旧版摘要',problem_status:'unresolved'}]});await settle();await f.openProfile();
  assert.equal(f.$('modal-body').querySelectorAll('.memory-topic').length,0);assert.match(f.$('modal-body').textContent,/旧版摘要/);
  await f.clickText(f.$('modal-body'),'删除');await f.clickText(f.$('modal-actions'),'确认删除');assert.equal(f.mutations()[0].data.action,'delete');
});
