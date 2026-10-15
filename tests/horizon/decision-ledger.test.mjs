import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildLedgerModel,calculateCommute,createLedgerSequence,ledgerRevealTiming,ledgerAutoProgress,ledgerTextPieces,ledgerPieceProgress,ledgerPassages,ledgerEvidence} from '../../frontend/horizon/decision-ledger.mjs';
import {searchGuides} from '../../frontend/horizon/service.mjs';
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

function clock(){let now=0,next=0;const jobs=new Map();return{schedule(fn,ms){const id=++next;jobs.set(id,{at:now+ms,fn});return id;},cancel(id){jobs.delete(id);},advance(ms){const until=now+ms;for(;;){const due=[...jobs].filter(([,job])=>job.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;jobs.delete(due[0]);due[1].fn();}now=until;},get pending(){return jobs.size;}};}
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
