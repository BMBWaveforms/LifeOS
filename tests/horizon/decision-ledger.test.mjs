import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildLedgerModel,calculateCommute,createLedgerSequence,createLedgerView,disposeLedgerViews,ledgerRevealTiming,ledgerAutoProgress,ledgerTextPieces,ledgerPieceProgress,ledgerPassages,ledgerEvidence} from '../../frontend/decision-ledger.mjs';
import {searchGuides} from '../../frontend/service.mjs';
const entries=JSON.parse(readFileSync(new URL('../../data/guide.json',import.meta.url))).entries;
const commute=entries.find(e=>e.guide_id==='04-18');

test('ledger is conditional on decision intent and returned evidence',()=>{
 assert.equal(buildLedgerModel('你好',{status:'acknowledged',cards:[]}),null);
 assert.equal(buildLedgerModel('聊聊天',{status:'answer',cards:[commute]}),null);
 assert.equal(buildLedgerModel('通勤怎么选',{status:'unsupported',cards:[]}),null);
 assert.equal(buildLedgerModel('通勤怎么选',{status:'clarification',cards:[commute]}),null);
 assert.equal(buildLedgerModel('通勤怎么选',{status:'answer',cards:[{guide_id:'test',title:'无依据'}]}),null);
});
test('ledger reuses actual returned guide fields without inventing candidates or verdicts',()=>{
 const question='准备租房搬家，想减少通勤',cards=searchGuides(entries,question);
 assert.deepEqual(cards.map(c=>c.guide_id),['15-01','15-06','04-18']);
 const model=buildLedgerModel(question,{status:'answer',cards});
 assert.equal(model.cards.length,3);assert.equal(model.query,question);assert.equal(model.commute,true);
 assert.equal(model.cards[2],commute);assert.equal(model.cards[2].fields['证据等级'],'B');
 assert.deepEqual(searchGuides(entries,'希望减少通勤'),[commute]);
});
test('unrelated decisions do not receive a commute calculator',()=>{
 const model=buildLedgerModel('租房合同该怎么确认',{status:'answer',cards:searchGuides(entries,'租房合同')});
 assert.ok(model);assert.equal(model.commute,false);
});
test('commute conversion uses explicit adjustable assumptions and rejects invalid inputs',()=>{
 assert.deepEqual(calculateCommute(30,5,52),{weekly:5,annual:260});
 assert.deepEqual(calculateCommute('15','4','48'),{weekly:2,annual:96});
 for(const input of [['',5,52],[0,5,52],[-1,5,52],[30,8,52],[30,5,53],['abc',5,52],[Infinity,5,52],[30,5,0]])assert.equal(calculateCommute(...input),null);
});

function clock(){let now=0,next=0;const jobs=new Map();return{schedule(fn,ms){const id=++next;jobs.set(id,{at:now+ms,fn});return id;},cancel(id){jobs.delete(id);},advance(ms){const until=now+ms;for(;;){const due=[...jobs].filter(([,job])=>job.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;jobs.delete(due[0]);due[1].fn();}now=until;},get now(){return now;},get pending(){return jobs.size;}};}
function readingFixture(options={}){const time=clock(),events=[],items=[{id:'cost',length:40},{id:'evidence',length:60}],seen=new Set();const sequence=createLedgerSequence({items,seen,schedule:time.schedule,cancel:time.cancel,onReveal:(item,animate)=>events.push([item.id,animate]),onStamp:phase=>events.push(['stamp',phase]),onStampCancel:()=>events.push(['stamp','cancel']),...options});return {time,events,items,seen,sequence};}
const view=(ids,extra={})=>({visible:new Set(ids),passed:new Set(),stampVisible:false,pageVisible:true,...extra});

test('the stamp controller accepts independently completed passages without another reading queue',()=>{
 const f=readingFixture();f.sequence.update(view(['evidence']));assert.deepEqual(f.events,[['evidence',true]]);assert.equal(f.time.pending,0);
 f.time.advance(10000);assert.deepEqual(f.events,[['evidence',true]]);
 f.sequence.update(view(['cost','evidence']));assert.deepEqual(f.events,[['evidence',true],['cost',true]]);assert.equal(f.time.pending,0);
 f.sequence.update(view(['cost','evidence']));assert.equal(f.events.length,2);assert.equal(f.events.some(e=>e[0]==='stamp'),false);
});
test('stamp waits for the complete seal to be visible, then leaves a distinct anticipation and landing',()=>{
 const f=readingFixture();f.sequence.update(view([],{passed:new Set(['cost','evidence'])}));f.time.advance(20000);assert.equal(f.events.some(e=>e[0]==='stamp'),false);
 f.sequence.update(view([],{stampVisible:true}));f.time.advance(549);assert.equal(f.events.some(e=>e[0]==='stamp'),false);
 f.time.advance(1);assert.deepEqual(f.events.at(-1),['stamp','start']);f.time.advance(1099);assert.deepEqual(f.events.at(-1),['stamp','start']);
 f.time.advance(1);assert.deepEqual(f.events.at(-1),['stamp','done']);
});
test('scrolling away or hiding the page cancels an unseen/incomplete stamp; returning replays it',()=>{
 const f=readingFixture();f.sequence.update(view([],{passed:new Set(['cost','evidence'])}));f.sequence.update(view([],{stampVisible:true}));f.time.advance(550);
 f.sequence.update(view([]));f.time.advance(10000);assert.ok(!f.events.some(e=>e[1]==='done'));
 f.sequence.update(view([],{stampVisible:true}));f.time.advance(100);f.sequence.update(view([],{stampVisible:true,pageVisible:false}));f.time.advance(10000);assert.ok(!f.events.some(e=>e[1]==='done'));
 f.sequence.update(view([],{stampVisible:true}));f.time.advance(1650);assert.deepEqual(f.events.at(-1),['stamp','done']);
});
test('an already-queued stale stamp callback cannot cancel a newer visible attempt',()=>{
 const f=readingFixture({cancel(){}});
 f.sequence.update(view(['cost','evidence'],{stampVisible:true}));f.time.advance(100);
 f.sequence.update(view([]));f.sequence.update(view([],{stampVisible:true}));
 f.time.advance(1650);assert.deepEqual(f.events.at(-1),['stamp','done']);
 assert.equal(f.events.filter(event=>event[1]==='done').length,1);
});
test('batch completion settles passages and preserves the final visible stamp',()=>{
 const f=readingFixture();f.sequence.update(view([],{passed:new Set(['cost','evidence']),stampVisible:true}));assert.deepEqual(f.events,[['cost',false],['evidence',false]]);
 f.time.advance(1650);assert.deepEqual(f.events.at(-1),['stamp','done']);
});
test('reduced motion reveals content directly but still waits for the seal to enter view; disposal stops callbacks',()=>{
 const f=readingFixture({reduced:true});f.sequence.update(view([]));assert.deepEqual(f.events,[['cost',false],['evidence',false]]);assert.equal(f.time.pending,0);
 f.sequence.update(view([],{stampVisible:true}));assert.deepEqual(f.events.at(-1),['stamp','done']);
 const other=readingFixture();other.sequence.update(view(['cost','evidence']));other.sequence.dispose();other.time.advance(20000);assert.deepEqual(other.events,[['cost',true],['evidence',true]]);
});
test('reading passages preserve every source character and evidence tags never invent a score',()=>{
 for(const text of [commute.fields['收益'],commute.fields['来源'],'很长的问题'.repeat(100)+'。\n后半段。'])assert.equal(ledgerPassages(text).join(''),text);
 const facts=ledgerEvidence(commute);assert.equal(facts.grade,'B');assert.equal(facts.source,commute.fields['来源']);assert.deepEqual(facts.tags,[{label:'金钱投入',value:'多'},{label:'时间投入',value:'中'},{label:'毅力投入',value:'否'},{label:'收益量级',value:'大'}]);assert.ok(!('score' in facts));assert.deepEqual(ledgerEvidence({fields:{}}),{grade:'未标注',tags:[],source:'',limits:''});
});
test('long passage boundaries never split a Unicode character into replacement glyphs',()=>{
 const text='字'.repeat(107)+'🙂'+'长'.repeat(220)+'。';
 const pieces=ledgerPassages(text);assert.equal(pieces.join(''),text);
 assert.ok(pieces.every(piece=>piece.isWellFormed()));
});

test('the automatic reading wave has bounded durations and continues without scroll input',()=>{
 assert.deepEqual(ledgerRevealTiming(0,10),{start:0,duration:700});
 assert.deepEqual(ledgerRevealTiming(21,200),{start:4830,duration:1100});
 assert.equal(ledgerAutoProgress(0,0,100),0);
 assert.equal(ledgerAutoProgress(700,5,100),0);
 assert.ok(ledgerAutoProgress(1500,5,100)>0&&ledgerAutoProgress(1500,5,100)<1);
 assert.equal(ledgerAutoProgress(6000,21,200),1);
});
test('words resolve in reading order, with a visible mix of sharp and faint text',()=>{
 const values=Array.from({length:8},(_,i)=>ledgerPieceProgress(.5,i,8));
 assert.equal(values[0],1);assert.equal(values.at(-1),0);
 assert.ok(values.some(v=>v>0&&v<1));assert.ok(values.every((v,i)=>!i||v<=values[i-1]));
 assert.equal(ledgerPieceProgress(1,7,8),1);assert.equal(ledgerPieceProgress(.5,0,1),.5);
});
test('Chinese word segmentation preserves original source text, spaces and punctuation',()=>{
 for(const text of [commute.fields['收益'],commute.fields['来源'],'「睡 7 小时」 不是新评分。\nRCT (48 people), A/B；https://example.com/research/long-url','<script>不是 HTML</script>，中文，标点。🙂']){
  const pieces=ledgerTextPieces(text);assert.equal(pieces.join(''),text);assert.ok(pieces.length>1);
 }
 assert.equal(ledgerEvidence({fields:{'证据等级':'A（争议）'}}).grade,'A（争议）');
});

// A small DOM and controllable frame clock exercise the actual mounted view,
// rather than only its stamp controller. Source content stays plain text.
class LedgerNode {
 constructor(tag,doc){this.tagName=tag.toUpperCase();this.doc=doc;this.children=[];this.parentNode=null;this.dataset={};this.attributes={};this.listeners={};this.style={setProperty(name,value){this[name]=value;}};this.hidden=false;this.open=false;}
 set textContent(value){if(this.tagName==='#TEXT')this.content=String(value);else{this.replaceChildren();if(String(value))this.append(this.doc.createTextNode(String(value)));}}
 get textContent(){return this.tagName==='#TEXT'?this.content||'':this.children.map(n=>n.textContent).join('');}
 get firstChild(){return this.children[0]||null;}
 append(...nodes){for(const n of nodes){n.parentNode=this;this.children.push(n);}}
 replaceChildren(...nodes){this.children.forEach(n=>n.parentNode=null);this.children=[];this.append(...nodes);}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
 get isConnected(){return this===this.doc.body||Boolean(this.parentNode?.isConnected);}
 set className(value){this.attributes.class=value;}get className(){return this.attributes.class||'';}
 get classList(){const node=this;return {contains(name){return node.className.split(' ').includes(name);},add(...names){node.className=[...new Set([...node.className.split(' ').filter(Boolean),...names])].join(' ');},toggle(name,on){const set=new Set(node.className.split(' ').filter(Boolean));on?set.add(name):set.delete(name);node.className=[...set].join(' ');}};}
 setAttribute(key,value){this.attributes[key]=String(value);}getAttribute(key){return this.attributes[key];}
 matches(selector){
  if(selector.includes(','))return selector.split(',').some(s=>this.matches(s.trim()));
  if(selector.includes('>')){const [parent,child]=selector.split('>');return this.matches(child)&&Boolean(this.parentNode?.matches(parent));}
  if(selector.includes(' ')){const [parent,child]=selector.split(' ');return this.matches(child)&&Boolean(this.parentNode?.closest(parent));}
  if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));
  return this.tagName===selector.toUpperCase();
 }
 closest(selector){return this.matches(selector)?this:this.parentNode?.closest(selector);}
 querySelectorAll(selector){return this.children.flatMap(n=>[...(n.matches(selector)?[n]:[]),...n.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 addEventListener(name,callback){(this.listeners[name]??=new Set()).add(callback);}
 removeEventListener(name,callback){this.listeners[name]?.delete(callback);}
 dispatch(name,event={}){for(const callback of this.listeners[name]||[])callback(event);}
 getBoundingClientRect(){return this.rect||{top:100,bottom:150,left:100,right:700};}
 getClientRects(){return this.isConnected&&!this.hidden?[this.getBoundingClientRect()]:[];}
 focus(){}scrollIntoView(){}
}
let viewNumber=0;
function mountedLedger({reduced=false,card=commute,cards=[card]}={}){
 const time=clock(),mutations=[],originals=new Map();
 const doc={hidden:false,createElement(tag){return new LedgerNode(tag,this);},createElementNS(ns,tag){const n=this.createElement(tag);n.namespaceURI=ns;return n;},createTextNode(text){const n=this.createElement('#text');n.content=text;return n;}};
 doc.body=doc.createElement('body');const scroller=doc.createElement('div'),dialog=doc.createElement('dialog');doc.body.append(scroller,dialog);
 scroller.rect={top:0,bottom:900,left:0,right:1200};doc.getElementById=id=>id==='conversation-scroll'?scroller:id==='dialog'?dialog:null;
 const events=doc.createElement('div');doc.addEventListener=events.addEventListener.bind(events);doc.removeEventListener=events.removeEventListener.bind(events);
 const win=doc.createElement('div'),motion={matches:reduced,listeners:new Set(),addEventListener(_,fn){this.listeners.add(fn);},removeEventListener(_,fn){this.listeners.delete(fn);}};
 const globals={document:doc,window:win,matchMedia:()=>motion,innerHeight:900,innerWidth:1200,performance:{now:()=>time.now},requestAnimationFrame:fn=>time.schedule(()=>fn(time.now),16),cancelAnimationFrame:id=>time.cancel(id),setTimeout:time.schedule,clearTimeout:time.cancel,
  IntersectionObserver:class{observe(){}disconnect(){}},MutationObserver:class{constructor(fn){this.fn=fn;}observe(target){this.target=target;mutations.push(this);}disconnect(){this.target=null;}}};
 for(const [key,value]of Object.entries(globals)){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 const model={query:'通勤成本要不要比较',cards,commute:cards.some(item=>item.guide_id==='04-18')},key='ledger-mounted-'+(++viewNumber);
 let root=createLedgerView(model,{key,onReadGuide(){}});scroller.append(root);
 const open=()=>root.querySelector('.ledger-open').onclick();
 const units=()=>root.querySelectorAll('.ledger-reading-unit');
 const seal=()=>root.querySelector('.ledger-seal');
 const sealSlot=()=>root.querySelector('.ledger-seal-slot');
 sealSlot().rect={top:600,bottom:764,left:100,right:264};
 return{time,doc,scroller,dialog,motion,open,units,seal,sealSlot,get root(){return root;},
  changeDialog(open){dialog.open=open;for(const observer of mutations)if(observer.target===dialog)observer.fn();if(!open)dialog.dispatch('close');},
  visibility(hidden){doc.hidden=hidden;events.dispatch('visibilitychange');},
  reduced(value){motion.matches=value;for(const listener of motion.listeners)listener();},
  remount(){disposeLedgerViews();root.remove();root=createLedgerView(model,{key,onReadGuide(){}});scroller.append(root);sealSlot().rect={top:600,bottom:764,left:100,right:264};},
  cleanup(){disposeLedgerViews();for(const [key,descriptor]of originals)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];},
 };
}
const progress=unit=>Number(unit.style['--ledger-progress']);

test('closing and reopening resumes the text timeline without making completed passages faint again',()=>{
 const f=mountedLedger();try{
  f.open();f.time.advance(1400);const before=f.units().map(progress);assert.equal(before[0],1);assert.ok(before.some(v=>v>0&&v<1));
  f.open();f.time.advance(20000);f.open();f.time.advance(32);const after=f.units().map(progress);
  assert.equal(after[0],1);for(let i=0;i<before.length;i++)assert.ok(after[i]>=before[i],`passage ${i} lost progress`);
 }finally{f.cleanup();}
});
test('returning to a completed conversation restores readable text beside its completed seal',()=>{
 const f=mountedLedger();try{
  f.open();f.time.advance(20000);assert.equal(f.seal().dataset.state,'done');f.remount();f.time.advance(32);
  assert.equal(f.seal().dataset.state,'done');assert.ok(f.units().every(unit=>progress(unit)===1));
 }finally{f.cleanup();}
});
test('a detached view cannot complete a seal from an earlier visibility sample',()=>{
 const f=mountedLedger();try{
  f.open();for(let i=0;i<1000&&f.seal().dataset.state!=='stamping';i++)f.time.advance(16);
  assert.equal(f.seal().dataset.state,'stamping');f.root.remove();f.time.advance(2000);
  assert.notEqual(f.seal().dataset.state,'done');
 }finally{f.cleanup();}
});
test('details and page visibility pause the automatic text clock and cancel pending seals',()=>{
 const f=mountedLedger();try{
  f.open();f.time.advance(1200);f.changeDialog(true);f.time.advance(32);const before=f.units().map(progress);
  f.time.advance(20000);assert.deepEqual(f.units().map(progress),before);assert.notEqual(f.seal().dataset.state,'done');
  f.changeDialog(false);f.time.advance(160);assert.ok(f.units().some((unit,i)=>progress(unit)>before[i]));
  f.visibility(true);const paused=f.units().map(progress);f.time.advance(20000);assert.deepEqual(f.units().map(progress),paused);
  f.visibility(false);f.time.advance(20000);assert.equal(f.seal().dataset.state,'done');
 }finally{f.cleanup();}
});
test('switching the selected guide starts its own reading wave while preserving common question text',()=>{
 const f=mountedLedger({cards:[commute,entries.find(entry=>entry.guide_id==='15-01')]});try{
  f.open();f.time.advance(20000);assert.equal(f.seal().dataset.state,'done');
  f.root.querySelectorAll('.ledger-guide-choice')[1].onclick();
  assert.equal(f.seal().dataset.state,'waiting');assert.equal(progress(f.units()[0]),1);
  assert.equal(progress(f.units().find(unit=>unit.dataset.readingId==='cost-0')),0);
  f.time.advance(20000);assert.equal(f.seal().dataset.state,'done');
 }finally{f.cleanup();}
});
test('reduced motion reveals long source text fully but the seal still requires a visible position',()=>{
 const long='完整依据'.repeat(180)+'🙂最后原文不可缺失。',card={...commute,fields:{...commute.fields,'收益':long}};
 const f=mountedLedger({reduced:true,card});try{
  f.sealSlot().rect={top:1000,bottom:1164,left:100,right:264};f.open();f.time.advance(32);
  assert.ok(f.units().every(unit=>progress(unit)===1));assert.equal(f.seal().dataset.state,'waiting');
  assert.equal(f.units().filter(unit=>unit.dataset.readingId.startsWith('benefit-')).map(unit=>unit.querySelector('p').textContent).join(''),long);
  f.sealSlot().rect={top:600,bottom:764,left:100,right:264};f.scroller.dispatch('scroll');f.time.advance(16);assert.equal(f.seal().dataset.state,'done');
 }finally{f.cleanup();}
});
