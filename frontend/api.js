/* Same-origin API boundary. No model credentials or chat storage in the browser. */
window.LifeAPI = (() => {
  const pending = new Set();
  class RequestError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
  }
  async function request(path, data) {
    const controller = new AbortController();
    pending.add(controller);
    try {
      const response = await fetch(path, {
        method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal
      });
      let payload;
      try { payload = await response.json(); }
      catch { throw new RequestError('服务返回了无法读取的响应，请稍后重试。', response.status); }
      if (!response.ok) throw new RequestError(payload.message || '服务暂时无法完成操作，请稍后重试。', response.status);
      return payload;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof RequestError) throw error;
      throw new RequestError('连接失败，请检查网络或服务是否可用。你的输入仍保留在页面中。');
    } finally { pending.delete(controller); }
  }
  return { request, abortAll() { for (const controller of pending) controller.abort(); } };
})();
