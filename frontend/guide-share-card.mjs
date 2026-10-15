// Export only allowlisted guide fields. Conversation text and memory never enter this model.
const text=value=>typeof value==='string'?value:'';
export function buildGuideShareModel(card){
 const fields=card?.fields||{},summary=text(fields['说人话'])||text(fields['收益']);
 if(!text(card?.guide_id)||!text(card?.title)||!summary)return null;
 return {
  id:card.guide_id,title:card.title,locator:text(card.source_locator)||card.guide_id,
  evidence:text(fields['证据等级'])||'未标注',snapshot:'2026-10-12',
  sections:[{label:'建议要点',text:summary,primary:true},...[
   ['需要投入',fields['成本']],['适用范围与提醒',fields['备注']],['出处',fields['来源']],
  ].filter(([,value])=>typeof value==='string'&&value.trim()).map(([label,value])=>({label,text:value}))],
  attribution:'摘录自《高性价比人生指南》\neternity4719 及项目贡献者 · CC BY 4.0',
  project:'github.com/eternity4719/HowToLiveBetter',license:'creativecommons.org/licenses/by/4.0/',
  adaptation:'原文未改写，卡片调整了版式与字段顺序。',
  disclaimer:'内容仅供参考，不构成专业意见。\n请结合自身情况判断并作出决定。',
  filename:'LifeOS-指南-'+card.guide_id.replace(/[^a-z0-9_-]/gi,'-')+'.png',
 };
}
const segments=text=>typeof Intl.Segmenter==='function'?[...new Intl.Segmenter('zh-CN',{granularity:'grapheme'}).segment(text)].map(s=>s.segment):[...text];
export function wrapCardText(value,maxWidth,measure){
 const lines=[],closing=/^[，。！？；：、）》】」』,.!?;:%)\]}]$/,opening=/^[（《【「『(\[{]$/;
 for(const paragraph of String(value).replace(/\r\n?/g,'\n').split('\n')){
  let parts=[];
  for(const char of segments(paragraph)){
   if(parts.length&&measure(parts.join('')+char)>maxWidth){
    let split=parts.length;
    if(parts.length>1&&(closing.test(char)||opening.test(parts.at(-1))))split=parts.length-1;
    else if(/[a-z0-9]/i.test(char)){
     const space=parts.findLastIndex(c=>/\s/.test(c));
     if(space>=0&&space<parts.length-1&&parts.slice(space+1).every(c=>/[a-z0-9/_.:?#=&%-]/i.test(c)))split=space+1;
    }
    if(measure(parts.slice(split).join('')+char)>maxWidth)split=parts.length;
    lines.push(parts.slice(0,split).join(''));parts=parts.slice(split);
   }
   parts.push(char);
  }
  lines.push(parts.join(''));
 }
 return lines;
}
const font='-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
// Logical width 720, exported at 1.5x for a sharp 1080px PNG.
export async function createGuideShareImage(model){
 if(!model)throw Error('这条指南暂时无法生成卡片。');
 await document.fonts.ready;
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
 if(!ctx)throw Error('当前浏览器暂时无法生成图片。');
 const width=720,pad=48,content=width-pad*2,scale=1.5,commands=[];
 const put=(text,x,y,{size=28,weight=400,color='#202020',lineHeight=44,maxWidth=content,balance=false}={})=>{
  ctx.font=`${weight} ${size}px ${font}`;const measure=t=>ctx.measureText(t).width;let lines=wrapCardText(text,maxWidth,measure);
  if(balance&&lines.length>1){const count=lines.length;let low=0,high=maxWidth;for(let i=0;i<12;i++){const middle=(low+high)/2;if(wrapCardText(text,middle,measure).length>count)low=middle;else high=middle;}lines=wrapCardText(text,high,measure);}
  commands.push({type:'text',lines,x,y,size,weight,color,lineHeight});return lines.length*lineHeight;
 };
 const line=y=>commands.push({type:'line',x:pad,y,width:content});
 let y=150;
 y+=put(model.locator+' · 原指南证据等级 '+model.evidence,pad,y,{size:20,lineHeight:30,color:'#666'});y+=18;
 y+=put(model.title,pad,y,{size:36,weight:600,lineHeight:50,balance:true});y+=30;
 for(const section of model.sections){
  if(section.primary){
   const top=y;const rectangle={type:'rect',x:pad,y:top,width:content,height:0};commands.push(rectangle);y+=24;
   y+=put(section.label,pad+24,y,{size:20,lineHeight:30,color:'#666',maxWidth:content-48});y+=12;
   y+=put(section.text,pad+24,y,{maxWidth:content-48});y+=24;rectangle.height=y-top;y+=32;
  }else{
   line(y);y+=24;y+=put(section.label,pad,y,{size:20,lineHeight:30,color:'#666'});y+=12;
   const source=section.label==='出处';y+=put(section.text,pad,y,source?{size:20,lineHeight:32,color:'#666'}:{});y+=30;
  }
 }
 line(y);y+=28;y+=put(model.disclaimer,pad,y,{size:20,lineHeight:32,color:'#666'});y+=24;
 y+=put(model.attribution,pad,y,{size:20,lineHeight:30,color:'#666'});y+=8;
 y+=put(model.project+'\n'+model.license,pad,y,{size:20,lineHeight:30,color:'#777'});y+=12;
 y+=put(model.adaptation+'\n资料快照 · '+model.snapshot,pad,y,{size:20,lineHeight:30,color:'#777'});y+=40;
 if(y>12000)throw Error('这条指南内容较长，暂时无法生成图片，请换一条重试。');
 canvas.width=width*scale;canvas.height=Math.ceil(y*scale);ctx.scale(scale,scale);ctx.textBaseline='top';
 ctx.fillStyle='#fff';ctx.fillRect(0,0,width,y);
 // The product mark is drawn locally; no remote images can taint the canvas.
 ctx.save();ctx.translate(pad,52);ctx.lineWidth=1.6;ctx.strokeStyle='#171717';ctx.stroke(new Path2D('M16 16C4-4-4 4 16 16S36 4 16 16 4 36 16 16 36 36 16 16'));ctx.restore();
 ctx.font=`600 36px ${font}`;ctx.fillStyle='#171717';ctx.fillText('LifeOS',pad+46,48);
 ctx.font=`400 20px ${font}`;ctx.textAlign='right';ctx.fillStyle='#666';ctx.fillText('生活指南 / 摘录',width-pad,60);ctx.textAlign='left';
 ctx.strokeStyle='#dedede';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad,112);ctx.lineTo(width-pad,112);ctx.stroke();
 for(const command of commands){
  if(command.type==='text'){
   ctx.font=`${command.weight} ${command.size}px ${font}`;ctx.fillStyle=command.color;
   command.lines.forEach((value,i)=>ctx.fillText(value,command.x,command.y+i*command.lineHeight));
  }else if(command.type==='line'){
   ctx.strokeStyle='#e3e3e3';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(command.x,command.y);ctx.lineTo(command.x+command.width,command.y);ctx.stroke();
  }else{
   ctx.fillStyle='#f4f4f4';ctx.beginPath();ctx.roundRect(command.x,command.y,command.width,command.height,12);ctx.fill();
  }
 }
 const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('图片生成失败，请重试。')),'image/png'));
 return {blob,width:canvas.width,height:canvas.height,filename:model.filename};
}
