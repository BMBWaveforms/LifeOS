/** FLIP keeps the reading column moving with the panel without animating width. */
export function initWorkspaceShell({onCollapse=()=>{}}={}) {
  const workspace=document.getElementById('workspace');
  const sidebar=document.getElementById('conversation-sidebar');
  const main=document.getElementById('conversation-main');
  const toggle=document.getElementById('sidebar-toggle');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let visible=false,open=true,animations=[],sequence=0;
  const easing='cubic-bezier(.22, 1, .36, 1)';
  // Measure the title itself: its flex wrapper changes width immediately, so
  // measuring that wrapper's left edge misses the centered text's displacement.
  const regions=()=>[...main.querySelectorAll('#conversation-title,.understanding-toggle,.empty-state,.recovered-memory-context,.project-example-note,.messages,.thinking,.composer-wrap')].filter(e=>!e.hidden);
  const cancel=()=>{sequence++;animations.forEach(a=>a.cancel());animations=[];delete workspace.dataset.shellMoving;};
  function animate(node,keyframes,options={},startTime=null) {
    const animation=node.animate(keyframes,{duration:660,easing,fill:'both',...options});
    if(startTime!==null)animation.startTime=startTime;
    animations.push(animation);return animation;
  }
  function finish() {
    const current=++sequence;
    Promise.all(animations.map(a=>a.finished.catch(()=>{}))).then(()=>{
      if(current!==sequence)return;
      animations.forEach(a=>a.cancel());animations=[];delete workspace.dataset.shellMoving;
    });
  }
  function setOpen(next) {
    if(next===open)return;
    // Capture live positions before cancellation so rapid reversals stay continuous.
    const nodes=regions(),before=new Map(nodes.map(e=>[e,e.getBoundingClientRect().left]));
    const beforeMain=main.getBoundingClientRect().left;
    const wasHidden=!open&&!workspace.dataset.shellMoving;
    const beforeSide=wasHidden?'translateX(-60px)':getComputedStyle(sidebar).transform;
    const beforeOpacity=wasHidden?0:getComputedStyle(sidebar).opacity;
    cancel();open=next;
    workspace.dataset.sidebarOpen=String(open);
    toggle.setAttribute('aria-expanded',String(open));
    toggle.setAttribute('aria-label',open?'收起对话侧栏':'展开对话侧栏');
    toggle.querySelector('span').textContent=open?'收起侧栏':'展开侧栏';
    sidebar.inert=!open;sidebar.setAttribute('aria-hidden',String(!open));
    if(!open){onCollapse();if(sidebar.contains(document.activeElement))toggle.focus({preventScroll:true});}
    if(!visible||reduced.matches)return;
    workspace.dataset.shellMoving='true';
    const startTime=document.timeline.currentTime;
    const targetTransform=getComputedStyle(main).transform;
    animate(main,[{transform:`translateX(${beforeMain-workspace.getBoundingClientRect().left}px)`},{transform:targetTransform}],{},startTime);
    // Only one geometry read per region, followed by composited transforms.
    const positions=nodes.map(e=>[e,e.getBoundingClientRect().left]);
    for(const [node,left] of positions){
      const x=before.get(node)-left;
      if(Math.abs(x)>.5)animate(node,[{transform:`translateX(${x}px)`},{transform:'translateX(0)'}],{},startTime);
    }
    animate(sidebar,[{transform:beforeSide==='none'?'translateX(0)':beforeSide,opacity:beforeOpacity},{transform:open?'translateX(0)':'translateX(-60px)',opacity:open?1:0}],{},startTime);
    finish();
  }
  function setVisible(next) {
    if(next===visible)return;
    cancel();visible=next;
    if(!visible||reduced.matches)return;
    workspace.dataset.shellMoving='true';
    const startTime=document.timeline.currentTime;
    const offset=main.getBoundingClientRect().left-workspace.getBoundingClientRect().left;
    const entrance={duration:1120,easing:'cubic-bezier(.25,.8,.25,1)'};
    animate(main,[{transform:'translateX(0)',opacity:1},{transform:`translateX(${offset}px)`,opacity:1}],entrance,startTime);
    for(const node of regions())animate(node,[{transform:`translateX(${offset/2}px)`,opacity:0},{transform:'translateX(0)',opacity:1}],{...entrance,duration:1000,delay:140},startTime);
    if(open){
      animate(sidebar,[{transform:'translateX(-60px)'},{transform:'translateX(0)'}],entrance,startTime);
      for(const [i,node]of [...sidebar.children].entries())animate(node,[{transform:'translateX(-16px)',opacity:0},{transform:'translateX(0)',opacity:1}],{...entrance,duration:760,delay:180+i*45},startTime);
    }
    finish();
  }
  toggle.addEventListener('click',()=>setOpen(!open));
  reduced.addEventListener('change',()=>{if(reduced.matches)cancel();});
  window.addEventListener('resize',cancel);
  return {setVisible,setOpen};
}
