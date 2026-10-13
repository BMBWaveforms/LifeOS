let active,conversation='',editing=null,epoch=0,followupId='';
const $=id=>document.getElementById(id),msg=t=>$('status').textContent=t;
const labels={resolved:'已解决',unresolved:'尚未解决',unknown:'未说明'};
async function api(path,data){const r=await fetch(path,{method:data?'POST':'GET',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const d=await r.json();if(!r.ok){if(r.status===401){$('workspace').hidden=true;$('login').hidden=false;}throw Error(d.message||'操作失败');}return d}
function paragraph(box,text,tag='p'){const el=document.createElement(tag);el.textContent=text;box.append(el);return el}
function button(box,label,fn){const b=document.createElement('button');b.textContent=label;b.onclick=fn;box.append(b);return b}
function unlink(){followupId='';$('linked').hidden=true}
async function state(){
 const owner=active.id,e=epoch,d=await api('/api/memories');if(owner!==active.id||e!==epoch)return d;
 $('enabled').checked=d.enabled;$('memories').replaceChildren();const memories=[...d.memories].sort((a,b)=>b.updated-a.updated);
 if(!memories.length)paragraph($('memories'),'暂无摘要。完成一轮对话后，这里会自动更新。');
 for(const m of memories){const div=document.createElement('div');div.className='memory';paragraph(div,m.text);
  paragraph(div,(m.origin==='model_summary'?'模型会话摘要 · '+labels[m.problem_status]:'补充记录')+(m.state==='superseded'?' · 已被后续摘要更新':''),'small');
  if(m.guides?.length)paragraph(div,'咨询过的指南：'+m.guides.map(g=>g.title).join('；'),'small');
  const row=document.createElement('div');row.className='row';if(m.origin==='model_summary')button(row,'纠正',()=>{editing=m.id;$('memory').value=m.text;$('problem').value=m.problem;$('user_state').value=m.user_state;$('problem_status').value=m.problem_status;$('editor').hidden=false});
  button(row,'删除',()=>act({action:'delete',id:m.id}));div.append(row);$('memories').append(div)}return d
}
async function act(data){const owner=active.id;try{await api('/api/memory-action',data);if(owner!==active.id)return false;epoch++;await state();conversation='';unlink();$('chat').replaceChildren();$('editor').hidden=true;editing=null;await run('home');return true}catch(e){msg(e.message);return false}}
function displayMarkdown(box,text){for(const line of text.split('\n')){if(!line.trim())continue;const el=document.createElement(line.startsWith('### ')?'h3':'p');const link=line.match(/^\[([^\]]+)\]\((https:\/\/github\.com\/eternity4719\/HowToLiveBetter\/[^)]+)\)(.*)$/);if(link){const a=document.createElement('a');a.textContent=link[1];a.href=link[2];a.target='_blank';a.rel='noopener';el.append(a,document.createTextNode(link[3]));}else el.textContent=line.replace(/^### /,'').replace(/\*\*/g,'');box.append(el)}}
function renderHome(box,d){let result;try{result=typeof d.result==='string'?JSON.parse(d.result):d.result}catch{}if(!result?.followups?.length){displayMarkdown(box,d.markdown);return}
 for(const item of result.followups){const div=document.createElement('div');div.className='followup';paragraph(div,item.progress_question,'h3');paragraph(div,item.guide_question);const row=document.createElement('div');row.className='row';
  button(row,'已经解决',()=>run('chat','上次提到“'+item.topic+'”的问题已经解决了。',item.memory_id));
  button(row,'还没解决',()=>run('chat','上次提到“'+item.topic+'”的问题还没解决，暂时先帮我记录进展。',item.memory_id));
  button(row,'继续问相关指南',()=>{followupId=item.memory_id;$('linked').textContent='继续讨论：'+item.topic;$('linked').hidden=false;$('query').value='关于“'+item.topic+'”，我还需要继续咨询'+(item.guides.length?'“'+item.guides[0].title+'”等相关指南。':'相关指南。');$('query').focus()});
  div.append(row);box.append(div)}
}
async function run(mode,queryOverride,linkedId){if(mode==='chat'&&$('ask').disabled){msg('上一轮还在整理，请稍等。');return}const requestEpoch=epoch,requestOwner=active.id;const b=$(mode==='home'?'refresh':'ask');b.disabled=true;msg(mode==='home'?'正在整理上次的问题…':'正在回答并整理会话摘要…');try{
 const q=queryOverride??$('query').value;const d=await api('/api/run',{mode,query:q,conversation_id:conversation,followup_memory_id:linkedId??followupId});if(requestEpoch!==epoch||requestOwner!==active.id)return;
 const box=$(mode==='home'?'home':'chat');box.replaceChildren();if(mode==='chat'){conversation=d.conversation_id||conversation;paragraph(box,'你：'+q);displayMarkdown(box,d.markdown);unlink();await state();msg(d.summary?.message||'本轮对话完成。');await run('home');if(d.summary&&!d.summary.saved)msg(d.summary.message)}else{renderHome(box,d);msg('回访已更新。')}
 }catch(e){if(requestEpoch===epoch&&requestOwner===active.id)msg(e.message)}finally{b.disabled=false}
}
$('enabled').onchange=()=>act({action:'settings',enabled:$('enabled').checked});$('ask').onclick=()=>run('chat');$('refresh').onclick=()=>run('home');
$('newchat').onclick=()=>{epoch++;conversation='';unlink();$('chat').replaceChildren();msg('已开始新会话；开启记忆时仍可读取以往会话摘要。')};
$('save').onclick=()=>act({action:'correct_summary',id:editing,text:$('memory').value,problem:$('problem').value,user_state:$('user_state').value,problem_status:$('problem_status').value});$('cancel').onclick=()=>{$('editor').hidden=true;editing=null};
$('clear').onclick=()=>{if(confirm('清空全部长期会话摘要和旧记录？'))act({action:'clear'})};
async function enter(user){epoch++;active=user;conversation='';editing=null;unlink();$('editor').hidden=true;$('query').value='';$('chat').replaceChildren();$('account').textContent=user.name;$('logout').hidden=false;$('login').hidden=true;$('workspace').hidden=false;await state();await run('home')}
$('loginform').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/login',{username:$('username').value,password:$('password').value});$('password').value='';await enter(d.user)}catch(e){msg(e.message)}};
$('logout').onclick=async()=>{await api('/api/logout',{});epoch++;active=null;conversation='';unlink();$('chat').replaceChildren();$('home').replaceChildren();$('memories').replaceChildren();$('account').textContent='';$('workspace').hidden=true;$('login').hidden=false;$('logout').hidden=true;msg('已退出登录。')};
(async()=>{const h=await api('/health');if(!h.model.configured)msg('模型尚未配置，登录后可管理记忆；请先补齐后端 API 配置。');try{const d=await api('/api/me');await enter(d.user)}catch{}})().catch(e=>msg(e.message));
