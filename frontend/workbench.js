'use strict';
const $ = id => document.getElementById(id);
const labels = {native:'Python 自实现', 'claude-sdk':'Claude Agent SDK'};
let active = null, selected = 'native', runtimes = null, busy = false, epoch = 0, sessions = {};
const message = text => { $('status').textContent = text; };
function resetLogin(){document.dispatchEvent(new Event('lifeos-logout'));epoch++;active=null;sessions={};$('workspace').hidden=true;$('login').hidden=false;$('logout').hidden=true;$('account').textContent='';$('results').replaceChildren();$('history').replaceChildren();}
async function api(path, data){
 const requestEpoch=epoch;
 const response = await fetch(path,{method:data?'POST':'GET',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
 const result = await response.json();
 if(!response.ok){if(response.status===401&&requestEpoch===epoch)resetLogin();throw Error(result.message||'操作失败');}
 return result;
}
function add(box, tag, text){const element=document.createElement(tag);element.textContent=text;box.append(element);return element;}
function details(box, title, value){const element=document.createElement('details');add(element,'summary',title);add(element,'pre',JSON.stringify(value,null,2));box.append(element);}
function available(id){return !!runtimes?.options.find(option=>option.id===id)?.available;}
function controls(){
 for(const id of ['run','new-session','memory-enabled','refresh'])$(id).disabled=busy;
 $('compare').disabled=busy||!available('claude-sdk');if($('free-bundle'))$('free-bundle').disabled=busy;
 for(const id of Object.keys(labels)){$(id).disabled=busy||!available(id);$(id).setAttribute('aria-pressed',String(id===selected));}
 for(const button of document.querySelectorAll('#history button,#results article>button'))button.disabled=busy;
 const version=runtimes?.options.find(option=>option.id==='claude-sdk')?.version;
 $('runtime-info').textContent='本次测试：'+labels[selected]+' · 产品默认：'+labels[runtimes?.default]+(version?' · SDK '+version:' · SDK 未安装');
 $('session-info').textContent=sessions[selected]?'正在续接 '+labels[selected]+' 的测试会话。':'下一次运行将创建 '+labels[selected]+' 的新测试会话。';
}
function render(record, clear=true){
 if(clear)$('results').replaceChildren();
 const article=document.createElement('article');
 add(article,'h2',labels[record.runtime]);
 add(article,'span',record.status==='success'?'执行完成':'执行失败').className=record.status==='success'?'badge':'badge error';
 add(article,'p','输入：'+record.query);
 const result=record.result;
 add(article,'small','总耗时 '+(record.elapsed_ms/1000).toFixed(2)+' 秒'+(result?' · 工具调用 '+result.tool_calls+' 次 · 状态 '+result.result.status:''));
 add(article,'pre',result?.markdown||record.message||'没有输出。');
 const versions=record.prompt_versions||{};
 add(article,'small','提示词版本：'+Object.entries(versions).map(([name,hash])=>name+' '+hash.slice(0,12)).join('；'));
 details(article,'完整提示词版本与运行配置',{prompt_versions:versions,execution:result?.execution||{runtime:record.runtime}});
 for(const event of record.trace||[])details(article,'工具：'+event.tool+' · '+(event.status==='ok'?'完成':'失败'),event);
 if(!record.trace?.length)add(article,'p','本轮没有工具调用记录。').className='muted';
 const before=record.memories_before?.memories||[],after=record.memories_after?.memories||[];
 const oldIds=new Set(before.map(item=>item.id));
 details(article,'记忆变化：'+before.length+' → '+after.length+' 条',{新增:after.filter(item=>!oldIds.has(item.id)),之前:before,之后:after});
 const resume=add(article,'button','续接此测试会话');resume.disabled=busy;resume.onclick=()=>{selected=record.runtime;sessions={[selected]:{session_id:record.session_id,runtime:selected,memory_enabled:record.memories_after.enabled}};$('memory-enabled').checked=record.memories_after.enabled;controls();message('已续接 '+labels[selected]+' 测试会话，将使用这个会话的最新进展。');};
 const download=add(article,'button','下载本次记录');download.disabled=busy;download.onclick=()=>{const blob=new Blob([JSON.stringify(record,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='lifeos-test-'+record.id+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 $('results').append(article);
}
async function history(){
 const version=epoch,data=await api('/api/test-runs');if(version!==epoch)return;
 $('history').replaceChildren();
 if(!data.runs.length)add($('history'),'p','还没有运行记录。');
 for(const run of data.runs){const box=document.createElement('div');box.className='history-item';add(box,'small',new Date(run.created*1000).toLocaleString()+' · '+labels[run.runtime]+' · '+(run.status==='success'?'执行完成':'执行失败'));add(box,'p',run.query);const button=add(box,'button','查看结果');button.onclick=async()=>{const version=epoch;try{const record=await api('/api/test-runs/'+run.id);if(version===epoch)render(record);}catch(error){message(error.message);}};$('history').append(box);}
}
async function session(runtime, fresh=false){if(fresh||!sessions[runtime])sessions[runtime]=await api('/api/test-sessions',{runtime,memory_enabled:$('memory-enabled').checked,bundle_id:$('free-bundle')?.value});return sessions[runtime];}
async function run(compare=false){
 const query=$('query').value.trim();if(!query){message('请填写本次用户输入。');return;}
 if(busy)return;
 const version=epoch;busy=true;controls();$('results').replaceChildren();
 try{
  const engines=compare?['native','claude-sdk']:[selected];let failures=0;
  const fixedBundle=$('free-bundle')?.value;
  if(compare){for(const runtime of engines)sessions[runtime]=await api('/api/test-sessions',{runtime,memory_enabled:$('memory-enabled').checked,bundle_id:fixedBundle});}
  for(const runtime of engines){
   message('正在运行 '+labels[runtime]+'，并整理测试摘要…');
   const current=await session(runtime,false);if(version!==epoch)return;
   const record=await api('/api/test-run',{session_id:current.session_id,runtime,query});if(version!==epoch)return;
   render(record,false);if(record.status==='error')failures++;
  }
  message(failures?'本次有 '+failures+' 个执行失败，记录已保存，请查看原因。':compare?'两种执行层已完成本次对比，请查看输出与工具记录。':'本次测试完成，可以继续输入下一句话。');await history();
 }catch(error){if(version===epoch)message(error.message);}
 finally{busy=false;if(active)controls();}
}
async function enter(user){active=user;epoch++;sessions={};$('account').textContent=user.name;$('logout').hidden=false;$('login').hidden=true;$('workspace').hidden=false;runtimes=await api('/api/runtimes');selected=available(runtimes.default)?runtimes.default:'native';controls();await history();message('已登录，测试数据与产品数据分开保存。');document.dispatchEvent(new CustomEvent('lifeos-login',{detail:user}));}
for(const id of Object.keys(labels))$(id).onclick=()=>{selected=id;controls();message('已选择 '+labels[id]+'。');};
$('run').onclick=()=>run();$('compare').onclick=()=>run(true);
$('new-session').onclick=()=>{delete sessions[selected];$('results').replaceChildren();controls();message('已开始新测试会话，以往运行记录仍可查看。');};
$('memory-enabled').onchange=()=>{sessions={};controls();message('记忆设置已变更，下一次运行将使用新测试会话。');};
$('refresh').onclick=()=>history().catch(error=>message(error.message));
$('loginform').onsubmit=async event=>{event.preventDefault();try{const data=await api('/api/login',{username:$('username').value,password:$('password').value});$('password').value='';await enter(data.user);}catch(error){message(error.message);}};
$('logout').onclick=async()=>{try{await api('/api/logout',{});resetLogin();message('已退出登录。');}catch(error){message(error.message);}};
(async()=>{try{const data=await api('/api/me');await enter(data.user);}catch(error){resetLogin();message(error.message);}})();
