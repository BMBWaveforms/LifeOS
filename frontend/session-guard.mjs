// Async account data may update the UI only while its provider, owner and epoch still match.
export function createSessionGuard(getSession){
 let epoch=0;
 const capture=()=>({...getSession(),epoch});
 const current=token=>{const session=getSession();return token.epoch===epoch&&token.provider===session.provider&&token.owner===session.owner;};
 return {capture,current,invalidate(){epoch++;},async accept(token,pending){const value=await pending;return current(token)?{current:true,value}:{current:false};}};
}
