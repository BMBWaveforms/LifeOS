// A reply's evidence arrives when it enters the reading viewport. Remembered
// keys keep unrelated chat renders from replaying a card the user has seen.
export function initAnswerReveals(root,scroller){
 const motion=matchMedia('(prefers-reduced-motion: reduce)'),seen=new Set();let observer=null,animations=[];
 function clear(){observer?.disconnect();observer=null;for(const animation of animations)animation.cancel();animations=[];}
 function reveal(node,delay=0,animate=true){
  seen.add(node.dataset.answerRevealKey);delete node.dataset.answerReveal;
  if(animate&&!motion.matches){const animation=node.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:620,delay,easing:'cubic-bezier(.16,1,.3,1)',fill:'backwards'});animations.push(animation);animation.finished.then(()=>{animations=animations.filter(a=>a!==animation);}).catch(()=>{});}
  observer?.unobserve(node);if(seen.size>600)seen.delete(seen.values().next().value);
 }
 function refresh(){
  clear();const nodes=[...root.querySelectorAll('.guide-card,.ledger-entry')];
  if(motion.matches||!globalThis.IntersectionObserver){for(const node of nodes){delete node.dataset.answerReveal;seen.add(keyFor(node));}return;}
  observer=new IntersectionObserver(entries=>{let delay=0;for(const entry of entries)if(entry.isIntersecting){reveal(entry.target,delay);delay=Math.min(180,delay+90);}},{root:scroller,rootMargin:'0px 0px -16px 0px',threshold:0});
  for(const node of nodes){const key=keyFor(node);node.dataset.answerRevealKey=key;if(seen.has(key))continue;node.dataset.answerReveal='pending';observer.observe(node);}
 }
 function keyFor(node){return (node.closest('.turn')?.dataset.turnId||'answer')+':'+(node.dataset.guideId||'ledger');}
 root.addEventListener('focusin',event=>{const node=event.target.closest('[data-answer-reveal="pending"]');if(node)reveal(node,0,false);});
 motion.addEventListener('change',()=>{if(motion.matches){clear();for(const node of root.querySelectorAll('[data-answer-reveal="pending"]'))reveal(node,0,false);}});
 return {refresh,clear};
}
