import test from 'node:test';
import assert from 'node:assert/strict';
import {initHistoryReordering} from '../../frontend/conversation-ordering.mjs';

// A small event-propagating DOM: run the production gesture handlers, including
// window capture, root click suppression, pointer capture and button activation.
class Target{
 constructor(){this.listeners={};}
 addEventListener(type,handler,options=false){(this.listeners[type]??=[]).push({handler,capture:options===true||options?.capture===true});}
}
class Element extends Target{
 constructor(tag,document){super();this.tagName=tag;this.document=document;this.children=[];this.parentNode=null;this.dataset={};this.className='';this.attributes={};this.scrollTop=0;this.style={removeProperty(name){delete this[name];}};this.bounds={left:20,top:100,width:220,height:400};}
 get classList(){const node=this;return {contains:name=>node.className.split(' ').includes(name),add(...names){node.className=[...new Set([...node.className.split(' ').filter(Boolean),...names])].join(' ');},remove(...names){node.className=node.className.split(' ').filter(name=>!names.includes(name)).join(' ');}};}
 append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}
 matches(selector){return selector.startsWith('.')?this.classList.contains(selector.slice(1)):false;}
 closest(selector){return this.matches(selector)?this:this.parentNode?.closest?.(selector)||null;}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 get isConnected(){return this===this.document.body||Boolean(this.parentNode?.isConnected);}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getBoundingClientRect(){const base={...this.bounds};for(const key of ['left','top','width','height'])if(this.style[key]!==undefined)base[key]=parseFloat(this.style[key]);const dy=this.style.transform?.match(/^translateY\(([-\d.]+)px\)/)?.[1];if(dy)base.top+=Number(dy);return {...base,bottom:base.top+base.height,right:base.left+base.width};}
 cloneNode(deep){const node=new Element(this.tagName,this.document);node.className=this.className;node.dataset={...this.dataset};node.bounds={...this.bounds};if(deep)node.append(...this.children.map(child=>child.cloneNode(true)));return node;}
 focus(){this.document.activeElement=this;}
 getAnimations(){return [];}
 animate(){return {cancel(){}};}
 setPointerCapture(pointerId){this.document.captures.set(pointerId,this);}
 hasPointerCapture(pointerId){return this.document.captures.get(pointerId)===this;}
 releasePointerCapture(pointerId){if(this.hasPointerCapture(pointerId)){this.document.captures.delete(pointerId);this.document.dispatch('lostpointercapture',this,{pointerId});}}
}
function fixture(t,{enabled=true}={}){
 const originals=new Map(['window','document','matchMedia','requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const window=new Target(),document=new Target(),frames=new Map(),moves=[],opened=[];let nextFrame=0,canMove=enabled;
 document.captures=new Map();document.body=new Element('body',document);document.body.parentNode=document;
 document.createElement=tag=>new Element(tag,document);document.hidden=false;
 const workspace=new Element('div',document),root=new Element('div',document),chat=new Element('div',document);document.body.append(workspace);workspace.append(root,chat);document.getElementById=id=>id==='workspace'?workspace:null;
 document.dispatch=(type,target,properties={})=>{
  const event={type,target,detail:1,button:0,isPrimary:true,pointerId:1,clientX:100,clientY:145,defaultPrevented:false,stopped:false,immediate:false,...properties,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},stopImmediatePropagation(){this.immediate=true;this.stopped=true;}};
  const path=[];for(let node=target;node;node=node.parentNode)path.push(node);if(!path.includes(document))path.push(document);path.push(window);
  const fire=(node,capture)=>{event.currentTarget=node;for(const listener of node.listeners[type]||[]){if(listener.capture===capture){listener.handler(event);if(event.immediate)break;}}};
  for(const node of path.slice().reverse()){fire(node,true);if(event.stopped)return event;}
  for(const node of path){fire(node,false);if(event.stopped)break;}
  return event;
 };
 const rows=[];
 for(const [id,group,top]of [['a','recent',120],['b','recent',180],['c','recent',240],['project-a','project:move',340],['project-b','project:move',400]]){
  const row=new Element('article',document),button=new Element('button',document),title=new Element('strong',document),deleteButton=new Element('button',document);row.className='history-row';row.dataset={conversationId:id,orderGroup:group};row.bounds={left:20,top,width:220,height:50};button.className='history-select';button.addEventListener('click',()=>opened.push(id));button.append(title);deleteButton.className='delete-history';row.append(button,deleteButton);root.append(row);rows.push({id,row,button,title,deleteButton});
 }
 for(const [key,value]of Object.entries({window,document,matchMedia:()=>({matches:false}),requestAnimationFrame:callback=>{const id=++nextFrame;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id)}))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 t.after(()=>{for(const [key,descriptor]of originals)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});
 const controller=initHistoryReordering(root,{onMove:value=>moves.push(value),enabled:()=>canMove});
 const pointer=(type,target,properties={})=>{const captured=document.captures.get(properties.pointerId??1);return document.dispatch(type,type==='pointerdown'?target:captured||target,properties);};
 const click=(target,properties={})=>document.dispatch('click',target,properties);
 const frame=()=>{const pending=[...frames];frames.clear();for(const [,callback]of pending)callback();};
 const clean=()=>{assert.equal(root.classList.contains('is-dragging'),false);assert.equal(document.body.classList.contains('is-history-reordering'),false);assert.equal(workspace.querySelectorAll('.conversation-drag-preview').length,0);assert.equal(document.captures.size,0);assert.equal(frames.size,0);for(const {row}of rows){assert.equal(row.style.transform,undefined);assert.equal(row.classList.contains('is-ordering-origin'),false);assert.equal(row.classList.contains('is-ordering-neighbor'),false);}};
 const begin=()=>{pointer('pointerdown',rows[0].title);pointer('pointermove',rows[0].title,{clientX:108});assert.equal(root.classList.contains('is-dragging'),true);};
 return {window,document,workspace,root,chat,rows,moves,opened,pointer,click,frame,clean,begin,controller,setEnabled:value=>{canMove=value;}};
}

test('movement below 8 pixels keeps an ordinary nested-title click and never starts sorting',t=>{
 const f=fixture(t);f.pointer('pointerdown',f.rows[0].title);f.pointer('pointermove',f.rows[0].title,{clientX:107.9});assert.equal(f.root.classList.contains('is-dragging'),false);
 f.pointer('pointerup',f.rows[0].title,{clientX:107.9});f.click(f.rows[0].title);assert.deepEqual(f.opened,['a']);assert.deepEqual(f.moves,[]);f.clean();
});
test('exactly 8 pixels starts a drag, release commits its target without opening either conversation',t=>{
 const f=fixture(t);f.begin();assert.equal(f.workspace.querySelectorAll('.conversation-drag-preview').length,1);assert.equal(f.root.hasPointerCapture(1),true);
 f.pointer('pointermove',f.rows[0].button,{clientY:265});f.frame();f.pointer('pointerup',f.rows[0].button,{clientY:265});f.click(f.rows[0].button);f.click(f.rows[2].button);
 assert.deepEqual(f.moves,[{group:'recent',sourceId:'a',targetId:'c'}]);assert.deepEqual(f.opened,[]);assert.equal(f.document.activeElement,f.rows[0].button);f.clean();
 // A new physical click must work even before the previous zero-delay timer runs.
 f.pointer('pointerdown',f.rows[1].button,{clientY:205});f.pointer('pointerup',f.rows[1].button,{clientY:205});f.click(f.rows[1].button);assert.deepEqual(f.opened,['b']);
});
test('dropping outside the source group cancels rather than reordering into a project',t=>{
 const f=fixture(t);f.begin();f.pointer('pointermove',f.chat,{clientY:365});f.frame();f.pointer('pointerup',f.chat,{clientY:365});f.click(f.rows[3].button);
 assert.deepEqual(f.moves,[]);assert.deepEqual(f.opened,[]);f.clean();
});
test('Escape cancels an active drag and its later release cannot reopen the source',t=>{
 const f=fixture(t);f.begin();f.pointer('pointermove',f.rows[0].button,{clientY:205});f.frame();const event=f.document.dispatch('keydown',f.rows[0].button,{key:'Escape'});assert.equal(event.defaultPrevented,true);
 f.pointer('pointerup',f.rows[0].button,{clientY:205});f.click(f.rows[0].button);assert.deepEqual(f.moves,[]);assert.deepEqual(f.opened,[]);f.clean();
});
test('losing pointer capture cancels the drag, clears every visual state and permits the next click',t=>{
 const f=fixture(t);f.begin();f.pointer('pointermove',f.rows[0].button,{clientY:205});f.frame();f.root.releasePointerCapture(1);
 f.pointer('pointerup',f.rows[0].button,{clientY:205});f.click(f.rows[0].button);assert.deepEqual(f.moves,[]);assert.deepEqual(f.opened,[]);f.clean();
 f.pointer('pointerdown',f.rows[2].button,{clientY:265});f.pointer('pointerup',f.rows[2].button,{clientY:265});f.click(f.rows[2].button);assert.deepEqual(f.opened,['c']);
});
test('Alt plus an arrow moves within its group and ordinary arrows or boundaries do nothing',t=>{
 const f=fixture(t),key=(target,key,extra={})=>f.document.dispatch('keydown',target,{key,...extra});
 assert.equal(key(f.rows[1].title,'ArrowUp').defaultPrevented,false);assert.deepEqual(f.moves,[]);
 assert.equal(key(f.rows[1].title,'ArrowUp',{altKey:true}).defaultPrevented,true);assert.deepEqual(f.moves,[{group:'recent',sourceId:'b',targetId:'a'}]);assert.equal(f.document.activeElement,f.rows[1].button);
 key(f.rows[0].button,'ArrowUp',{altKey:true});key(f.rows[2].button,'ArrowDown',{altKey:true});assert.equal(f.moves.length,1);
 key(f.rows[3].title,'ArrowDown',{altKey:true});assert.deepEqual(f.moves.at(-1),{group:'project:move',sourceId:'project-a',targetId:'project-b'});
 key(f.rows[1].button,'ArrowDown',{altKey:true,ctrlKey:true});assert.equal(f.moves.length,2);assert.deepEqual(f.opened,[]);f.clean();
});
test('busy state, secondary pointers and delete controls cannot start a conversation drag',t=>{
 const f=fixture(t,{enabled:false});f.pointer('pointerdown',f.rows[0].button);f.pointer('pointermove',f.rows[0].button,{clientX:120});f.pointer('pointerup',f.rows[0].button,{clientX:120});f.clean();
 f.setEnabled(true);f.pointer('pointerdown',f.rows[0].button,{isPrimary:false});f.pointer('pointermove',f.rows[0].button,{clientX:120});f.pointer('pointerup',f.rows[0].button,{clientX:120});f.clean();
 f.pointer('pointerdown',f.rows[0].deleteButton);f.pointer('pointermove',f.rows[0].deleteButton,{clientX:120});f.pointer('pointerup',f.rows[0].deleteButton,{clientX:120});assert.deepEqual(f.moves,[]);f.clean();
});
