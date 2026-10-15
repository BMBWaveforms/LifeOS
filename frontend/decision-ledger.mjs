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
// The automatic text timeline completes passages; viewport visibility gates the seal.
// Only the visible, completed seal keeps a deliberate anticipation and landing.
export function createLedgerSequence({items,seen=new Set(),stamped=false,reduced=false,schedule=setTimeout,cancel=clearTimeout,canStamp=()=>true,onReveal=()=>{},onStamp=()=>{},onStampCancel=()=>{},onComplete=()=>{}}){
 let stampVisible=false,pageVisible=true,disposed=false,stampTimer=null,stampStage='',stampVersion=0;
 const clearStamp=()=>{stampVersion++;if(stampTimer!==null)cancel(stampTimer);stampTimer=null;if(stampStage){stampStage='';onStampCancel();}};
 function stamp(){
  if(disposed||stamped||stampTimer!==null||!stampVisible||!pageVisible||!canStamp()||items.some(item=>!seen.has(item.id)))return;
  const version=stampVersion;
  if(reduced){stamped=true;onStamp('done');onComplete();return;}
  stampStage='arming';
  stampTimer=schedule(()=>{if(disposed||version!==stampVersion)return;stampTimer=null;if(!stampVisible||!pageVisible||!canStamp()){clearStamp();return;}stampStage='stamping';onStamp('start');stampTimer=schedule(()=>{if(disposed||version!==stampVersion)return;stampTimer=null;if(!stampVisible||!pageVisible||!canStamp()){clearStamp();return;}stamped=true;stampStage='';onStamp('done');onComplete();},1100);},550);
 }
 function revealAll(){for(const item of items)if(!seen.has(item.id)){seen.add(item.id);onReveal(item,false);}stamp();}
 return {
  update(next){if(disposed)return;stampVisible=Boolean(next.stampVisible);pageVisible=next.pageVisible!==false;
   if(!stampVisible||!pageVisible)clearStamp();if(!pageVisible)return;
   if(reduced){revealAll();return;}
   const visible=next.visible||new Set(),passed=next.passed||new Set();
   for(const item of items){if(seen.has(item.id))continue;if(passed.has(item.id)||visible.has(item.id)){seen.add(item.id);onReveal(item,!passed.has(item.id));}}
   stamp();
  },
  dispose(){disposed=true;clearStamp();},
  get complete(){return items.every(item=>seen.has(item.id));},
 };
}
export function ledgerPassages(value,limit=108){
 const sentences=String(value||'').match(/[^。！？；\n]+[。！？；\n]?|[。！？；\n]/g)||[];
 const chunks=[];let buffer='';
 for(const sentence of sentences){
  if(buffer&&buffer.length+sentence.length>limit){chunks.push(buffer);buffer='';}
  if(sentence.length>limit*1.6){if(buffer){chunks.push(buffer);buffer='';}const chars=Array.from(sentence);for(let i=0;i<chars.length;i+=limit)chunks.push(chars.slice(i,i+limit).join(''));}
  else buffer+=sentence;
 }
 if(buffer)chunks.push(buffer);return chunks;
}
export function ledgerEvidence(card){
 const grade=typeof card?.fields?.['证据等级']==='string'?card.fields['证据等级']:'未标注';
 const match=String(card?.full_text||'').match(/<!--\s*成本标签:\s*([^>]+?)\s*-->/),tags=[];
 if(match)for(const [label,key]of [['金钱投入','钱'],['时间投入','时间'],['毅力投入','毅力'],['收益量级','收益']]){const value=match[1].match(new RegExp('(?:^|\\s)'+key+'=([^\\s]+)'))?.[1];if(value)tags.push({label,value});}
 return {grade,tags,source:card?.fields?.['来源']||'',limits:card?.fields?.['备注']||''};
}

const states=new Map(),live=new Set();
export function disposeLedgerViews(){for(const dispose of [...live])dispose();}
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const button=(text,fn,cls)=>{const e=node('button',text,cls);e.type='button';e.onclick=fn;return e;};
const format=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n);
// The text wave is automatic; scrolling controls only the final seal.
export function ledgerRevealTiming(index,length){
 return {start:index*230,duration:Math.min(1100,Math.max(700,550+length*5))};
}
export function ledgerAutoProgress(elapsed,index,length){
 const {start,duration}=ledgerRevealTiming(index,length);
 return Math.min(1,Math.max(0,(elapsed-start)/duration));
}
export function ledgerPieceProgress(progress,index,count){
 const offset=count>1?index/(count-1)*.72:0;
 return Math.min(1,Math.max(0,(progress-offset)/(count>1?.28:1)));
}
export function ledgerTextPieces(value){
 const text=String(value),segments=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter('zh-CN',{granularity:'word'}).segment(text)].map(s=>s.segment):Array.from(text),pieces=[];
 let opening='';
 for(const segment of segments){
  if(/^[（《「『【“‘([{]+$/u.test(segment)){opening+=segment;continue;}
  if(!opening&&/^[，。！？；：、）》」』】”’％%.,!?;:)\]}]+$/u.test(segment)&&pieces.length&&!/^\s+$/u.test(pieces.at(-1))){pieces[pieces.length-1]+=segment;continue;}
  const chars=Array.from(opening+segment);opening='';for(let i=0;i<chars.length;i+=16)pieces.push(chars.slice(i,i+16).join(''));
 }
 if(opening)pieces.push(opening);return pieces;
}
function evidenceGrade(grade,cls){
 const value=String(grade),label=node('span',value,cls);label.dataset.grade=value;label.setAttribute('aria-label','证据等级 '+value);
 if(value.length>1)label.classList.add('ledger-grade-qualified');return label;
}
function prepareTextReveal(host){
 const texts=[];
 for(const text of host.querySelectorAll('.ledger-label,.ledger-reading-unit>p,.ledger-guide-title,.ledger-calc-title h4,.ledger-calc-title p,.ledger-evidence-note,.ledger-evidence-caption,dt,dd')){
  if(text.querySelector('.ledger-reveal-piece'))continue;
  // Replace only text leaves: controls, provenance links and grade badges stay intact.
  const original=text.textContent,pieces=[];text.replaceChildren();
  for(const part of ledgerTextPieces(original)){if(/^\s+$/u.test(part)){text.append(document.createTextNode(part));continue;}const piece=node('span',part,'ledger-reveal-piece');pieces.push(piece);text.append(piece);}
  text.classList.add('ledger-reveal-text');texts.push({host:text,pieces});
 }
 return texts;
}
function paintTextReveal(item,progress){
 for(const text of item.texts){const at=text.host.classList.contains('ledger-label')?Math.min(1,progress*1.7):progress;text.host.style.setProperty('--ledger-text-turn',((1-at)*1.5).toFixed(3)+'deg');text.pieces.forEach((piece,index)=>{
  const value=Number(ledgerPieceProgress(at,index,text.pieces.length).toFixed(3)),previous=piece.dataset.progress;
  const next=value.toFixed(3);if(next===previous)return;piece.dataset.progress=next;
  piece.style.opacity=(.16+.84*value).toFixed(3);piece.style.filter=value===1?'none':`blur(${((1-value)*3).toFixed(2)}px)`;
 });}
}
function arrow(){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('class','ledger-arrow');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M5 12h14m-6-6 6 6-6 6');svg.append(path);return svg;}
export function createLedgerView(model,{key,onReadGuide}){
 let state=states.get(key);if(!state){state={open:false,selected:Math.max(0,model.cards.findIndex(c=>c.guide_id==='04-18')),minutes:'30',days:'5',weeks:'52',seen:new Set(),stamped:false,elapsed:0};states.set(key,state);if(states.size>150)states.delete(states.keys().next().value);}
 const motion=matchMedia('(prefers-reduced-motion: reduce)'),scroller=document.getElementById('conversation-scroll'),dialog=document.getElementById('dialog');
 let disposed=false,sequence=null,observer=null,frame=0,lastSample=0,elapsed=0,units=[],numbers=[],seal,sealSlot,status;
 const root=node('section',undefined,'ledger-entry');root.setAttribute('aria-label','决策账本');
 const cover=node('div',undefined,'ledger-cover'),meta=node('div',undefined,'ledger-cover-meta');meta.append(node('span','决策账本'),node('span',`${model.cards.length} 项建议`));
 const title=node('h3','把这件事，摊开看看。','ledger-cover-title'),bottom=node('div',undefined,'ledger-cover-bottom'),description=node('p','先看投入，再看收益与依据。','ledger-cover-description');
 const open=button('翻开这笔账',toggle,'ledger-open');open.append(arrow());const id='ledger-'+(globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2));open.setAttribute('aria-controls',id);open.setAttribute('aria-expanded',String(state.open));bottom.append(description,open);
 const evidence=node('div',undefined,'ledger-cover-evidence');evidence.append(node('span','证据等级'));
 [...new Set(model.cards.map(c=>ledgerEvidence(c).grade))].forEach(grade=>evidence.append(node('strong',grade)));
 cover.append(meta,title,evidence,bottom);root.append(cover);const paper=node('div',undefined,'ledger-paper');paper.id=id;paper.hidden=!state.open;root.append(paper);
 function clear(){sequence?.dispose();sequence=null;observer?.disconnect();observer=null;cancelAnimationFrame(frame);frame=0;lastSample=0;}
 function addUnit(parent,id,label,content){
  const host=node('div',undefined,'ledger-reading-unit');host.dataset.readingId=id;
  if(label)host.append(node('h4',label,'ledger-label'));if(content)host.append(content);parent.append(host);
  units.push({id,host,phase:label||parent.dataset.phase||'依据明细',length:host.textContent.length,texts:prepareTextReveal(host)});return host;
 }
 function field(parent,key,label,value){const passages=key==='source'?(String(value||'').match(/[^；\n]+[；\n]?|[；\n]/g)||[]):ledgerPassages(value);passages.forEach((text,i)=>{addUnit(parent,key+'-'+i,i===0?label:'',node('p',text));units.at(-1).phase=label;});}
 function settleNumbers(){for(const item of numbers)item.host.textContent=item.value===null?'—':format(item.value);}
 function sealInView(){
  const bounds=scroller?.getBoundingClientRect()||{top:0,bottom:innerHeight,left:0,right:innerWidth},r=sealSlot.getBoundingClientRect();
  return r.top>=Math.max(0,bounds.top)+12&&r.bottom<=Math.min(innerHeight,bounds.bottom)-24&&r.left>=Math.max(0,bounds.left)&&r.right<=Math.min(innerWidth,bounds.right);
 }
 function sample(time=performance.now()){
  if(frame)cancelAnimationFrame(frame);frame=0;if(disposed||!state.open||!sequence||!root.isConnected)return;
  const visible=new Set(),passed=new Set();
  const pageVisible=!document.hidden&&!dialog?.open;
  const dt=lastSample?Math.min(100,Math.max(0,time-lastSample)):0;lastSample=pageVisible?time:0;if(pageVisible){elapsed+=dt;state.elapsed=elapsed;}
  let moving=false;
  for(const [index,item] of units.entries()){
   const progress=motion.matches||item.focused||state.seen.has(item.id)?1:ledgerAutoProgress(elapsed,index,item.length);
   if(progress<1)moving=true;else visible.add(item.id);
   if(progress!==item.progress){item.progress=progress;item.host.style.setProperty('--ledger-progress',String(progress));paintTextReveal(item,progress);}
  }
  const stampVisible=!moving&&sealInView();
  sequence.update({visible,passed,stampVisible,pageVisible});
  if(moving&&pageVisible)requestSample();
 }
 function requestSample(){if(!frame)frame=requestAnimationFrame(sample);}
 function prepare(){
  sequence?.dispose();sequence=null;root.dataset.playing=String(!state.stamped);root.dataset.stamped=String(state.stamped);
  lastSample=0;elapsed=state.elapsed||0;for(const [index,item] of units.entries()){item.progress=motion.matches||state.seen.has(item.id)?1:ledgerAutoProgress(elapsed,index,item.length);item.focused=false;item.host.style.setProperty('--ledger-progress',String(item.progress));paintTextReveal(item,item.progress);}
  seal.dataset.state=state.stamped?'done':'waiting';status.textContent=state.stamped?'已展开':'逐项展开';
  sequence=createLedgerSequence({items:units,seen:state.seen,stamped:state.stamped,reduced:motion.matches,
   canStamp:()=>!disposed&&state.open&&root.isConnected&&root.getClientRects().length>0&&!document.hidden&&!dialog?.open&&sealInView(),
   onReveal(item){status.textContent=item.phase;root.dataset.stage=item.phase;if(item.id==='calculator')settleNumbers();},
   onStamp(phase){seal.dataset.state=phase==='start'?'stamping':'done';if(phase==='done'){state.stamped=true;root.dataset.stamped='true';}},
   onStampCancel(){if(!state.stamped)seal.dataset.state='waiting';},onComplete(){root.dataset.playing='false';status.textContent='已展开';}});
  if(state.seen.has('calculator'))settleNumbers();observer?.disconnect();observer=new IntersectionObserver(requestSample,{root:scroller,threshold:[0,.5,1]});observer.observe(root);units.forEach(item=>observer.observe(item.host));observer.observe(sealSlot);requestSample();
 }
 function buildPaper(){
  clear();paper.replaceChildren();units=[];numbers=[];
  const toolbar=node('div',undefined,'ledger-toolbar');status=node('span','逐项展开');toolbar.append(status);paper.append(toolbar);
  const question=node('section',undefined,'ledger-question');question.dataset.phase='这次的问题';field(question,'question','这次要想清楚的事',model.query);paper.append(question);
  const guideSection=node('section',undefined,'ledger-guides');const choices=node('div',undefined,'ledger-choices');
  model.cards.forEach((card,i)=>{const choose=button('',()=>{if(state.selected===i)return;state.selected=i;state.seen=new Set([...state.seen].filter(id=>id.startsWith('question')||id.startsWith('guides-')));state.stamped=false;state.elapsed=0;buildPaper();prepare();paper.querySelectorAll('.ledger-guide-choice')[i]?.focus({preventScroll:true});},'ledger-guide-choice');choose.setAttribute('aria-pressed',String(i===state.selected));choose.setAttribute('aria-label',card.title+'，证据等级 '+ledgerEvidence(card).grade+'，查看明细');choose.append(node('span',card.source_locator||card.guide_id,'ledger-guide-id'),node('span',card.title,'ledger-guide-title'),evidenceGrade(ledgerEvidence(card).grade,'ledger-guide-grade'));addUnit(choices,'guides-'+i,i===0?(model.cards.length>1?'本轮建议 · 选择一条查看':'本轮建议'):'',choose);units.at(-1).phase='本轮建议 '+(i+1)+' / '+model.cards.length;});
  guideSection.append(choices);paper.append(guideSection);
  const card=model.cards[state.selected]||model.cards[0],facts=ledgerEvidence(card),detail=node('section',undefined,'ledger-detail');
  if(facts.tags.length){addUnit(detail,'tags-title','',node('h4','投入与收益概览','ledger-label'));const tags=node('dl',undefined,'ledger-facts');facts.tags.forEach((tag,i)=>{const pair=node('div',undefined,'ledger-fact-pair');pair.append(node('dt',tag.label),node('dd',tag.value==='0'?'无':tag.value));addUnit(tags,'tags-'+i,'',pair);});detail.append(tags);}
  if(card.fields['说人话'])field(detail,'proposal','建议要点',card.fields['说人话']);
  field(detail,'cost','需要投入',card.fields['成本']);field(detail,'benefit','可能收益与研究依据',card.fields['收益']);
  const evidence=node('div',undefined,'ledger-evidence-summary');evidence.append(evidenceGrade(facts.grade,'ledger-evidence-grade'),node('p','证据等级','ledger-evidence-caption'),node('p','沿用来源的证据分级，保留其依据与适用边界。','ledger-evidence-note'));
  addUnit(detail,'evidence','证据等级',evidence);
  const closing=node('div',undefined,'ledger-closing'),closingCopy=node('div',undefined,'ledger-closing-copy');
  if(facts.source)field(closingCopy,'source','出处',facts.source);else field(closingCopy,'source','出处','本项建议未提供独立来源说明。');
  if(facts.limits)field(closingCopy,'limits','适用范围与提醒',facts.limits);
  const read=button('查看完整依据与来源',()=>{onReadGuide(card);requestSample();},'ledger-source-link');addUnit(closingCopy,'read-source','',read);closing.append(closingCopy);detail.append(closing);let stampTarget=closing;paper.append(detail);
  if(model.commute&&card.guide_id==='04-18'){
   const calculator=node('section',undefined,'ledger-calculator'),intro=node('div',undefined,'ledger-calc-title');intro.append(node('h4','把通勤时间，换算成一笔。'),node('p','参考试算 · 参数可修改'));addUnit(calculator,'calculator-intro','',intro);
   const fields=node('div',undefined,'ledger-calc-fields'),results=node('div',undefined,'ledger-calc-results'),error=node('p','','ledger-calc-error');error.setAttribute('role','status');
   for(const [name,label,min,max,unit]of [['minutes','单程减少',1,240,'分钟'],['days','每周通勤',1,7,'天'],['weeks','每年计算',1,52,'周']]){const wrap=node('label');wrap.append(node('span',label));const group=node('div'),input=node('input');input.type='number';input.min=min;input.max=max;input.step='any';input.value=state[name];input.setAttribute('aria-label',label);input.oninput=()=>{state[name]=input.value;updateCalculation();};group.append(input,node('span',unit));wrap.append(group);fields.append(wrap);}
   for(const label of ['小时 / 每周','小时 / 每年']){const box=node('div',undefined,'ledger-calc-result'),host=node('strong',undefined,'ledger-number');box.append(host,node('span',label));numbers.push({host,value:null});results.append(box);}
   addUnit(calculator,'calculator-fields','',fields);addUnit(calculator,'calculator','',results);calculator.append(error);addUnit(calculator,'calculator-assumption','',node('p','按往返通勤计算；52 周未扣除假期。这里只换算时间。','ledger-calc-assumption'));
   function updateCalculation(){const result=calculateCommute(state.minutes,state.days,state.weeks);error.textContent=result?'':'请填写有效参数：单程 1–240 分钟，每周 1–7 天，每年 1–52 周。';numbers.forEach((item,i)=>{item.value=result?(i?result.annual:result.weekly):null;const text=item.value===null?'—':format(item.value);item.host.setAttribute('aria-label',text);item.host.style.minWidth=Math.max(3,text.length)+'ch';item.host.textContent=text;});}updateCalculation();
   paper.append(calculator);stampTarget=calculator;for(const item of units)if(item.id.startsWith('calculator'))item.phase='时间试算';
  }
  sealSlot=node('div',undefined,'ledger-seal-slot');seal=node('div',undefined,'ledger-seal');seal.setAttribute('role','img');seal.setAttribute('aria-label','投入、收益、证据，LEVO');
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 144 144');svg.setAttribute('aria-hidden','true');
  const defs=document.createElementNS(svg.namespaceURI,'defs'),path=document.createElementNS(svg.namespaceURI,'path'),ringId=id+'-seal-ring';path.id=ringId;path.setAttribute('d','M72 21a51 51 0 1 1 0 102a51 51 0 1 1 0-102');defs.append(path);
  const rings=document.createElementNS(svg.namespaceURI,'g');rings.setAttribute('class','ledger-seal-circles');
  for(const [radius,width]of [[69,1.8],[64.5,.7],[31,.7]]){const circle=document.createElementNS(svg.namespaceURI,'circle');circle.setAttribute('cx','72');circle.setAttribute('cy','72');circle.setAttribute('r',String(radius));circle.setAttribute('stroke-width',String(width));rings.append(circle);}
  const ring=document.createElementNS(svg.namespaceURI,'text');ring.setAttribute('class','ledger-seal-ring');ring.setAttribute('textLength',String(102*Math.PI));ring.setAttribute('lengthAdjust','spacing');
  const textPath=document.createElementNS(svg.namespaceURI,'textPath');textPath.setAttribute('href','#'+ringId);textPath.setAttribute('startOffset','0%');textPath.textContent='投入 · 收益 · 证据 · '.repeat(3);ring.append(textPath);
  const mark=document.createElementNS(svg.namespaceURI,'text');mark.setAttribute('x','72');mark.setAttribute('y','79');mark.setAttribute('class','ledger-seal-wordmark');mark.textContent='LEVO';svg.append(defs,rings,ring,mark);seal.append(svg);sealSlot.append(seal);stampTarget.classList.add('ledger-with-seal');stampTarget.append(sealSlot);

 }
 function toggle(){state.open=!state.open;paper.hidden=!state.open;open.setAttribute('aria-expanded',String(state.open));open.firstChild.textContent=state.open?'收起账本':'翻开这笔账';root.classList.toggle('ledger-is-open',state.open);if(state.open)prepare();else clear();}
 root.addEventListener('focusin',event=>{const unit=event.target.closest('.ledger-reading-unit');if(unit&&event.target.matches(':focus-visible')){const item=units.find(item=>item.host===unit);if(item)item.focused=true;unit.scrollIntoView({block:'center',behavior:'instant'});requestSample();}});
 root.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.open){event.preventDefault();toggle();open.focus({preventScroll:true});}});
 const onVisibility=()=>{if(document.hidden)sample();else requestSample();};
 const onMotion=()=>{if(state.open)prepare();};motion.addEventListener('change',onMotion);
 scroller?.addEventListener('scroll',requestSample,{passive:true});window.addEventListener('resize',requestSample);document.addEventListener('visibilitychange',onVisibility);dialog?.addEventListener('close',requestSample);
 const dialogObserver=new MutationObserver(requestSample);if(dialog)dialogObserver.observe(dialog,{attributes:true,attributeFilter:['open']});
 const dispose=()=>{disposed=true;clear();dialogObserver.disconnect();motion.removeEventListener('change',onMotion);scroller?.removeEventListener('scroll',requestSample);window.removeEventListener('resize',requestSample);document.removeEventListener('visibilitychange',onVisibility);dialog?.removeEventListener('close',requestSample);live.delete(dispose);};live.add(dispose);
 buildPaper();if(state.open){root.classList.add('ledger-is-open');open.firstChild.textContent='收起账本';prepare();}return root;
}
