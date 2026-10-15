/* Desktop MVP. Product state stays separate from temporary visual styling. */
(() => {
  const UI=window.LifeUI, API=window.LifeAPI, {$,element:E,paragraph:P}=UI;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const sceneImages={
    '15-01':{src:'assets/scene-moving.webp',alt:'阳光下的搬家纸箱与新住处'},
    '04-18':{src:'assets/scene-commute.webp',alt:'晨光里坐在列车窗边的乘客'},
    '03-01':{src:'assets/scene-focus.webp',alt:'窗边的笔记本、电脑和工作桌'},
    '02-11':{src:'assets/scene-walking.webp',alt:'金色晨光下的街巷漫步'},
    '05-01':{src:'assets/scene-moving.webp',alt:'阳光下的搬家纸箱与新住处'},
    '21-07':{src:'assets/scene-commute.webp',alt:'晨光里坐在列车窗边的乘客'},
    '15-06':{src:'assets/scene-focus.webp',alt:'窗边的笔记本、电脑和工作桌'},
    '04-07':{src:'assets/scene-walking.webp',alt:'金色晨光下的街巷漫步'}
  };
  function icon(name){const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),use=document.createElementNS(ns,'use');svg.setAttribute('class','icon');svg.setAttribute('aria-hidden','true');use.setAttribute('href','#i-'+name);svg.append(use);return svg;}
  const uid=prefix=>prefix+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
  let service=window.PreviewProduct||window.RealProduct(API), user=null, epoch=0, busy=null;
  let conversations=[],activeId='',memories=null,home=null,historyLoaded=false;
  const pendingFeedback=new Map();
  const mock=()=>service.mode==='mock',active=()=>conversations.find(c=>c.id===activeId);
  const stamp=()=>({epoch,owner:user?.id,service}),current=c=>c.epoch===epoch&&c.owner===user?.id&&c.service===service;
  const say=(text,tone='')=>UI.status(text,tone);
  let modalRestore=null,loading=false,focusedRecommendationId='',galleryMotion=null,pendingDraft=null;
  const scenes=window.LifeScenes||[];
  const button=(box,text,fn,style='',lock=true)=>{
    const b=UI.button(box,text,fn,style);const suffix=text.match(/[→↗↑↓]$/);if(suffix){b.textContent=text.slice(0,-1).trim();b.append(icon({'→':'right','↗':'diagonal','↑':'up','↓':'down'}[suffix[0]]));}if(lock)b.dataset.lock='true';return b;
  };
  const row=box=>{const n=E('div',undefined,'row');box.append(n);return n;};
  function input(box,label,value='',type='text') {
    const n=E('input');n.type=type;n.id=uid('field');n.value=value;
    const l=E('label',label);l.htmlFor=n.id;box.append(l,n);return n;
  }
  function select(box,label,options,value) {
    const n=E('select');n.id=uid('select');const l=E('label',label);l.htmlFor=n.id;box.append(l,n);
    for(const [key,text] of options){const o=E('option',text);o.value=key;n.append(o);}n.value=value;return n;
  }
  function sync() {
    $('ask').disabled=loading||!!busy||!$('query').value.trim();
    $('today-send').disabled=loading||!!busy||!$('today-query').value.trim();
    $('stop').hidden=busy?.kind!=='chat';
    $('stop').textContent=mock()?'停止':'停止等待';
    $('login-submit').disabled=loading||!!busy;$('profile-entry').disabled=loading;
    for(const n of document.querySelectorAll('[data-control]'))n.disabled=loading||!!busy;
    for(const n of document.querySelectorAll('[data-lock]'))n.disabled=loading||!!busy||!user;
    $('askform').setAttribute('aria-busy',String(busy?.kind==='chat'));
    $('continue-latest').hidden=!conversations.some(c=>c.messages.length);
    $('conversation-menu').disabled=!!busy||!active();updateCardControls();
  }
  function route(name) {
    const hash='#/'+name;if(location.hash!==hash)location.hash=hash;else renderRoute();
  }
  function renderRoute() {
    const chat=['#/agent','#/chat'].includes(location.hash);
    if(chat)galleryMotion?.stop();
    document.body.classList.toggle('home-active',!chat);
    if(!chat&&!$('history-panel').hidden)toggleHistory(false);
    $('view-today').hidden=chat;$('view-agent').hidden=!chat;
    if(['#/life','#/settings','#/profile'].includes(location.hash)){route('agent');openProfile();return;}
    if(!chat&&!['#/today',''].includes(location.hash))history.replaceState(null,'','#/today');
    sync();
  }
  let historyPinned=false,historyHideTimer=0;
  function toggleHistory(open=!historyPinned,{pin=true,focus=pin}={}) {
    clearTimeout(historyHideTimer);
    const show=!!open;
    if(pin||!show)historyPinned=show&&pin;
    $('history-panel').hidden=!show;
    document.body.classList.toggle('history-open',show);
    document.body.classList.toggle('history-pinned',show&&historyPinned);
    document.body.classList.toggle('history-preview',show&&!historyPinned);
    $('history-toggle').setAttribute('aria-expanded',String(show));
    $('history-toggle').setAttribute('aria-pressed',String(historyPinned));
    const label=historyPinned?'取消固定并收起对话历史':'固定对话历史';
    $('history-toggle').setAttribute('aria-label',label);$('history-toggle').title=label;
    if(show&&focus)$('history-search').focus({preventScroll:true});
    galleryMotion?.stop();requestAnimationFrame(()=>window.dispatchEvent(new Event('resize')));
    if(show&&!historyLoaded&&user)loadHistory();
    if(!show&&$('history-panel').contains(document.activeElement))$('history-toggle').focus({preventScroll:true});
  }
  function previewHistory() {
    clearTimeout(historyHideTimer);
    if(historyPinned||$('view-agent').hidden||$('modal').open)return;
    toggleHistory(true,{pin:false,focus:false});
  }
  function scheduleHistoryClose() {
    clearTimeout(historyHideTimer);
    if(historyPinned)return;
    historyHideTimer=setTimeout(()=>{
      if(!historyPinned&&!$('history-panel').matches(':hover')&&!$('history-toggle').matches(':hover')&&!$('history-hover-zone').matches(':hover')&&!$('history-panel').contains(document.activeElement))toggleHistory(false,{focus:false});
    },220);
  }
  function closeModal() {
    if($('modal').open)$('modal').close();
    $('modal').classList.remove('profile-dialog');
    if(modalRestore?.isConnected)modalRestore.focus({preventScroll:true});modalRestore=null;
  }
  function modal(title,build,profile=false) {
    galleryMotion?.stop();closeModal();modalRestore=document.activeElement;
    $('modal-title').textContent=title;$('modal-body').replaceChildren();$('modal-actions').replaceChildren();$('modal-error').textContent='';
    $('modal-form').onsubmit=e=>e.preventDefault();$('modal').classList.toggle('profile-dialog',profile);
    build($('modal-body'),$('modal-actions'));$('modal').showModal();
    ($('modal-body').querySelector('input,select,textarea')||$('modal-close')).focus();sync();
  }
  function failure(error,c) {
    if(!current(c)||error.name==='AbortError')return;
    if(error.status===401){resetPrivate();say('登录已失效，个人内容已清除。','error');}
    else {say(error.message,'error');if($('modal').open)$('modal-error').textContent=error.message;}
  }
  async function run(kind,fn) {
    if(loading){say('正在载入账号资料，请稍等。');return;}
    if(busy){say('上一项操作仍在处理，请稍等或停止等待。');return;}
    const token={kind,ctx:stamp()};busy=token;sync();
    try{return await fn(token.ctx);}catch(error){failure(error,token.ctx);}
    finally{if(busy===token){busy=null;sync();}}
  }
  function persist(c=active()) {if(mock()&&c?.messages.length)service.saveMvpConversation(c);}
  function preserveDraft() {if(active()){active().draft=$('query').value;persist();}}
  function makeConversation(options={}) {
    const c={id:uid('conversation'),serverId:'',title:'新对话',group:'',messages:[],draft:'',context:null,guideId:'',...options};
    conversations.unshift(c);activeId=c.id;$('query').value=c.draft;return c;
  }
  function newChat(options={}) {
    if(loading||busy){say('请先完成当前操作，再开始新对话。');return;}
    preserveDraft();if(!user)pendingDraft=null;const c=makeConversation(options);renderChat(true);renderHistory();route('agent');requestAnimationFrame(()=>{if(activeId===c.id&&!$('view-agent').hidden)$('query').focus();});return c;
  }
  async function readMemories(c) {
    const value=await service.getMemories();if(!current(c))return false;memories=value;
    if(!mock()){const valid=new Set((value.effective||[]).map(m=>m.id));for(const conversation of conversations){if(conversation.followupId&&!valid.has(conversation.followupId))conversation.followupId='';}}
    return true;
  }

  function createOrbitGallery(track,cards,selected,onSelect) {
    const reduced=matchMedia('(prefers-reduced-motion: reduce)'),events=new AbortController();
    let phase=selected,target=null,velocity=0,frame=0,last=0,drag=null,suppressUntil=0,disposed=false,reported=-1;
    const count=cards.length,mod=n=>((n%count)+count)%count;
    const enabled=()=>!disposed&&!loading&&!busy&&!$('modal').open&&!$('view-today').hidden;
    const nearest=()=>mod(Math.round(phase));
    // Render copies form one large ring; canonical cards retain product identity and keyboard access.
    const total=count>1?Math.max(12,count):1,repeats=Math.ceil(total/count),planes=[...cards];
    if(count>1)for(let copy=1;copy<repeats;copy++)for(const card of cards){
      const proxy=card.cloneNode(true);delete proxy.dataset.recommendation;proxy.dataset.galleryCopy=card.dataset.recommendation;
      proxy.setAttribute('aria-hidden','true');
      const originals=[...card.querySelectorAll('button')];
      proxy.querySelectorAll('button').forEach((button,i)=>{button.tabIndex=-1;button.onclick=()=>originals[i].click();});
      track.append(proxy);planes.push(proxy);
    }
    function draw(){
      // Inward-facing planes, a pitched camera, and homogeneous projection.
      // Reference: radius 15.2, plane height 8.1, 60 degree lens; UI framing is adapted.
      const radius=15.2*.95,pitch=Math.atan2(2.2,15.2*.9),cp=Math.cos(pitch),sp=Math.sin(pitch);
      const width=track.clientWidth,height=track.clientHeight,focal=height*1.27/(2*Math.tan(Math.PI/6)),anchor=height*.52,occupied=new Set();
      planes.forEach((card,index)=>{
        const i=index%count,copy=Math.floor(index/count),slot=i+(Math.round((phase-i)/count)+copy)*count;
        const angle=count===1?0:(slot-phase)*Math.PI*2/total,c=Math.cos(angle),sn=Math.sin(angle);
        const sourceY=15.2*Math.cos(.52*Math.PI+.24*(((slot%3)+3)%3-1))*.88;
        const elevation=sourceY-Math.max(0,sourceY)*.8-.9;
        const center=[radius*sn,elevation*.3,radius*c];
        const imageHeight=card.querySelector?.('.card-cover')?.offsetHeight||390;
        const planeHeight=7.4; // B03: one shared card size, ~9% smaller; orbit and camera unchanged.
        const imageWidth=card.offsetWidth||imageHeight*.75,scale=planeHeight/imageHeight;
        const normal=[-center[0],-(elevation-1.25),-(center[2]-.45)];
        const length=Math.hypot(...normal);normal.forEach((v,j)=>normal[j]=v/length);
        const right=[-normal[2],0,normal[0]],rl=Math.hypot(...right);right.forEach((v,j)=>right[j]=v/rl);
        const up=[right[1]*normal[2]-right[2]*normal[1],right[2]*normal[0]-right[0]*normal[2],right[0]*normal[1]-right[1]*normal[0]];
        const origin=center.map((v,j)=>v-right[j]*imageWidth*scale/2+up[j]*planeHeight/2);
        const camera=v=>[v[0],v[1]*cp+v[2]*sp,-v[1]*sp+v[2]*cp];
        const o=camera(origin),a=camera(right.map(v=>v*scale)),b=camera(up.map(v=>-v*scale)),den=o[2];
        const m=[(width/2*a[2]+focal*a[0])/den,(anchor*a[2]-focal*a[1])/den,0,a[2]/den,
          (width/2*b[2]+focal*b[0])/den,(anchor*b[2]-focal*b[1])/den,0,b[2]/den,
          0,0,1,0,width/2+focal*o[0]/den,anchor-focal*o[1]/den,0,1];
        card.style.transform='matrix3d('+m.map(v=>v.toFixed(7)).join(',')+')';
        card.style.zIndex=String(Math.round((c+1)*100));
        card.dataset.caption=Math.abs(Math.atan2(sn,c))<=Math.PI*2/total*1.25?'show':'hide';
        const slotKey=((slot%total)+total)%total,duplicate=occupied.has(slotKey);occupied.add(slotKey);
        const visible=!duplicate&&c>.3&&den>0;card.style.visibility=visible?'visible':'hidden';card.style.pointerEvents=visible?'auto':'none';
        card.inert=!visible;card.style.opacity='1';
      });
      const index=nearest();if(reported!==index){reported=index;onSelect(cards[index].dataset.recommendation);}
      track.dataset.moving=String(!!drag||target!==null||Math.abs(velocity)>.01);
    }
    function cancelFrame(){cancelAnimationFrame(frame);frame=0;last=0;}
    function settle(){cancelFrame();drag=null;velocity=0;phase=target===null?phase:target;target=null;track.classList.remove('is-dragging');draw();}
    function tick(now){
      frame=0;if(!enabled()||document.hidden){settle();return;}
      const dt=last?Math.min((now-last)/1000,.04):1/60;last=now;
      if(!drag){
        if(target!==null){phase+=(target-phase)*(1-Math.exp(-10*dt));if(Math.abs(target-phase)<.0008){phase=target;target=null;velocity=0;}}
        else {phase+=velocity*dt;velocity*=Math.exp(-5*dt);if(Math.abs(velocity)<.025)velocity=0;}
      }
      draw();if(!drag&&(target!==null||Math.abs(velocity)>.01))frame=requestAnimationFrame(tick);else last=0;
    }
    function wake(){track.dataset.moving="true";if(!frame){last=0;frame=requestAnimationFrame(tick);}}
    function select(index,immediate=false){
      const base=target===null?phase:target;
      let distance=mod(index)-mod(base);if(distance>count/2)distance-=count;if(distance< -count/2)distance+=count;
      target=base+distance;velocity=0;
      if(immediate||reduced.matches||count<2){phase=target;target=null;cancelFrame();draw();}else wake();
    }
    track.classList.add('orbit-gallery');
    track.setAttribute('aria-label','情境画廊，可用左右方向键选择，点击卡片阅读');
    track.addEventListener('wheel',event=>{
      if(!enabled()||count<2||reduced.matches||event.ctrlKey||event.metaKey)return;
      const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY;
      if(!delta)return;event.preventDefault();target=null;
      const pixels=delta*(event.deltaMode===1?16:event.deltaMode===2?track.clientHeight:1);
      velocity=Math.max(-5,Math.min(5,velocity+Math.max(-160,Math.min(160,pixels))*.022));wake();
    },{passive:false,signal:events.signal});
    track.addEventListener('pointerdown',event=>{
      if(!enabled()||count<2||reduced.matches||event.button!==0||event.target.closest('.card-dismiss'))return;
      cancelFrame();target=null;velocity=0;drag={id:event.pointerId,start:event.clientX,x:event.clientX,time:performance.now(),moved:false};
    },{signal:events.signal});
    track.addEventListener('pointermove',event=>{
      if(!drag||drag.id!==event.pointerId)return;
      if(!enabled()){settle();return;}
      const now=performance.now(),dx=event.clientX-drag.x;
      if(!drag.moved&&Math.abs(event.clientX-drag.start)<7)return;
      if(!drag.moved){drag.moved=true;track.setPointerCapture(event.pointerId);track.classList.add('is-dragging');}
      event.preventDefault();const delta=-dx/Math.max(230,track.clientWidth*.28);
      phase+=delta;velocity=Math.max(-4,Math.min(4,delta/Math.max(.016,(now-drag.time)/1000)));
      drag.x=event.clientX;drag.time=now;draw();
    },{signal:events.signal});
    function release(event){
      if(!drag||drag.id!==event.pointerId)return;
      const moved=drag.moved,stale=performance.now()-drag.time>100;
      drag=null;track.classList.remove('is-dragging');
      if(track.hasPointerCapture(event.pointerId))track.releasePointerCapture(event.pointerId);
      if(moved){suppressUntil=performance.now()+350;if(stale||event.type==='pointercancel')velocity=0;wake();}
    }
    track.addEventListener('pointerup',release,{signal:events.signal});
    track.addEventListener('pointercancel',release,{signal:events.signal});
    track.addEventListener('pointerleave',event=>{if(drag&&!drag.moved)release(event);},{signal:events.signal});
    track.addEventListener('click',event=>{if(performance.now()<suppressUntil){event.preventDefault();event.stopImmediatePropagation();}else settle();},{capture:true,signal:events.signal});
    track.addEventListener('dragstart',event=>event.preventDefault(),{signal:events.signal});
    window.addEventListener('resize',draw,{signal:events.signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)settle();},{signal:events.signal});
    reduced.addEventListener('change',settle,{signal:events.signal});
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(draw):null;observer?.observe(track);for(const card of cards)observer?.observe(card);draw();
    return {select,stop:settle,step(direction){if(!enabled()||count<2)return;target=Math.round(target===null?phase:target)+direction;velocity=0;if(reduced.matches){phase=target;target=null;cancelFrame();draw();}else wake();},dispose(){disposed=true;cancelFrame();observer?.disconnect();events.abort();}};
  }

  function skeletonHome() {
    galleryMotion?.dispose();galleryMotion=null;
    const track=E('div',undefined,'card-track focus-gallery loading-gallery');
    for(let i=0;i<3;i++){const card=E('div',undefined,'radar-card');card.append(E('span','—','card-index'),E('div',undefined,'skeleton card-cover'),E('div',undefined,'skeleton-line'));track.append(card);}
    $('home').replaceChildren(track);
  }
  async function readHome(c) {
    $('home').setAttribute('aria-busy','true');
    try {const value=await (mock()?service.getMvpHome():service.getHome());if(!current(c))return;home=value;renderHome();}
    finally {if(current(c))$('home').setAttribute('aria-busy','false');}
  }
  function renderHome() {
    galleryMotion?.dispose();galleryMotion=null;
    const box=$('home');box.replaceChildren();
    const recommendations=mock()?(home?.recommendations||[]):scenes.map(scene=>({...scene,guide:{guide_id:scene.guide_id,title:scene.guide_title}}));
    const track=E('div',undefined,'card-track focus-gallery');track.setAttribute('aria-label','情境画廊，可用左右方向键选择');track.tabIndex=0;
    for(const rec of recommendations){
      const card=E('article',undefined,'radar-card');card.dataset.recommendation=rec.id;
      const open=button(card,'',()=>{focusRecommendation(rec.id);startRecommendation(rec);},'card-open',false);open.setAttribute('aria-label','聊聊'+rec.title);
      card.addEventListener('focusin',event=>{if(event.target.matches(':focus-visible'))focusRecommendation(rec.id);});
      const cover=E('div',undefined,'card-cover'),photo=rec.image?{src:rec.image,alt:rec.alt}:sceneImages[rec.guide.guide_id];
      if(photo){const image=E('img');image.src=photo.src;image.alt=photo.alt;image.width=960;image.height=1280;image.decoding='async';cover.append(image);}else cover.classList.add('skeleton');
      const heading=E('div',undefined,'card-heading');heading.append(E('h3',rec.title),icon('diagonal'));open.append(cover,heading);
      if(mock())button(card,'不想看',()=>ignoreRecommendation(rec),'text-button card-dismiss');track.append(card);
    }
    box.append(track);focusRecommendation(focusedRecommendationId);
    const cards=[...track.children];
    if(cards.length)galleryMotion=createOrbitGallery(track,cards,Math.max(0,cards.findIndex(card=>card.dataset.recommendation===focusedRecommendationId)),id=>focusRecommendation(id,false));
    track.addEventListener('keydown',event=>{if(event.target!==track)return;if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();scrollCards(event.key==='ArrowRight'?1:-1);}});
    if(!cards.length){track.hidden=true;P(box,'你可以直接聊聊正在经历的事。','empty');}
    renderFollowups();updateCardControls();renderPending();sync();
  }
  function renderFollowups() {
    const box=$('followups');box.replaceChildren();box.hidden=!user;
    if(!user)return;
    const heading=E('div',undefined,'section-heading');heading.append(E('h2','上次聊到的事'));
    button(heading,'刷新回访',refreshHome,'text-button');box.append(heading);
    if(!memories){P(box,'个人记忆暂时未能读取，可以在个人档案中重试。','hint');return;}
    if(!memories.enabled){P(box,'开启个人记忆后，这里会问问上次的进展。','hint');button(box,'管理个人记忆',openProfile,'text-button');return;}
    for(const f of home?.followups||[]){const card=E('article',undefined,'notice followup-card');card.append(E('h3',f.progress_question||f.topic));P(card,f.guide_question||'还需要继续咨询吗？','hint');
      const actions=row(card);button(actions,'继续咨询',()=>startFollowup(f));button(actions,'已经解决',()=>startFollowup(f,'resolved'),'text-button');button(actions,'还没解决',()=>startFollowup(f,'unresolved'),'text-button');box.append(card);}
    if(!(home?.followups||[]).length)P(box,'暂时没有需要回访的问题。','hint');
  }
  function startFollowup(f,progress='') {
    if(!memories?.enabled){say('先在个人档案中开启记忆，才能接着记录进展。');return;}
    const query=progress==='resolved'?'关于“'+f.topic+'”，这个问题已经解决了，暂时先帮我记录进展。':progress==='unresolved'?'关于“'+f.topic+'”，这个问题还没解决，暂时先帮我记录进展。':'关于“'+f.topic+'”，我想继续咨询。';
    const c=newChat({title:f.topic||'接着聊',followupId:f.memory_id,memoryId:f.memory_id,resumeNotice:'接着已保存的摘要聊。'});
    if(c){$('query').value=query;c.draft=query;sync();if(progress)send();}
  }
  function focusRecommendation(id,animate=true){
    const cards=[...$('home').querySelectorAll('.radar-card[data-recommendation]')];
    let selected=cards.findIndex(card=>card.dataset.recommendation===id);if(selected<0)selected=0;
    focusedRecommendationId=cards[selected]?.dataset.recommendation||'';
    cards.forEach((card,index)=>{const distance=(index-selected+cards.length)%cards.length;
      card.dataset.position=distance===0?'center':distance===cards.length-1&&cards.length>2?'left':distance===1?'right':'outside';
      const open=card.querySelector('.card-open'),title=card.querySelector('h3').textContent;
      open.setAttribute('aria-label','进入'+title);open.setAttribute('aria-pressed',String(index===selected));
      if(!card.closest('.orbit-gallery'))card.inert=card.dataset.position==='outside';
    });
    if(animate)galleryMotion?.select(selected);
    $('gallery-count').textContent=cards.length?String(selected+1).padStart(2,'0')+' / '+String(cards.length).padStart(2,'0'):'';
    updateCardControls();
  }
  function updateCardControls(){const count=$('home').querySelectorAll('.radar-card[data-recommendation]').length;$('gallery-instruction').hidden=count<2;if(!count)$('gallery-count').textContent='';for(const id of ['cards-prev','cards-next']){$(id).hidden=count<2;$(id).disabled=loading||!!busy||count<2;}}

  async function refreshHome() {
    await run('home',async c=>{
      try{await readMemories(c);await readHome(c);if(current(c))say('回访已更新。');}
      catch(e){if(!current(c))throw e;renderHomeError();throw e;}
    });
  }
  function renderHomeError() {
    $('home').querySelector('.home-read-error')?.remove();const n=E('div',undefined,'notice home-read-error');
    P(n,'回访暂时未能更新，情境入口和你的输入仍然保留。');button(n,'重试',refreshHome);$('followups').append(n);sync();
  }
  function renderPending() {
    $('pending-feedback').replaceChildren();
    for(const [id,rec] of pendingFeedback){const n=E('div',undefined,'notice');P(n,'“'+rec.title+'”的反馈结果待确认。');button(n,'查询结果',()=>queryFeedback(id));$('pending-feedback').append(n);}
  }
  async function ignoreRecommendation(rec) {
    if([...pendingFeedback.values()].some(r=>r.id===rec.id)){say('这条推荐有待确认的反馈，请先查询结果。');return;}
    await run('feedback',async c=>{
      const result=await service.feedbackMvp(rec.id,uid('feedback'));if(!current(c))return;
      if(result.status==='unknown'){pendingFeedback.set(result.operationId,rec);renderPending();say('反馈结果待确认，暂不移除推荐。');}
      else {if(home)home.recommendations=home.recommendations.filter(r=>r.id!==rec.id);renderHome();if($('modal').open)closeModal();say('已移除当前推荐，个人记忆保留。');}
    });
  }
  async function queryFeedback(id) {
    await run('feedback',async c=>{
      const result=await service.readOperationResult(id);if(!current(c))return;
      if(result.status==='unknown'){say('结果仍待确认，请稍后查询。');return;}
      const rec=pendingFeedback.get(id);pendingFeedback.delete(id);
      if(result.status==='confirmed'&&home)home.recommendations=home.recommendations.filter(r=>r.id!==rec?.id);
      renderHome();say(result.status==='confirmed'?'反馈已确认，当前推荐已移除。':'反馈未成功，原推荐仍保留。',result.status==='confirmed'?'':'error');
    });
  }
  function displayGuide(guide) {
    modal(guide.title||'指南详情',(box,actions)=>{
      UI.card(box,guide);
      button(actions,'围绕这件事继续问',()=>startRecommendation({id:'guide-'+guide.guide_id,title:guide.title,guide}), 'primary');
      button(actions,'关闭',closeModal,'',false);
    });
  }
  async function showGuide(guide) {
    if(mock()){displayGuide(guide);return;}
    await run('guide',async ctx=>{const fresh=await service.guide(guide.guide_id);if(current(ctx))displayGuide(fresh);});
  }
  function startRecommendation(rec) {
    if(loading||busy)return;closeModal();
    const guideId=rec.guide_id||rec.guide?.guide_id||'',draft=rec.draft||'关于“'+(rec.guide?.title||rec.guide_title||rec.title)+'”，我想继续了解。';
    const c=newChat({title:rec.title,group:rec.title,recommendationId:rec.id,recommendationTitle:rec.title,guideId,draft});
    if(c){$('query').value=draft;sync();}
  }
  async function loadHistory() {
    if(!user)return;
    await run('history',async c=>{if(mock()){const items=await service.listMvpConversations();if(!current(c))return;const local=active();conversations=items;if(local&&!items.some(x=>x.id===local.id))conversations.unshift(local);}
      historyLoaded=true;renderHistory();});
  }
  function renderHistory() {
    const box=$('topics');box.replaceChildren();const search=$('history-search').value.trim().toLowerCase();
    const items=conversations.filter(c=>c.messages.length&&(c.title+' '+c.messages.map(t=>t.query).join(' ')).toLowerCase().includes(search));
    const groups=[...new Set(items.map(c=>c.group||'其他'))];
    for(const name of groups){const group=E('details',undefined,'history-group');group.open=true;const count=items.filter(c=>(c.group||'其他')===name);group.append(E('summary',name+' · '+count.length));
      for(const c of count){const item=E('article',undefined,'topic-row'+(c.id===activeId?' active':''));button(item,c.title,()=>restoreConversation(c.id));group.append(item);}box.append(group);}
    if(!items.length)P(box,search?'没有找到相关对话。':'本页还没有对话。','hint');
    $('history-note').textContent=mock()?'固定场景模拟 · 会话和记忆仅保留在当前页面，刷新后重置。':'仅保留本页对话，刷新或退出后清除；开启记忆后保存的摘要可在个人档案查看。';
    sync();
  }
  async function restoreConversation(id) {
    if(busy){say('请先停止等待，再切换对话。');return;}
    preserveDraft();
    await run('history',async ctx=>{
      let c=conversations.find(x=>x.id===id),summary='';
      if(mock()){
        const result=await service.getConversationSummary(id);if(!current(ctx))return;
        if(!result.exists){say('原对话已删除，请刷新历史。','error');return;}
        c=result.conversation;summary=result.summary;
        const index=conversations.findIndex(x=>x.id===id);if(index<0)conversations.unshift(c);else conversations[index]=c;
      }else {summary='' ;}
      if(!c)return;activeId=c.id;c.resumeSummary=summary;c.resumeTurnIds=c.messages.map(t=>t.id);c.historyExpanded=false;
      $('query').value=c.draft||'';renderChat(true);renderHistory();route('agent');say('已恢复对话。');
    });
  }
  function conversationMenu() {
    const c=active();if(!c)return;
    modal('对话操作',(box,actions)=>{
      const title=input(box,'对话名称',c.title);title.maxLength=80;
      const groups=[...new Set(conversations.map(x=>x.group).filter(Boolean))];
      const group=select(box,'情境分组',[['其他','其他'],...groups.filter(x=>x!=='其他').map(x=>[x,x])],c.group||'其他');
      P(box,'名称和分组仅在当前页面保留。','hint');
      button(actions,'保存',()=>run('history',async ctx=>{if(!title.value.trim()){$('modal-error').textContent='请输入对话名称。';return;}
        if(mock())await service.renameConversation(c.id,title.value.trim(),group.value);if(!current(ctx))return;
        c.title=title.value.trim();c.group=group.value;c.manualGroup=true;persist(c);renderHistory();renderChat();closeModal();say('对话信息已更新。');}), 'primary');
      button(actions,mock()?'删除对话':'从本页移除',()=>confirmDeleteConversation(c),'danger');
    });
  }
  function confirmDeleteConversation(c) {
    modal(mock()?'删除这段对话？':'从当前页面移除这段对话？',(box,actions)=>{
      P(box,c.title);P(box,'相关个人记忆仍会保留，可以在个人档案中单独删除。');
      if(!mock())P(box,'此操作只移除本页显示的对话。','hint');
      button(actions,'取消',closeModal,'',false);
      button(actions,'确认删除',()=>run('delete',async ctx=>{
        if(mock())await service.deleteConversation(c.id);if(!current(ctx))return;
        conversations=conversations.filter(x=>x.id!==c.id);if(activeId===c.id){activeId='';makeConversation();renderChat();}
        closeModal();renderHistory();say('对话已移除，相关个人记忆仍保留。');
      }),'primary');
    });
  }
  function renderChat(forceBottom=false) {
    const box=$('chat'),wasBottom=box.scrollHeight-box.clientHeight-box.scrollTop<75,oldTop=box.scrollTop;
    const focus=box.contains(document.activeElement)?document.activeElement?.dataset.focus:null;
    box.replaceChildren();const c=active();$('agent-title').textContent=c?.title||'新对话';
    $('chat-policy').textContent=mock()?'交互演示 · 固定场景模拟':'建议依据固定指南 · 对话仅在本页保留';
    if(c?.resumeNotice)P(box,c.resumeNotice,'notice');
    if(c?.resumeSummary){const summary=E('div',undefined,'resume-card');summary.append(E('h3','上次聊到'));P(summary,c.resumeSummary);
      button(summary,c.historyExpanded?'收起旧消息 ↑':'展开旧消息 ↓',()=>{c.historyExpanded=!c.historyExpanded;renderChat();},'text-button',false);box.append(summary);}
    if(!c?.messages.length){P(box,'想接着了解什么？说说你正在经历的事。','empty');return;}
    const turns=c.resumeSummary&&!c.historyExpanded?c.messages.filter(t=>!c.resumeTurnIds?.includes(t.id)&&t.createdAfterResume):c.messages;
    for(const turn of turns){const node=E('article',undefined,'turn');node.dataset.turn=turn.id;
      const q=E('div',undefined,'question');q.append(E('span','你','speaker'));P(q,turn.query);node.append(q);
      const answer=E('div',undefined,'answer');answer.id='answer-'+turn.id;node.append(answer);
      if(['waiting','responding'].includes(turn.status)){const pending=P(answer,turn.partial||'正在思考…','pending');pending.dataset.partial=turn.id;}
      else if(turn.status==='stopped'||turn.status==='failed'){
        P(answer,turn.partial||turn.error||'已停止等待。',turn.status==='failed'?'error':'');
        P(answer,turn.status==='stopped'?(mock()?'回复未完成，已保留显示的内容。':'浏览器已停止等待，服务器可能仍在处理。'):mock()?'原问题和输入草稿仍保留。':'网页未收到完整结果；重试可能产生新的摘要。','hint');
        button(answer,'重试回复',()=>send(turn.query,turn));button(answer,'编辑问题',()=>{$('query').value=turn.query;c.draft=turn.query;sync();$('query').focus();});
      }else {
        const response=turn.versions[turn.versionIndex||0];let result=response.result||{};
        if(typeof result==='string'){try{result=JSON.parse(result);}catch{result={};}}
        if(result.message||result.clarification)P(answer,result.message||result.clarification);
        else if(!(result.cards||[]).length)UI.markdown(answer,response.markdown||'本轮回复完成。');
        for(const guide of result.cards||[]){UI.card(answer,guide);button(answer,'查看指南详情 →',()=>showGuide(guide),'text-button');}
        if(result.status==='clarification')P(answer,'你可以在下方补充情况，再继续聊。','hint');
        if(response.summary){const failed=!response.summary.saved&&(turn.memoryEnabled??!!memories?.enabled);
          P(answer,response.summary.message||(response.summary.saved?'本轮摘要已保存。':'本轮未写入记忆。'),'summary-note'+(failed?' error':''));
          if(mock()&&response.summary.retryable&&service.retryAutomaticMemory)button(answer,'重试记忆保存',()=>retryMemory(turn),'text-button');}
        if(result.relatedGuide)button(answer,'相关建议：'+result.relatedGuide.title+' →',()=>showGuide(result.relatedGuide),'text-button');
        const actions=row(answer);
        button(actions,'复制',async()=>{try{await navigator.clipboard.writeText(result.markdown||response.markdown||result.message||'');say('回答已复制。');}catch{say('复制失败，请选择文字手动复制。','error');}},'text-button',false);
        if(service.capabilities.regenerate)button(actions,'重新生成',()=>send(turn.query,turn,true),'text-button');
        button(actions,'继续追问',()=>$('query').focus(),'text-button',false);
        if(turn.versions.length>1){const versions=select(actions,'回答版本',turn.versions.map((_,i)=>[String(i),'第'+(i+1)+'版']),String(turn.versionIndex));versions.dataset.focus=turn.id;
          versions.onchange=()=>{turn.versionIndex=Number(versions.value);persist();renderChat();};}
      }
      box.append(node);
    }
    box.scrollTop=forceBottom||wasBottom?box.scrollHeight:oldTop;
    if(focus)box.querySelector('[data-focus="'+focus+'"]')?.focus({preventScroll:true});sync();
  }
  function updateChunk(turn,text) {
    turn.partial=text;turn.status='responding';const box=$('chat'),n=box.querySelector('[data-partial="'+turn.id+'"]');
    const near=box.scrollHeight-box.clientHeight-box.scrollTop<75;if(n)n.textContent=text;if(near)box.scrollTop=box.scrollHeight;
  }
  async function send(override,retryTurn=null,regenerate=false,extra={}) {
    if(!user){pendingDraft={origin:'chat',text:String(override??$('query').value),conversation:active()?{title:active().title,group:active().group,guideId:active().guideId,draft:String(override??$('query').value)}:null};$('login').hidden=false;say('请先登录，输入已保留。');$('username').focus();return;}
    if(busy){say('上一轮仍在处理，请稍等或停止。');return;}
    const query=String(override??$('query').value).trim();if(!query||query.length>2000){say('请输入1–2000字的问题。','error');return;}
    if(!active())makeConversation();const c=active(),original=$('query').value;
    const turn=retryTurn||{id:uid('turn'),query,versions:[],versionIndex:0,status:'waiting',anchor:new Date().toISOString()};
    const previous=turn.versions[turn.versionIndex||0];turn.memoryEnabled=!!memories?.enabled;turn.status='waiting';turn.partial='';turn.error='';turn.createdAfterResume=true;
    if(!retryTurn)c.messages.push(turn);if(c.title==='新对话')c.title=query.slice(0,32);
    if(extra.skipClarification)c.context={...c.context,limited:query.startsWith('暂不补充')};
    route('agent');renderChat(true);renderHistory();
    await run('chat',async ctx=>{
      const slow=setTimeout(()=>{if(current(ctx))updateChunk(turn,'仍在处理，请勿重复提交；你可以继续编辑下一条草稿。');},15000);
      try {
        const response=await (mock()?service.submitMvpMessage:service.submitMessage)({query,conversationId:mock()?c.id:c.serverId,turnId:turn.id,followupId:c.followupId||'',guideId:c.guideId||'',context:c.context,memoryId:c.memoryId,group:c.group,recommendationId:c.recommendationId,anchor:turn.anchor,skipClarification:extra.skipClarification||c.context?.limited,scenario:extra.skipClarification?'normal':undefined,onChunk:mock()?text=>{if(current(ctx))updateChunk(turn,text);}:undefined});
        if(!current(ctx))return;c.serverId=response.conversation_id||c.serverId;c.group=c.manualGroup?c.group:response.group||c.group||'其他';c.context=response.context||c.context;
        if(regenerate||!turn.versions.length)turn.versions.push(response);else turn.versions[turn.versionIndex||0]=response;
        turn.versionIndex=turn.versions.length-1;turn.status='completed';
        if(response.summary?.saved&&response.summary.memory_id)c.followupId=response.summary.memory_id;
        if($('query').value===original&&(override===undefined||original.trim()===query)){$('query').value='';c.draft='';}
        persist(c);renderChat();renderHistory();say('本轮回复完成。');
        try{await readMemories(ctx);if(current(ctx))await readHome(ctx);}catch(e){if(!current(ctx))return;failure(e,ctx);if(e.status!==401)say('回答已完成，个人档案或回访暂时未能刷新。','error');}
      }catch(error){if(!current(ctx))return;
        if(regenerate&&previous){turn.status='completed';say('重新生成未完成，上一版回答仍保留。','error');}
        else {turn.status=error.name==='AbortError'?'stopped':'failed';turn.error=error.message;failure(error,ctx);}
        persist(c);renderChat();
      }finally{clearTimeout(slow);}
    });
  }
  function stop() {
    if(busy?.kind!=='chat')return;
    const c=active(),turn=c?.messages.find(t=>['waiting','responding'].includes(t.status));
    galleryMotion?.stop();
    service.abortAll();epoch++;busy=null;
    if(turn){turn.status=turn.versions.length?'completed':'stopped';persist(c);}renderChat();sync();
    say(mock()?'已停止模拟生成，已显示文字保留。':'已停止网页等待，服务器可能仍在处理。');
  }
  async function retryMemory(turn) {
    await run('memory',async ctx=>{
      const saved=await service.retryAutomaticMemory(turn.id);if(!current(ctx))return;
      for(const version of turn.versions)if(version.summary?.retryable)version.summary=saved;
      persist();renderChat();await readMemories(ctx);say('记忆已加入个人档案。');
    });
  }
  function invalidateMemoryContext(id='') {
    for(const c of conversations){
      c.serverId='';c.context=null;
      if(!id||c.memoryId===id||c.followupId===id){c.memoryId=null;c.followupId='';c.resumeNotice='个人记忆已更新；可以继续聊。';}
      persist(c);
    }
  }
  async function changeMemorySetting(enabled) {
    await run('memory',async ctx=>{
      const next=await service.mutate({action:'settings',enabled});if(!current(ctx))return;
      invalidateMemoryContext();memories=next;
      home={...(home||{}),followups:[]};renderHome();renderChat();
      await readMemories(ctx);if(!current(ctx))return;
      if($('modal').open)renderProfile($('modal-body'),$('modal-actions'));
      say(enabled?'已开启个人记忆，之后的对话会自动保存摘要。':'已关闭个人记忆，之后的对话不再读取或保存摘要。');
      try{await readHome(ctx);}catch(e){if(current(ctx))renderHomeError();}
    });
  }
  function renderProfile(box,actions) {
    box.replaceChildren();actions.replaceChildren();
    P(box,'开启后，自动保存对话摘要，用于之后的交流和问题回访。你可以随时关闭或删除。','hint');
    if(user&&memories){const setting=E('label',undefined,'memory-setting'),toggle=E('input');toggle.type='checkbox';toggle.id='memory-enabled';toggle.checked=!!memories.enabled;toggle.dataset.control='true';
      const text=E('span','个人记忆 '+(memories.enabled?'已开启':'已关闭'));setting.append(toggle,text);box.append(setting);
      toggle.onchange=async()=>{await changeMemorySetting(toggle.checked);if(toggle.isConnected)toggle.checked=!!memories?.enabled;};
      P(box,memories.enabled?'接下来的每轮回复会尝试保存摘要，保存结果会单独显示。':'现有摘要仍可查看和删除。关闭期间不读取或新增个人记忆。','hint');}
    const records=mock()?memories?.events||[]:(memories?.memories||memories?.effective||[]).filter(m=>m.state==='active');
    for(const m of records){const card=E('article',undefined,'memory'),head=E('div',undefined,'section-heading');head.append(E('h3',mock()?m.title:m.problem||'生活话题'));
      button(head,'删除',()=>confirmDeleteMemory(m),'text-button');card.append(head);
      if(m.text)P(card,m.text,'memory-summary');
      if(m.problem_status)P(card,'进展：'+(UI.labels[m.problem_status]||'未说明'),'hint');
      if(memories?.enabled)button(card,'继续聊 ↗',()=>continueMemory(m),'text-button');box.append(card);}
    if(!records.length)P(box,'暂时没有个人记忆。','empty');
    const info=E('div',undefined,'profile-info');P(info,user?user.name||user.id:'尚未登录');
    P(info,mock()?'演示数据仅保留在当前页面，刷新后重置。':'对话仅在本页保留；已保存的摘要会保留在个人档案中。','hint');box.append(info);
    if(user)button(actions,'退出登录',logout,'',false);else button(actions,'登录',()=>{closeModal();$('login').hidden=false;$('username').focus();},'',false);
    button(actions,'关闭',closeModal,'',false);sync();
  }
  async function openProfile() {
    modal('个人档案与设置',(box,actions)=>{if(memories)renderProfile(box,actions);else P(box,user?'正在读取个人档案…':'登录后查看个人档案。','empty');},true);
    if(!user){renderProfile($('modal-body'),$('modal-actions'));return;}
    if(busy)return;
    await run('profile',async ctx=>{try{await readMemories(ctx);if(current(ctx)&&$('modal').open&&$('modal').classList.contains('profile-dialog'))renderProfile($('modal-body'),$('modal-actions'));}
      catch(e){if(current(ctx)&&$('modal').open&&e.status!==401)button($('modal-actions'),'重试读取',openProfile);throw e;}});
  }
  function confirmDeleteMemory(m) {
    modal('删除这条个人记忆？',(box,actions)=>{
      P(box,m.title||m.problem||'生活话题');P(box,'后续交流不再使用这条摘要。本页已显示的对话仍会保留。');
      button(actions,'取消',()=>openProfile(),'',false);
      button(actions,'确认删除',()=>run('delete',async ctx=>{
        if(mock())await service.deleteEvent(m.id,m.version);else await service.mutate({action:'delete',id:m.id});
        if(!current(ctx))return;
        invalidateMemoryContext(m.id);
        home={...(home||{}),followups:(home?.followups||[]).filter(f=>f.memory_id!==m.id)};
        if(memories){if(mock())memories.events=(memories.events||[]).filter(record=>record.id!==m.id);else {memories.memories=(memories.memories||[]).filter(record=>record.id!==m.id);memories.effective=(memories.effective||[]).filter(record=>record.id!==m.id);}}
        renderHome();renderChat();await readMemories(ctx);if(!current(ctx))return;
        renderProfile($('modal-body'),$('modal-actions'));$('modal-title').textContent='个人档案与设置';$('modal').classList.add('profile-dialog');say('记忆已删除。');
        try{await readHome(ctx);}catch(e){if(current(ctx))renderHomeError();}
      }),'primary');
    });
  }
  async function continueMemory(m) {
    if(busy)return;if(!memories?.enabled){say('个人记忆已关闭，请先开启后继续。');return;}closeModal();
    if(!mock()){
      const c=newChat({title:m.problem||'接着聊',followupId:m.id,resumeNotice:'接着已保存的摘要聊。'});
      if(c){$('query').value='关于“'+(m.problem||'上次的话题')+'”，我想继续咨询。';c.draft=$('query').value;sync();}return;
    }
    preserveDraft();
    await run('history',async ctx=>{
      const fresh=await service.getMemories();if(!current(ctx))return;memories=fresh;
      const memory=fresh.events.find(e=>e.id===m.id);if(!memory){say('这条记忆已删除，请刷新个人档案。','error');return;}
      const result=await service.getConversationSummary(memory.source?.conversationId);if(!current(ctx))return;
      let c;
      if(result.exists){c=result.conversation;const i=conversations.findIndex(x=>x.id===c.id);if(i<0)conversations.unshift(c);else conversations[i]=c;
        c.resumeSummary=result.summary;c.resumeTurnIds=c.messages.map(t=>t.id);c.historyExpanded=false;c.memoryId=memory.id;c.resumeNotice='已带入当前有效的“'+memory.title+'”记忆';activeId=c.id;$('query').value=c.draft||'';
      }else {c=makeConversation({title:'接着聊'+memory.title,group:memory.title,memoryId:memory.id,resumeNotice:'原对话已删除或不存在，已带入相关记忆开启新对话。'});}
      renderChat(true);renderHistory();route('agent');say('可以继续提问。');
    });
  }
  function resetPrivate() {
    galleryMotion?.dispose();galleryMotion=null;
    service.abortAll();epoch++;busy=null;loading=false;user=null;memories=null;home=null;conversations=[];activeId='';historyLoaded=false;focusedRecommendationId='';pendingFeedback.clear();pendingDraft=null;
    toggleHistory(false);closeModal();$('query').value='';$('today-query').value='';$('password').value='';$('history-search').value='';$('topics').replaceChildren();$('home').replaceChildren();$('chat').replaceChildren();renderPending();$('login').hidden=false;renderHome();sync();
  }
  async function logout() {const outgoing=service;resetPrivate();route('today');try{await outgoing.logout();say('已退出，个人内容已清除。');}catch{say('本页已清除，服务端退出未确认，可重试退出。','error');modal('退出结果待确认',(box,actions)=>{P(box,'可再次发送退出请求。');button(actions,'重试退出',async()=>{try{await outgoing.logout();closeModal();say('已退出。');}catch(e){$('modal-error').textContent=e.message;}},'',false);});}}
  async function enter(nextUser) {
    const draft=pendingDraft||(!user&&active()?.draft?{origin:'chat',text:active().draft,conversation:{title:active().title,group:active().group,guideId:active().guideId,draft:active().draft}}:null);
    loading=true;user=nextUser;$('login').hidden=true;const ctx=stamp();sync();
    if(mock()){try{conversations=await service.listMvpConversations();historyLoaded=true;}catch(e){failure(e,ctx);}}
    if(!current(ctx))return;
    activeId='';makeConversation(draft?.origin==='chat'?(draft.conversation||{draft:draft.text}):{});
    if(draft?.origin==='today')$('today-query').value=draft.text;
    if(draft?.origin==='chat'){$('query').value=draft.text;route('agent');}
    pendingDraft=null;renderChat();renderHistory();renderHome();
    try{await readMemories(ctx);}catch(e){failure(e,ctx);}
    if(!current(ctx))return;
    try{await readHome(ctx);}catch(e){if(current(ctx)){renderHomeError();failure(e,ctx);}}
    if(current(ctx)){loading=false;renderFollowups();if(draft)say('登录成功，你的问题已保留，可以修改后发送。');}sync();
  }
  function renderTools() {
    const box=$('preview-controls');box.replaceChildren();$('environment').textContent=mock()?'交互演示 · 模拟数据':'生活指南';

    if(!window.PreviewProduct)return;
    const details=E('details');details.append(E('summary','开发验收工具'));const controls=row(details);
    const account=select(controls,'演示账号',[['alice','有记录 · Alice'],['bob','空档案 · Bob']],user?.id||'alice');
    const scene=select(controls,'故障场景',[['normal','正常'],['clarification','必要追问'],['web','联网等待模拟'],['network','发送失败'],['error','回复失败'],['summaryfail','记忆整理失败'],['savefail','记忆保存失败'],['deletefail','删除失败'],['homefail','推荐加载失败'],['listfail','档案读取失败'],['historyfail','历史读取失败'],['unknown','反馈结果未知'],['unknownfail','反馈未知后失败'],['feedbackfail','反馈失败'],['expired','登录失效']], 'normal');scene.id='preview-scenario';
    const delay=select(controls,'回复等待',[['450','短等待'],['3000','3秒'],['16000','16秒']], '450');delay.id='preview-delay';
    account.dataset.control='true';
    account.onchange=()=>run('account',async()=>{const next=account.value;resetPrivate();service=window.PreviewProduct;await service.login(next,'preview');await enter(await service.me());renderTools();route('today');});
    button(controls,'重置虚构数据',()=>run('reset',async()=>{const name=account.value;resetPrivate();service=window.PreviewProduct;await service.login(name,'preview');service.reset(name==='alice'?'full':'empty');await enter(await service.me());renderTools();route('today');}), '',false);
    box.append(details);
  }
  document.body.append($('profile-entry'));
  $('history-toggle').onclick=()=>toggleHistory();$('history-close').onclick=()=>toggleHistory(false);
  for(const id of ['history-hover-zone','history-toggle']){
    $(id).addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')previewHistory();});
    $(id).addEventListener('pointerleave',scheduleHistoryClose);
  }
  $('history-panel').addEventListener('pointerenter',()=>clearTimeout(historyHideTimer));
  $('history-panel').addEventListener('pointerleave',scheduleHistoryClose);
  $('history-panel').addEventListener('focusout',scheduleHistoryClose);
  document.addEventListener('pointerdown',event=>{if(!historyPinned&&!$('history-panel').hidden&&!$('history-panel').contains(event.target)&&!$('history-toggle').contains(event.target))toggleHistory(false);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('modal').open&&!$('history-panel').hidden)toggleHistory(false);});
  $('header-newchat').onclick=()=>newChat();
  $('history-search').oninput=renderHistory;$('newchat').onclick=()=>newChat();
  $('continue-latest').onclick=()=>{if(loading||busy)return;preserveDraft();if(!active()){makeConversation();renderChat();}route('agent');toggleHistory(true,{pin:false,focus:true});requestAnimationFrame(()=>{if(!$('view-agent').hidden&&!$('history-panel').hidden)$('history-search').focus();});};
  $('conversation-menu').onclick=conversationMenu;$('profile-entry').onclick=openProfile;
  $('query').oninput=()=>{if(active())active().draft=$('query').value;if(pendingDraft?.origin==='chat'){pendingDraft.text=$('query').value;if(pendingDraft.conversation)pendingDraft.conversation.draft=$('query').value;}sync();};$('today-query').oninput=()=>{if(pendingDraft?.origin==='today')pendingDraft.text=$('today-query').value;sync();};
  function keyboard(e){if(e.key==='Enter'&&!e.isComposing&&e.keyCode!==229&&!e.shiftKey){e.preventDefault();e.target.form.requestSubmit();}}
  $('query').onkeydown=keyboard;$('today-query').onkeydown=keyboard;
  $('askform').onsubmit=e=>{e.preventDefault();send();};
  $('todayform').onsubmit=e=>{e.preventDefault();const text=$('today-query').value.trim();if(!text||busy)return;
    if(!user){pendingDraft={origin:'today',text};$('login').hidden=false;say('请先登录，输入已保留。');$('username').focus();return;}
    const c=newChat();if(c){$('query').value=text;c.draft=text;$('today-query').value='';send();}};
  $('stop').onclick=stop;$('refresh-home').onclick=refreshHome;
  function scrollCards(direction){if(galleryMotion){galleryMotion.step(direction);return;}const cards=[...$('home').querySelectorAll('.radar-card[data-recommendation]')];if(cards.length<2)return;const index=Math.max(0,cards.findIndex(c=>c.dataset.recommendation===focusedRecommendationId));focusRecommendation(cards[(index+direction+cards.length)%cards.length].dataset.recommendation);}
  for(const [id,direction] of [['cards-prev',-1],['cards-next',1]])$(id).onclick=()=>scrollCards(direction);
  $('login-close').onclick=()=>{$('login').hidden=true;};
  $('loginform').onsubmit=e=>{e.preventDefault();run('login',async ctx=>{const next=await service.login($('username').value.trim(),$('password').value);if(!current(ctx))return;$('password').value='';await enter(next);});};
  $('modal-close').onclick=()=>{if(!busy)closeModal();};
  $('modal').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  $('modal').addEventListener('close',()=>{if(modalRestore?.isConnected)modalRestore.focus({preventScroll:true});modalRestore=null;});
  $('modal').addEventListener('keydown',e=>{if(e.key!=='Tab')return;const controls=[...$('modal').querySelectorAll('button,input,textarea,select,a[href],summary')].filter(n=>!n.disabled&&n.getClientRects().length);const first=controls[0],last=controls.at(-1);if(!first)return;if(e.shiftKey&&document.activeElement===first||!e.shiftKey&&document.activeElement===last){e.preventDefault();(e.shiftKey?last:first).focus();}});
  window.addEventListener('hashchange',renderRoute);window.addEventListener('resize',updateCardControls);
  const today=new Date();$('local-date').dateTime=today.toISOString();$('local-date').textContent=new Intl.DateTimeFormat('zh-CN',{weekday:'short',month:'long',day:'numeric',timeZone:'Asia/Shanghai'}).format(today);
  (async()=>{renderRoute();renderTools();renderHome();try{await enter(await service.me());}catch(e){if(e.status!==401)say(e.message,'error');$('login').hidden=true;}renderTools();sync();})();
})();
