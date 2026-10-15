/* Real provider: only public, supported APIs. No fixtures or keys. */
window.RealProduct = function (api) {
  const capabilities = Object.freeze({events:false, independentSettings:false, history:false, stream:false, regenerate:false, radar:false, context:false, operationQuery:false});
  return {
    mode:'real', capabilities, getCapabilities: () => capabilities,
    health: () => api.request('/health'),
    me: async () => (await api.request('/api/me')).user,
    login: async (username,password) => (await api.request('/api/login',{username,password})).user,
    logout: () => api.request('/api/logout',{}), abortAll: () => api.abortAll(),
    getMemories: () => api.request('/api/memories'),
    getHome: async () => {
      const data = await api.request('/api/run',{mode:'home',query:'',conversation_id:'',followup_memory_id:''});
      let result=data.result;
      if(typeof result==='string') { try {result=JSON.parse(result);} catch {result={};} }
      return {followups:result?.followups||[],recommendations:[]};
    },
    submitMessage: input => api.request('/api/run',{mode:'chat',query:input.query,conversation_id:input.conversationId||'',followup_memory_id:input.followupId||'',guide_id:input.guideId||''}),
    mutate: input => api.request('/api/memory-action',input),
    guide: id => api.request('/api/guide-entry?guide_id='+encodeURIComponent(id)),
    unsupported() { const error=new Error('此功能待接口接入。'); error.code='unsupported_capability'; throw error; }
  };
};
