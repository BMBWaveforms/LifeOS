import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildLedgerModel,calculateCommute} from '../../frontend/horizon/decision-ledger.mjs';
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
