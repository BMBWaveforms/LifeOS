// A view of this conversation's evidence, never a generated personality profile.
const topics=[
  {name:'搬家与住处',pattern:/搬家|租房|房租|看房|房东|押金/},
  {name:'通勤与日常安排',pattern:/通勤|上下班/},
  {name:'专注与打断',pattern:/专注|通知|打断|分心|集中注意|刷手机/},
  {name:'拖延与行动',pattern:/拖延|拖到|拖着/},
  {name:'睡眠与休息',pattern:/睡眠|睡觉|失眠|熬夜|休息|作息/},
];
const hypothetical=text=>/假设|如果|比如|举个例|例如|假如/.test(text);
const aboutOthers=text=>/(?:朋友|同事|家人|别人|他|她)(?:的预算|希望|想要|想|不想|打算)|帮(?:朋友|同事|家人)|替(?:朋友|同事|家人)/.test(text);
const excerpt=(text,length=190)=>text.length>length?text.slice(0,length)+'…':text;
function resultOf(turn){let r=turn?.response?.result;if(typeof r==='string'){try{r=JSON.parse(r);}catch{return null;}}return r;}
const dimensions=[
  ['budget',/预算|租金|房租|月租|费用|价格|支出|花费|价钱|[\d一二三四五六七八九十百千万]+元/],
  ['commute',/通勤|上下班|往返|来回/],
  ['sleep',/睡眠|睡觉|失眠|熬夜|作息|早起|早点睡|睡够/],
  ['focus',/专注|打断|分心|通知|手机/],
  ['quiet',/安静|噪音|隔音/],
  ['light',/采光|朝向|阳光/],
  ['living',/独居|合租|整租|室友/],
  ['location',/地铁|片区|位置|城区|区域|住在|靠近|附近/],
  ['space',/面积|房间|几居|卧室/],
  ['timing',/时间|日期|下周|周末|月底|下月|月末|年底|今年|明年|什么时候/],
];
function dimensionOf(clause,statement){
  const direct=dimensions.find(([,pattern])=>pattern.test(clause));
  if(direct)return direct[0];
  // Quantified follow-on phrases inherit their explicitly named context.
  if(/控制|以内|以下|以上|分钟|小时|[\d一二三四五六七八九十]+[千万元块]/.test(clause)){
    const context=dimensions.find(([,pattern])=>pattern.test(statement));
    if(context)return context[0];
  }
  return 'intent:'+clause.replace(/我想|想要|希望|不想|目标|优先|最在意/g,'').trim();
}

export function buildConversationUnderstanding(conversation){
  const turns=(conversation?.turns||[]).filter(t=>typeof t.query==='string'&&t.query.trim());
  const statements=turns.map((t,index)=>({turnId:t.id,number:index+1,text:t.query.trim(),hypothetical:hypothetical(t.query),example:Boolean(t.response?.example)}));
  const topic=statements.slice().reverse().map(s=>{
    const text=s.text.replace(/(?:先|暂时)?(?:不聊|不谈|不讨论|不考虑)[^，。；\n]*[，。；\n]?/g,'');
    return topics.find(t=>t.pattern.test(text))?.name;
  }).find(Boolean)||conversation?.sceneTitle||'你正在聊的这件事';
  const goals=new Map();
  // Keep literal first-person intent. Questions, hypotheticals and others' lives
  // are not promoted into facts about the user. Corrections remain visible in order.
  for(const statement of statements){
    if(statement.hypothetical||aboutOthers(statement.text))continue;
    for(const match of statement.text.matchAll(/[^，。！？；\n]+/g)){
      const clause=match[0].trim();
      if(/吗$|么$|是否|什么|怎么|多少/.test(clause))continue;
      const dimension=dimensionOf(clause,statement.text);
      if(/(?:不再|不|无需)(?:希望|要求|需要|限制)|(?:不要再|不再|暂时不|先不|暂不)(?:考虑|在意)|(?:取消|撤回|放弃).*?(?:目标|要求|限制)|不限|不设上限/.test(clause)){
        goals.delete(dimension);continue;
      }
      if(/希望|我想|想要|目标|最在意|优先|不想|不能超过|预算/.test(clause)&&!/吗$|么$|是否|什么|怎么|多少|帮.*(朋友|同事)/.test(clause)){
        goals.delete(dimension);goals.set(dimension,{...statement,text:clause,dimension});
      }
    }
  }
  const last=turns.at(-1),result=resultOf(last);
  const question=typeof result?.clarification==='string'?result.clarification:typeof result?.message==='string'?[...result.message.matchAll(/[^。！？\n]+[？?]/g)].at(-1)?.[0]?.trim():'';
  return {
    conversationId:conversation?.id||'',topic,count:turns.length,example:Boolean(conversation?.fixture||statements.some(s=>s.example)),
    statements:statements.slice(-3),goals:[...goals.values()],
    recovered:conversation?.recoveredMemory?.text?{topic:conversation.recoveredMemory.topic,text:conversation.recoveredMemory.text}:null,
    question:question?{text:question,turnId:last.id}:null,
    waiting:last?.status==='waiting',hasContent:Boolean(turns.length||conversation?.recoveredMemory?.text),
  };
}

export function initConversationUnderstanding({getConversation,onReveal,onOpen=()=>{}}){
  const panel=document.getElementById('understanding-panel'),trigger=document.getElementById('understanding-toggle');
  const body=document.getElementById('understanding-body'),note=document.getElementById('understanding-note');
  const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const close=()=>{if(panel.matches(':popover-open'))panel.hidePopover();};
  function source(item){
    const b=make('button','查看原话','understanding-source');b.type='button';
    b.setAttribute('aria-label',`查看第 ${item.number} 次交流的原话`);
    b.onclick=()=>{close();onReveal(item.turnId);};return b;
  }
  function section(title){const e=make('section',undefined,'understanding-section');e.append(make('h3',title));body.append(e);return e;}
  function render(conversation=getConversation()){
    const model=buildConversationUnderstanding(conversation);
    trigger.querySelector('.understanding-dot').hidden=!model.hasContent;
    if(!panel.matches(':popover-open')&&!panel.dataset.opening)return;
    const scroll=body.scrollTop,previous=body.dataset.conversation;
    body.replaceChildren();body.dataset.conversation=model.conversationId;
    if(!model.hasContent){
      const empty=make('div',undefined,'understanding-empty');
      empty.append(make('h3','从你说起，慢慢了解。'),make('p','这段对话还没有内容。说说正在经历的事，我们会从你的原话里整理线索。'));
      body.append(empty);note.textContent='每段对话，保留各自的理解。';
    }else{
      const intro=make('div',undefined,'understanding-intro');
      intro.append(make('h3',model.topic),make('p',model.example?'含项目示例 · 按各轮原话整理。':'从你在这段对话中的原话整理。'));
      body.append(intro);
      if(model.recovered){const s=section('接上之前的线索');s.append(make('p',model.recovered.text,'understanding-memory'));}
      if(model.goals.length){const s=section('你表达的目标与偏好');for(const item of model.goals){const row=make('div',undefined,'understanding-goal');row.append(make('p',item.text),source(item));s.append(row);}}
      if(model.statements.length){const s=section('最近提到的情况');for(const item of model.statements){const row=make('div',undefined,'understanding-statement');row.append(make('p',excerpt(item.text)));const meta=make('div',undefined,'understanding-evidence');meta.append(make('span',(item.example?'示例 · ':'')+(item.hypothetical?'你提出的情境':'第 '+item.number+' 次交流')),source(item));row.append(meta);s.append(row);}}
      const next=section(model.waiting?'正在听你补充':'还想进一步了解');
      next.append(make('p',model.waiting?'刚刚说的内容已经在这里，等这一轮答复完成后，我们再接着梳理。':model.question?.text||'还有哪些限制或偏好，是你希望一起考虑的？','understanding-question'));
      note.textContent='仅当前对话 · '+model.count+' 次交流'+(model.recovered?' · 已带入历史摘要':'');
    }
    body.scrollTop=previous===model.conversationId?scroll:0;
  }
  panel.addEventListener('beforetoggle',event=>{if(event.newState==='open'){onOpen();panel.dataset.opening='true';render();delete panel.dataset.opening;}});
  panel.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(panel.matches(':popover-open'))));
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&panel.matches(':popover-open')){
      event.preventDefault();close();trigger.focus({preventScroll:true});
    }
  });
  return {render,close};
}
