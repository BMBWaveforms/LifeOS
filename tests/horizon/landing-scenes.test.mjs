import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {LANDING_SCENES,sceneAt} from '../../frontend/horizon/landing-scenes.mjs';
import {searchGuides} from '../../frontend/horizon/service.mjs';
const entries=JSON.parse(readFileSync(new URL('../../data/guide.json',import.meta.url))).entries;

test('each selectable scene has distinct real video media and a working guide-backed conversation',()=>{
 assert.ok(LANDING_SCENES.length>=15,'at least 15 curated scenes');
 assert.equal(new Set(LANDING_SCENES.map(s=>s.id)).size,LANDING_SCENES.length);
 assert.equal(new Set(LANDING_SCENES.map(s=>s.video)).size,LANDING_SCENES.length);
 for(const scene of LANDING_SCENES){
  assert.ok(existsSync(new URL('../../frontend/horizon/'+scene.video,import.meta.url)),scene.video);
  const video=readFileSync(new URL('../../frontend/horizon/'+scene.video,import.meta.url));assert.equal(video.toString('ascii',4,8),'ftyp');
  assert.ok(existsSync(new URL('../../frontend/horizon/'+scene.poster,import.meta.url)));
  assert.ok(scene.prompt.length>10&&scene.prompt.length<=2000);
  assert.ok(searchGuides(entries,scene.prompt).length>0,scene.name);
 }
});
test('filmstrip wraps through scenes at both boundaries',()=>{
 assert.equal(sceneAt(-1),LANDING_SCENES.at(-1));
 assert.equal(sceneAt(LANDING_SCENES.length),LANDING_SCENES[0]);
 assert.equal(sceneAt(100),sceneAt(100%LANDING_SCENES.length));
});

test('all scene media are included in the preview manifest, with matching file sizes',()=>{
 const media=JSON.parse(readFileSync(new URL("../../frontend/horizon/assets/media-sources.json",import.meta.url)));
 assert.deepEqual(new Set(media.clips.map(c=>c.name)),new Set(LANDING_SCENES.map(s=>s.id)));
 for(const scene of LANDING_SCENES)for(const path of [scene.video,scene.poster]){
  const file=media.files.find(f=>f.file==='web/'+path);assert.ok(file,path);
  assert.equal(readFileSync(new URL("../../frontend/horizon/"+path,import.meta.url)).length,file.bytes,path);
 }
});
test('new scene starter questions retrieve relevant demo evidence',()=>{
 const expected={budget:['05-27','05-01'],learning:['04-04','04-07'],career:['07-14','29-03'],kitchen:['02-24','02-27'],exercise:['02-16','02-15'],travel:['21-01','21-07'],relationships:['10-04','10-20'],companionship:['17-01','17-03'],pressure:['03-14','03-24'],rest:['03-24','22-08']};
 for(const [id,ids]of Object.entries(expected)){
  const scene=LANDING_SCENES.find(s=>s.id===id);assert.ok(scene,id);
  assert.deepEqual(new Set(searchGuides(entries,scene.prompt).map(c=>c.guide_id)),new Set(ids),id);
 }
});
