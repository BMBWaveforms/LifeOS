import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionGuard} from '../../frontend/session-guard.mjs';

test('a pending real login cannot overwrite the demo identity or its cache after returning to demo',async()=>{
 const real={},demo={},state={provider:real,owner:undefined,cache:'real-pending'},guard=createSessionGuard(()=>state);
 let finish;const pending=new Promise(resolve=>{finish=resolve;}),token=guard.capture();
 const login=guard.accept(token,pending).then(result=>{if(result.current){state.owner=result.value.id;state.cache='real-account-data';}});
 state.provider=demo;state.owner='local-demo';state.cache='demo-data';guard.invalidate();finish({id:'private-real-owner'});await login;
 assert.equal(state.provider,demo);assert.equal(state.owner,'local-demo');assert.equal(state.cache,'demo-data');
});
test('a memory read for an earlier account cannot enter the next account cache on the same provider',async()=>{
 const provider={},state={provider,owner:'alice'},guard=createSessionGuard(()=>state);let finish;
 const pending=guard.accept(guard.capture(),new Promise(resolve=>{finish=resolve;}));
 state.owner='bob';finish({topics:[{text:'ALICE_PRIVATE'}]});assert.deepEqual(await pending,{current:false});
});
test('logging into the same account again invalidates earlier in-flight reads',async()=>{
 const state={provider:{},owner:'alice'},guard=createSessionGuard(()=>state),token=guard.capture();
 guard.invalidate();assert.equal(guard.current(token),false);assert.deepEqual(await guard.accept(token,Promise.resolve('old-data')),{current:false});
 const fresh=guard.capture();assert.deepEqual(await guard.accept(fresh,Promise.resolve('latest-data')),{current:true,value:'latest-data'});
});
