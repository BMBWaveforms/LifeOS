import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConversationUnderstanding as build} from '../../frontend/horizon/conversation-understanding.mjs';
import {createProjectExamples} from '../../frontend/horizon/project-demo.mjs';
const chat=queries=>({id:'current',turns:queries.map((query,i)=>({id:'t'+i,query,status:'completed'}))});

test('a new conversation has no invented understanding or goals',()=>{
  const model=build(chat([]));
  assert.equal(model.hasContent,false);
  assert.deepEqual(model.statements,[]);assert.deepEqual(model.goals,[]);
});
test('project understanding retains exact user evidence and links each goal to its source',()=>{
  const c=createProjectExamples()[0],model=build(c);
  assert.equal(model.example,true);assert.equal(model.count,2);
  assert.equal(model.statements[1].text,c.turns[1].query);
  assert.ok(model.goals.some(g=>g.text==='希望能控制在一小时以内'&&g.turnId===c.turns[1].id));
  assert.equal(model.topic,'通勤与日常安排');
});
test('hypothetical scenarios and others goals are not promoted into the users preferences',()=>{
  const model=build(chat(['假设周末看三套房，我希望预算控制在四千以内。']));
  assert.equal(model.statements[0].hypothetical,true);assert.deepEqual(model.goals,[]);
  assert.deepEqual(build(chat(['我朋友想租房，他的预算是4000。'])).goals,[]);
  assert.ok(build(chat(['我希望不被同事打断。'])).goals.length);
});
test('the latest correction replaces displayed intent without rewriting previous utterances',()=>{
  const c=chat(['我希望预算在3000以内。','改一下，我希望预算在4000以内。']);
  const before=JSON.stringify(c),model=build(c);
  assert.deepEqual(model.goals.map(g=>g.text),['我希望预算在4000以内']);
  assert.equal(model.statements[0].text,'我希望预算在3000以内。');
  assert.equal(JSON.stringify(c),before);
});
test('independent goals accumulate and survive ordinary follow-on messages beyond recent evidence',()=>{
  const c=chat(['预算希望控制在4000以内','希望通勤不超过一小时','下个月搬家','周末去看房','先看看几个候选片区']);
  const model=build(c);
  assert.equal(model.statements.length,3);
  assert.deepEqual(model.goals.map(g=>[g.dimension,g.text,g.turnId]),[
    ['budget','预算希望控制在4000以内','t0'],['commute','希望通勤不超过一小时','t1'],
  ]);
});
test('a correction replaces only its dimension, and withdrawal removes only that goal',()=>{
  const c=chat(['预算希望控制在4000以内','希望通勤不超过一小时','预算调整一下，我希望预算在5000以内','预算暂时不限制了','下个月搬家']);
  assert.deepEqual(build({...c,turns:c.turns.slice(0,3)}).goals.map(g=>g.text),['希望通勤不超过一小时','我希望预算在5000以内']);
  assert.deepEqual(build(c).goals.map(g=>g.text),['希望通勤不超过一小时']);
});
test('a hypothetical update cannot overwrite an existing explicit personal goal',()=>{
  const model=build(chat(['预算希望控制在4000以内','假设预算能到8000，我希望租大一些','先看一下房源']));
  assert.deepEqual(model.goals.map(g=>g.text),['预算希望控制在4000以内']);
});
test('topic changes follow the newest message rather than an unrelated older topic',()=>{
  const model=build(chat(['最近准备搬家。','先不聊搬家，我想改善睡眠。']));
  assert.equal(model.topic,'睡眠与休息');
});
test('only explicitly carried context is included, exactly and without edits',()=>{
  const c={...chat([]),recoveredMemory:{topic:'过去的咨询',text:'这是原样保存的历史摘要。'}};
  const model=build(c);assert.equal(model.hasContent,true);
  assert.deepEqual(model.recovered,c.recoveredMemory);
  assert.deepEqual(model.statements,[]);assert.deepEqual(model.goals,[]);
});
test('assistant assertions never become user evidence, while the last question may be shown',()=>{
  const c=chat(['想聊聊最近的安排。']);
  c.turns[0].response={result:{message:'你的收入很高。你希望先解决哪一件事？'}};
  const model=build(c);assert.equal(model.statements[0].text,c.turns[0].query);
  assert.ok(!JSON.stringify(model.goals).includes('收入'));
  assert.equal(model.question.text,'你希望先解决哪一件事？');
});
