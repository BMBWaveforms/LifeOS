// Static previews fail closed; only the same-origin server may expose real APIs.
export async function loadRuntimeConfig(request=fetch){
  let real_api_enabled=false;
  try {
    const response=await request(new URL('./runtime.json',import.meta.url));
    if(response.ok)real_api_enabled=(await response.json()).real_api_enabled===true;
  } catch { /* The local demo remains available when config cannot load. */ }
  if(!real_api_enabled)return {real_api_enabled:false,real_model_configured:false};
  try {
    const response=await request('/health',{credentials:'same-origin'});
    const health=response.ok?await response.json():{};
    return {real_api_enabled:true,real_model_configured:health.model?.configured===true};
  } catch { return {real_api_enabled:true,real_model_configured:false}; }
}
