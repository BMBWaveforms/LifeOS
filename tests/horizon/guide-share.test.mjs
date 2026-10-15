import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildGuideShareModel,wrapCardText} from '../../frontend/horizon/guide-share-card.mjs';
const entries=JSON.parse(readFileSync(new URL('../../data/guide.json',import.meta.url))).entries;

test('sharing takes guide text, limits and provenance without conversation or memory',()=>{
 const guide=entries.find(e=>e.guide_id==='03-03');
 const model=buildGuideShareModel({...guide,query:'PRIVATE_QUERY',memory:{text:'PRIVATE_MEMORY'},response:{message:'PRIVATE_RESPONSE'}});
 assert.equal(model.title,guide.title);assert.equal(model.sections[0].text,guide.fields['说人话']);
 assert.equal(model.sections.find(s=>s.label==='适用范围与提醒').text,guide.fields['备注']);
 assert.equal(model.sections.find(s=>s.label==='出处').text,guide.fields['来源']);
 assert.equal(JSON.stringify(model).includes('PRIVATE_'),false);
 assert.match(model.attribution,/eternity4719.*CC BY 4.0/s);assert.equal(model.snapshot,'2026-10-12');
});
test('no guide is invented for a greeting, plain answer or an incomplete card',()=>{
 for(const value of [null,{}, {title:'hello',guide_id:'test'}, {guide_id:'x',title:'x',fields:{}}])assert.equal(buildGuideShareModel(value),null);
});
test('every existing guide can make a complete, untruncated card model',()=>{
 for(const guide of entries){const model=buildGuideShareModel(guide);assert.ok(model,guide.guide_id);for(const name of ['成本','备注','来源'])if(guide.fields[name])assert.ok(model.sections.some(s=>s.text===guide.fields[name]),guide.guide_id+' '+name);}
});
test('canvas wrapping keeps line breaks, emoji and long URLs without losing text',()=>{
 const measure=s=>[...s].length;
 assert.deepEqual(wrapCardText('你好世界\n\nABCDEF',3,measure),['你好世','界','','ABC','DEF']);
 const source='https://example.com/long/path/0123456789';assert.equal(wrapCardText(source,7,measure).join(''),source);
 assert.deepEqual(wrapCardText('👨‍👩‍👧‍👦你好',8,measure),['👨‍👩‍👧‍👦你','好']);
});

test('Chinese punctuation stays with its phrase, English words stay together when possible',()=>{
 const width=s=>[...s].length,source='这是一句话。再聊聊';const lines=wrapCardText(source,5,width);
 assert.equal(lines.join(''),source);assert.ok(lines.every(line=>! /^[，。！？]/.test(line)));
 assert.deepEqual(wrapCardText('hello world',8,width),['hello ','world']);
});
