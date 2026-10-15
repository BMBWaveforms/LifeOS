import {buildGuideShareModel,createGuideShareImage} from './guide-share-card.mjs';
const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const button=(text,cls)=>{const e=make('button',text,cls);e.type='button';return e;};
export function shareableGuides(cards){return (Array.isArray(cards)?cards:[]).map(buildGuideShareModel).filter(Boolean);}
export function renderGuideShare(body,models){
 let selected=0,version=0,disposed=false,url='',prepared=null;
 const layout=make('div',undefined,'guide-share-layout'),stage=make('div',undefined,'guide-share-stage');
 stage.setAttribute('aria-label','指南图片预览');stage.tabIndex=0;
 const preview=make('img',undefined,'guide-share-image');preview.hidden=true;
 const placeholder=make('p','正在生成卡片…','guide-share-placeholder');stage.append(placeholder,preview);
 const controls=make('div',undefined,'guide-share-controls'),intro=make('p','选择一条指南，做成卡片发给朋友。','guide-share-intro');controls.append(intro);
 const choices=make('fieldset',undefined,'guide-share-choices');choices.append(make('legend','本轮指南'));
 const radios=[];
 models.forEach((model,i)=>{
  const label=make('label',undefined,'guide-share-choice'),input=make('input');input.type='radio';input.name='share-guide';input.value=String(i);input.checked=i===0;
  input.onchange=()=>{if(input.checked&&selected!==i){selected=i;generate();}};
  const copy=make('span');copy.append(make('strong',model.title),make('span',model.locator));label.append(input,copy);choices.append(label);radios.push(input);
 });controls.append(choices);
 controls.append(make('p','仅包含指南内容，不包含聊天原话或个人记忆。','guide-share-privacy'));
 const actions=make('div',undefined,'guide-share-actions'),native=button('分享给朋友','guide-share-native'),save=button('保存图片','guide-share-save'),retry=button('重新生成','guide-share-retry');
 native.hidden=true;retry.hidden=true;save.disabled=true;native.disabled=true;actions.append(native,save,retry);controls.append(actions);
 const status=make('p','正在生成卡片…','guide-share-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');controls.append(status);
 const transcript=make('div',undefined,'sr-only');transcript.setAttribute('aria-label','分享卡片的文字内容');
 layout.append(stage,controls,transcript);body.append(layout);
 function supportsFileShare(file){try{return typeof navigator.share==='function'&&typeof navigator.canShare==='function'&&navigator.canShare({files:[file]});}catch{return false;}}
 async function generate(){
  const job=++version,model=models[selected];prepared=null;save.disabled=true;native.disabled=true;retry.hidden=true;native.hidden=true;
  stage.setAttribute('aria-busy','true');placeholder.hidden=false;placeholder.textContent='正在生成卡片…';preview.hidden=true;status.textContent='正在生成卡片…';
  if(url){URL.revokeObjectURL(url);url='';preview.removeAttribute('src');}
  transcript.replaceChildren(make('h3',model.title),make('p',model.locator+' · 证据等级 '+model.evidence+' · '+model.snapshot),...model.sections.map(s=>make('p',s.label+'：'+s.text)),make('p',model.attribution+'\n'+model.project+'\n'+model.license),make('p',model.disclaimer));
  try{
   const image=await createGuideShareImage(model);if(disposed||job!==version)return;
   url=URL.createObjectURL(image.blob);preview.src=url;preview.alt=model.title+'，指南摘录卡片';await preview.decode();
   if(disposed||job!==version)return;
   const file=new File([image.blob],image.filename,{type:'image/png'});prepared={...image,file,model,url};
   preview.hidden=false;placeholder.hidden=true;stage.scrollTop=0;stage.dataset.guideId=model.id;stage.removeAttribute('aria-busy');
   save.disabled=false;native.disabled=false;native.hidden=!supportsFileShare(file);save.classList.toggle('secondary',!native.hidden);
   status.textContent=native.hidden?'图片已生成，保存后即可发给朋友。':'图片已生成，可直接分享或保存。';
  }catch(error){
   if(disposed||job!==version)return;stage.removeAttribute('aria-busy');placeholder.textContent='卡片暂时没有生成';status.textContent=error.message||'图片生成失败，请重试。';retry.hidden=false;
  }
 }
 retry.onclick=generate;
 save.onclick=()=>{
  if(!prepared)return;const a=make('a');a.href=prepared.url;a.download=prepared.filename;a.hidden=true;document.body.append(a);a.click();a.remove();status.textContent='已发起图片下载，保存后即可发给朋友。';
 };
 native.onclick=async()=>{
  if(!prepared)return;const current=prepared,job=version;
  native.disabled=true;save.disabled=true;radios.forEach(r=>r.disabled=true);
  try{await navigator.share({files:[current.file],title:current.model.title});if(!disposed&&job===version)status.textContent='已完成系统分享。';}
  catch(error){if(!disposed&&job===version)status.textContent=error.name==='AbortError'?'已取消分享，卡片仍可保存。':'暂时无法直接分享，请保存图片后发送。';}
  finally{if(!disposed&&job===version){native.disabled=false;save.disabled=false;radios.forEach(r=>r.disabled=false);}}
 };
 generate();
 return ()=>{disposed=true;version++;if(url)URL.revokeObjectURL(url);url='';prepared=null;};
}
