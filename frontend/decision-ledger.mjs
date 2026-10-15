// A presentation of already-returned guide evidence, never a second model verdict.
const decisionIntent=/租房|搬家|通勤|划算|值不值|值得|该不该|要不要|怎么选|如何选|比较|对比|成本|收益|哪个更/;
export function buildLedgerModel(query,result){
 if(!decisionIntent.test(String(query))||result?.status!=='answer')return null;
 const cards=(result.cards||[]).filter(c=>c?.guide_id&&c.title&&c.fields?.['成本']&&c.fields?.['收益']);
 if(!cards.length)return null;
 return {query:String(query),cards,commute:cards.some(c=>c.guide_id==='04-18')};
}
export function calculateCommute(minutes,days,weeks){
 const values=[minutes,days,weeks].map(v=>typeof v==='string'&&v.trim()===''?NaN:Number(v));
 const [m,d,w]=values;
 if(values.some(v=>!Number.isFinite(v))||m<1||m>240||d<1||d>7||w<1||w>52)return null;
 const weekly=m*2*d/60;return {weekly,annual:weekly*w};
}
const states=new Map(),live=new Set();
export function disposeLedgerViews(){for(const dispose of [...live])dispose();}
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const button=(text,fn,cls)=>{const e=node('button',text,cls);e.type='button';e.onclick=fn;return e;};
const format=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n);
// Split Text / Count Up inspired cadence, implemented locally without a React runtime.
function splitText(host,text){
 host.setAttribute('aria-label',text);
 const phrases=String(text).match(/[^，。！？；,!?;\n]+[，。！？；,!?;\n]?|[，。！？；,!?;\n]/g)||[text];
 const chunks=phrases.flatMap(p=>[...p].reduce((parts,char,i)=>{if(i%10===0)parts.push('');parts[parts.length-1]+=char;return parts;},[]));
 chunks.forEach((part,i)=>{const span=node('span',part,'ledger-text-unit');span.setAttribute('aria-hidden','true');span.style.setProperty('--text-delay',`${Math.min(i*80,320)}ms`);host.append(span);});
}
export function createLedgerView(model,{key,onReadGuide}){
 let state=states.get(key);if(!state){state={open:false,seen:false,selected:Math.max(0,model.cards.findIndex(c=>c.guide_id==='04-18')),minutes:'30',days:'5',weeks:'52'};states.set(key,state);if(states.size>150)states.delete(states.keys().next().value);}
 let timers=[],observer=null,running=false,disposed=false,lastNumberStart=-Infinity;
 const frames=new Set(),numbers=[],motion=matchMedia('(prefers-reduced-motion: reduce)'),scroller=document.getElementById('conversation-scroll');
 const root=node('section',undefined,'ledger-entry');root.setAttribute('aria-label','决策账本');
 const header=node('div',undefined,'ledger-cover'),coverMeta=node('div',undefined,'ledger-cover-meta');
 coverMeta.append(node('span','决策账本'),node('span',`${model.cards.length} 条指南`));
 const coverTitle=node('h3','把这件事，摊开看看。','ledger-cover-title'),preview=node('p','看看投入、收益与依据。','ledger-cover-description');
 const open=button('翻开这笔账',()=>toggle(),'ledger-open');
 const controlId='ledger-'+(globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2));open.setAttribute('aria-expanded',String(state.open));open.setAttribute('aria-controls',controlId);
 const coverBottom=node('div',undefined,'ledger-cover-bottom');coverBottom.append(preview,open);header.append(coverMeta,coverTitle,coverBottom);root.append(header);
 const body=node('div',undefined,'ledger-paper');body.id=controlId;body.hidden=!state.open;root.append(body);
 const toolbar=node('div',undefined,'ledger-toolbar');toolbar.append(node('span','投入 · 收益 · 依据'));
 const skip=button('跳过动画',()=>finish(),'ledger-small-button');toolbar.append(skip);body.append(toolbar);
 const steps=[];
 const makeStep=cls=>{const e=node('section',undefined,cls+' ledger-step');steps.push(e);body.append(e);return e;};
 const question=makeStep('ledger-question');question.append(node('span','这次要想清楚的事','ledger-label'));
 const quotation=node('p');splitText(quotation,model.query);question.append(quotation);
 const guides=makeStep('ledger-guides'),guideTop=node('div',undefined,'ledger-guide-top');
 guideTop.append(node('strong',`本轮依据 · ${model.cards.length} 条`),node('p','选择一条，查看明细'));guides.append(guideTop);
 const choices=node('div',undefined,'ledger-choices');guides.append(choices);
 const detail=makeStep('ledger-detail'),calc=model.commute?makeStep('ledger-calculator'):null,conclusion=makeStep('ledger-conclusion');
 const conclusionCopy=node('div');conclusionCopy.append(node('h4','依据摊开了，决定留给你。'),node('p','还有在意的地方，可以带回对话里继续聊。'));
 const seal=node('div',undefined,'ledger-seal');seal.append(node('strong','待权衡'),node('span','LIFEOS'));conclusion.append(conclusionCopy,seal);
 const footer=node('div',undefined,'ledger-bottom'),replay=button('重播动效',()=>play(true),'ledger-small-button');
 const back=button('接着聊这个问题',()=>{finish();const query=document.getElementById('query');query?.focus({preventScroll:true});query?.scrollIntoView({block:'nearest',behavior:motion.matches?'instant':'smooth'});},'ledger-back');footer.append(replay,back);body.append(footer);
 function later(fn,delay){const timer=setTimeout(()=>{timers=timers.filter(t=>t!==timer);if(!disposed)fn();},delay);timers.push(timer);}
 function frame(fn){const id=requestAnimationFrame(time=>{frames.delete(id);if(!disposed)fn(time);});frames.add(id);}
 function stop(){timers.forEach(clearTimeout);timers=[];frames.forEach(cancelAnimationFrame);frames.clear();observer?.disconnect();observer=null;running=false;}
 function numberText(output,value){output.host.replaceChildren();const visual=node('span',value);visual.setAttribute('aria-hidden','true');output.host.append(visual);}
 function settleNumbers(){for(const output of numbers)numberText(output,output.value===null?'—':format(output.value));}
 function countNumbers(){
  lastNumberStart=performance.now();
  for(const output of numbers){
   if(output.value===null)continue;
   const target=output.value,start=lastNumberStart;numberText(output,'0');const visual=output.host.firstChild;
   const tick=time=>{const t=Math.min(1,(time-start)/900),value=target*(1-(1-t)**3);visual.textContent=format(t===1?target:value);if(t<1&&running)frame(tick);};frame(tick);
  }
 }
 function finish(){stop();state.seen=true;for(const step of steps)step.classList.remove('ledger-pending','ledger-reveal');settleNumbers();skip.hidden=true;root.dataset.playing='false';}
 function reveal(step,delay=0){
  if(!running||!step.classList.contains('ledger-pending'))return;
  observer?.unobserve(step);step.style.setProperty('--reveal-delay',`${delay}ms`);step.classList.remove('ledger-pending');step.classList.add('ledger-reveal');
  if(step===calc){lastNumberStart=performance.now()+delay+180;later(countNumbers,delay+180);}
  if(step===conclusion){const untilNumbers=Math.max(0,lastNumberStart+1100-performance.now());step.style.setProperty('--stamp-delay',`${Math.max(delay+550,untilNumbers)}ms`);}
  if(steps.every(s=>!s.classList.contains('ledger-pending')))later(()=>{running=false;observer?.disconnect();observer=null;skip.hidden=true;root.dataset.playing='false';},Math.max(delay+1400,calc?lastNumberStart+1400-performance.now():0));
 }
 function observe(){
  observer=new IntersectionObserver(entries=>{
   const visible=entries.filter(e=>e.isIntersecting&&e.target.classList.contains('ledger-pending')).map(e=>e.target).sort((a,b)=>steps.indexOf(a)-steps.indexOf(b));
   visible.forEach((step,i)=>reveal(step,Math.min(i*140,420)));
  },{root:scroller,rootMargin:'0px 0px -12px 0px',threshold:0});
  steps.forEach(step=>observer.observe(step));
 }
 function play(rewind=false){
  stop();state.seen=true;
  if(motion.matches){finish();return;}
  running=true;lastNumberStart=-Infinity;root.dataset.playing='true';skip.hidden=false;
  steps.forEach(step=>{step.classList.remove('ledger-reveal');step.classList.add('ledger-pending');});
  for(const output of numbers)numberText(output,output.value===null?'—':'0');
  // One optional rewind; reading never causes programmatic scroll or height changes.
  if(rewind){header.scrollIntoView({block:'start',behavior:'smooth'});later(observe,650);}else observe();
 }
 function toggle(){
  state.open=!state.open;body.hidden=!state.open;open.setAttribute('aria-expanded',String(state.open));open.textContent=state.open?'收起':'翻开这笔账';root.classList.toggle('ledger-is-open',state.open);
  if(state.open){if(state.seen)finish();else play();}else stop();
 }
 function renderDetail(){
  const card=model.cards[state.selected]||model.cards[0];detail.replaceChildren();
  const top=node('div',undefined,'ledger-detail-title');top.append(node('span',card.source_locator||card.guide_id,'ledger-label'),node('h4',card.title));detail.append(top);
  const table=node('dl',undefined,'ledger-balance');
  for(const [i,[label,value]]of [['投入',card.fields['成本']],['收益',card.fields['收益']]].entries()){
   const row=node('div');row.style.setProperty('--row-delay',`${100+i*160}ms`);row.append(node('dt',label),node('dd',value));table.append(row);
  }detail.append(table);
  const limits=node('details',undefined,'ledger-limits');limits.append(node('summary','依据与适用范围'),node('p','证据等级 · '+(card.fields['证据等级']||'未标注')));
  if(card.fields['备注'])limits.append(node('p',card.fields['备注']));
  const source=node('div',undefined,'ledger-source');source.append(node('span','出处 · '+(card.fields['来源']||'见完整指南')),button('查看完整指南与来源',()=>{finish();onReadGuide(card);},'ledger-source-link'));limits.append(source);detail.append(limits);
 }
 model.cards.forEach((card,i)=>{
  const choose=button('',()=>{finish();state.selected=i;renderDetail();updateChoices();},'ledger-guide-choice');choose.append(node('span',card.guide_id,'ledger-guide-id'),node('span',card.title,'ledger-guide-title'),node('span','↗','ledger-guide-arrow'));choose.setAttribute('aria-label',card.title+'，查看明细');choose.style.setProperty('--row-delay',`${i*90}ms`);choices.append(choose);
 });
 function updateChoices(){[...choices.children].forEach((e,i)=>e.setAttribute('aria-pressed',String(i===state.selected)));}
 renderDetail();updateChoices();
 if(calc){
  const calcTitle=node('div',undefined,'ledger-calc-title');calcTitle.append(node('h4','把通勤时间，换算成一笔。'),node('span','参考试算 · 指南 04-18 · 参数可修改'));calc.append(calcTitle);
  const fields=node('div',undefined,'ledger-calc-fields'),results=node('div',undefined,'ledger-calc-results'),error=node('p','','ledger-calc-error');error.setAttribute('role','status');
  for(const [name,label,min,max,unit]of [['minutes','单程减少',1,240,'分钟'],['days','每周通勤',1,7,'天'],['weeks','每年计算',1,52,'周']]){
   const wrap=node('label');wrap.append(node('span',label));const group=node('div'),input=node('input');input.type='number';input.min=min;input.max=max;input.step='any';input.value=state[name];input.setAttribute('aria-label',label);
   input.oninput=()=>{if(running)finish();state[name]=input.value;updateCalculation();};group.append(input,node('span',unit));wrap.append(group);fields.append(wrap);
  }
  for(const label of ['小时 / 每周','小时 / 每年']){const box=node('div',undefined,'ledger-calc-result'),host=node('strong',undefined,'ledger-number');box.append(host,node('span',label));numbers.push({host,value:null});results.append(box);}
  calc.append(fields,results,error,node('p','按往返通勤计算；52 周未扣除假期。这里只换算时间。','ledger-calc-assumption'));
  function updateCalculation(){
   const result=calculateCommute(state.minutes,state.days,state.weeks);error.textContent=result?'':'请填写有效参数：单程 1–240 分钟，每周 1–7 天，每年 1–52 周。';
   numbers.forEach((output,i)=>{output.value=result?(i?result.annual:result.weekly):null;const text=output.value===null?'—':format(output.value);output.host.setAttribute('aria-label',text);output.host.style.minWidth=Math.max(3,text.length)+'ch';numberText(output,text);});
  }updateCalculation();
 }
 // Keyboard users immediately receive visible content instead of focusing transparent controls.
 root.addEventListener('focusin',event=>{if(running&&event.target.closest('.ledger-step,.ledger-bottom'))finish();});
 root.addEventListener('keydown',event=>{if(running&&event.key==='Escape'){event.preventDefault();finish();}});
 const onMotion=()=>{if(motion.matches&&running)finish();};motion.addEventListener('change',onMotion);
 const onVisibility=()=>{if(document.hidden&&running)finish();};document.addEventListener('visibilitychange',onVisibility);
 const dispose=()=>{disposed=true;stop();motion.removeEventListener('change',onMotion);document.removeEventListener('visibilitychange',onVisibility);live.delete(dispose);};live.add(dispose);
 if(state.open){root.classList.add('ledger-is-open');open.textContent='收起';finish();}else skip.hidden=true;
 return root;
}
