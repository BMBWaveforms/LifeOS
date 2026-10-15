const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createMockProduct} = require('../preview/mock-service.js');
const root = path.resolve(__dirname, '..');
const entries = JSON.parse(fs.readFileSync(path.join(root, 'data/guide.json'), 'utf8')).entries;
const ids = ['15-01', '04-18', '03-01', '02-11', '05-01', '21-07', '15-06', '04-07'];
const guides = ids.map(id => entries.find(entry => entry.guide_id === id));
const setup = () => {
  let scenario = 'normal';
  const service = createMockProduct(guides, {extendedGallery:true, delay:0, getDelay:()=>0, getScenario:()=>scenario});
  return {service, scene:value=>scenario=value};
};
const ask = (service, turnId, extra={}) => service.submitMvpMessage({query:'我工作时经常被手机通知打断。', conversationId:'synthetic-c', turnId, guideId:'03-01', ...extra});

test('static demo keeps eight fixed scenes while summary setting controls followups', async () => {
  const {service} = setup();
  await service.login('bob', 'preview');
  assert.equal((await service.getMemories()).enabled, false);
  assert.equal((await ask(service, 'off')).summary.saved, false);
  assert.equal((await service.getMvpHome()).followups.length, 0);
  await service.mutate({action:'settings', enabled:true});
  const result = await ask(service, 'on');
  assert.equal(result.summary.saved, true);
  assert.equal(result.result.relatedGuide.guide_id, '03-01');
  assert.match(result.result.message, /固定情境模拟/);
  const home = await service.getMvpHome();
  assert.equal(home.recommendations.length, 8);
  assert.equal(home.followups.length, 1);
  assert.equal(home.followups[0].memory_id, result.summary.memory_id);
  await service.mutate({action:'settings', enabled:false});
  assert.equal((await service.getMvpHome()).followups.length, 0);
  assert.equal((await service.getMemories()).events.length, 1);
});

test('continued summary replaces the ID; deleted records cannot resume or reappear', async () => {
  const {service} = setup();
  await service.login('bob', 'preview');
  await service.mutate({action:'settings', enabled:true});
  const first = await ask(service, 'one');
  const second = await ask(service, 'two', {followupId:first.summary.memory_id});
  assert.notEqual(first.summary.memory_id, second.summary.memory_id);
  assert.equal((await service.getMemories()).events.length, 1);
  await assert.rejects(ask(service, 'stale', {followupId:first.summary.memory_id}), /已删除/);
  const third = await ask(service, 'three', {followupId:second.summary.memory_id});
  await service.mutate({action:'delete', id:third.summary.memory_id});
  assert.equal((await service.getMvpHome()).followups.length, 0);
  assert.equal((await service.getMvpHome()).recommendations.length, 8);
  await assert.rejects(ask(service, 'deleted', {followupId:third.summary.memory_id}), /已删除/);
});

test('summary failure stays unsaved; fixed resolved feedback exits simulated followup', async () => {
  const {service, scene} = setup();
  await service.login('bob', 'preview');
  await service.mutate({action:'settings', enabled:true});
  scene('summaryfail');
  const failed = await ask(service, 'failed');
  assert.equal(failed.summary.saved, false);
  assert.equal((await service.getMemories()).events.length, 0);
  scene('normal');
  const retry = await service.retryAutomaticMemory('failed');
  const resolved = await ask(service, 'resolved', {followupId:retry.memory_id, query:'这个问题已解决。'});
  assert.equal(resolved.summary.saved, true);
  assert.equal((await service.getMvpHome()).followups.length, 0);
  await service.login('alice', 'preview');
  await assert.rejects(service.retryAutomaticMemory('failed'), /没有待重试/);
});

test('preview build includes only product assets and clearly synthetic records', () => {
  const built = spawnSync(process.env.PYTHON || 'python3', ['scripts/build_preview.py'], {cwd:root, encoding:'utf8'});
  assert.equal(built.status, 0, built.stderr);
  const target = path.join(root, '.preview-site');
  const html = fs.readFileSync(path.join(target, 'index.html'), 'utf8');
  for(const name of ['app.js','api.js','ui.js','services.js','scenes.js','styles.css','preview.js','mock-service.js','fixture.js','preview.css','ATTRIBUTION.txt','GUIDE-LICENSE.txt','assets/fonts/OFL.txt','architecture/index.html']) {
    assert.equal(fs.existsSync(path.join(target, name)), true, name);
  }
  for(const name of ['workbench.html','workbench.js','evaluation.js','evaluation.css','backend','runtime','.runtime','api.json','login.json','auth.json','.env','.env.compose']) {
    assert.equal(fs.existsSync(path.join(target, name)), false, name);
  }
  assert.match(html, /静态交互演示 · 虚构数据/);
  assert.match(html, /没有调用真实 AI 或后端/);
  assert.match(html, /刷新即重置/);
  assert.match(html, /mock-service\.js/);
  const productHtml = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  assert.equal(/<script[^>]+(?:mock-service|preview\.js|fixture\.js)/.test(productHtml), false);
  const mock = fs.readFileSync(path.join(root, 'preview/mock-service.js'), 'utf8');
  const adapter = fs.readFileSync(path.join(root, 'preview/adapter.js'), 'utf8');
  assert.equal(/\bfetch\s*\(|localStorage|sessionStorage/.test(mock), false);
  assert.equal(/window\.fetch\s*=/.test(adapter), false);
});
