const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
class Element {
  constructor(tag) {this.tagName=tag;this.children=[];this.dataset={};this.disabled=false;this.value='';this._text='';}
  append(...nodes) {this.children.push(...nodes);}
  replaceChildren(...nodes) {this.children=nodes;this._text='';}
  set textContent(value) {this._text=String(value??'');this.children=[];}
  get textContent() {return this._text+this.children.map(n=>n.textContent).join('');}
  all() {return this.children.flatMap(n=>[n,...n.all()]);}
}
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(installed=true) {
  const ids=new Map(),calls=[];
  const html=fs.readFileSync(path.join(root,'frontend/workbench.html'),'utf8');
  for(const [,tag,id] of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"/g))ids.set(id,new Element(tag));
  const document={getElementById:id=>ids.get(id),createElement:tag=>new Element(tag),querySelectorAll:()=>[],dispatchEvent(){}};
  const old={id:'legacy-result',session_id:'legacy-session',runtime:'native',query:'旧记录',status:'success',created:1,
    elapsed_ms:5,prompt_versions:{},memories_before:{memories:[]},memories_after:{enabled:false,memories:[]}};
  const record={...old,id:'sdk-result',session_id:'sdk-session',runtime:'claude-sdk'};
  const response=async(url,request)=>{
    const data=request.body?JSON.parse(request.body):undefined;calls.push({url,data});
    let result={};
    if(url==='/api/me')result={user:{name:'test',id:'alice'}};
    if(url==='/api/runtimes')result={default:'claude-sdk',options:[{id:'claude-sdk',available:installed,version:installed?'test':''}]};
    if(url==='/api/test-runs')result={runs:[old]};
    if(url==='/api/test-runs/legacy-result')result=old;
    if(url==='/api/test-sessions')result={session_id:'sdk-session',runtime:'claude-sdk'};
    if(url==='/api/test-run')result=record;
    return {ok:true,json:async()=>result};
  };
  const context=vm.createContext({document,fetch:response,Event:class{},CustomEvent:class{},Blob,URL,setTimeout});
  vm.runInContext(fs.readFileSync(path.join(root,'frontend/workbench.js'),'utf8'),context);
  return {ids,calls,context};
}
test('free tests use SDK without offering a runtime selector or comparison',async()=>{
  const f=fixture();await settle();
  assert.equal(f.ids.has('native'),false);assert.equal(f.ids.has('compare'),false);
  f.ids.get('query').value='测试问题';await f.ids.get('run').onclick();
  const create=f.calls.find(c=>c.url==='/api/test-sessions');
  assert.equal(create.data.runtime,'claude-sdk');
  const execute=f.calls.find(c=>c.url==='/api/test-run');
  assert.equal(execute.data.session_id,'sdk-session');assert.equal(execute.data.runtime,undefined);
});
test('legacy native results can be inspected but have no resume action',async()=>{
  const f=fixture();await settle();
  const view=f.ids.get('history').all().find(n=>n.tagName==='button');await view.onclick();
  const article=f.ids.get('results').children[0];
  assert.match(article.textContent,/已停用/);
  assert.equal(article.all().some(n=>n.textContent==='续接此测试会话'),false);
  assert.equal(article.all().some(n=>n.textContent==='下载本次记录'),true);
});
test('missing SDK disables new execution without a native fallback',async()=>{
  const f=fixture(false);await settle();
  assert.equal(f.ids.get('run').disabled,true);
  assert.match(f.ids.get('runtime-info').textContent,/SDK 未安装/);
  assert.equal(f.calls.some(c=>c.url==='/api/test-sessions'),false);
});
