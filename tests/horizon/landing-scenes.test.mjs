import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {LANDING_SCENES,sceneAt} from '../../frontend/landing-scenes.mjs';
import {searchGuides} from '../../frontend/service.mjs';
const entries=JSON.parse(readFileSync(new URL('../../data/guide.json',import.meta.url))).entries;

test('each selectable scene has distinct real video media and a working guide-backed conversation',()=>{
 assert.equal(new Set(LANDING_SCENES.map(s=>s.id)).size,LANDING_SCENES.length);
 assert.equal(new Set(LANDING_SCENES.map(s=>s.video)).size,LANDING_SCENES.length);
 for(const scene of LANDING_SCENES){
  assert.ok(existsSync(new URL('../../frontend/'+scene.video,import.meta.url)),scene.video);
  const video=readFileSync(new URL('../../frontend/'+scene.video,import.meta.url));assert.equal(video.toString('ascii',4,8),'ftyp');
  assert.ok(existsSync(new URL('../../frontend/'+scene.poster,import.meta.url)));
  assert.ok(scene.prompt.length>10&&scene.prompt.length<=2000);
  assert.ok(searchGuides(entries,scene.prompt).length>0,scene.name);
 }
});
test('filmstrip wraps through scenes at both boundaries',()=>{
 assert.equal(sceneAt(-1),LANDING_SCENES.at(-1));
 assert.equal(sceneAt(LANDING_SCENES.length),LANDING_SCENES[0]);
 assert.equal(sceneAt(100),sceneAt(100%LANDING_SCENES.length));
});
