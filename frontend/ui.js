/* DOM rendering only. API and model text is always inserted as text, never HTML. */
window.LifeUI = (() => {
  const $ = id => document.getElementById(id);
  const labels = { resolved: '已解决', unresolved: '尚未解决', unknown: '未说明' };
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function paragraph(box, text, className) { const node = element('p', text, className); box.append(node); return node; }
  function button(box, label, action, className) {
    const node = element('button', label, className); node.type = 'button'; node.onclick = action; box.append(node); return node;
  }
  function source(box, entry) {
    try {
      const url = new URL(entry.source_url);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/eternity4719/HowToLiveBetter/')) return;
      const link = element('a', entry.source_locator || '查看指南原文');
      link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link);
    } catch { /* Missing or untrusted source is not turned into a link. */ }
  }
  function markdown(box, text = '') {
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      const match = line.match(/^\[([^\]]+)\]\((https:\/\/github\.com\/eternity4719\/HowToLiveBetter\/[^)]+)\)(.*)$/);
      if (match) { const row = paragraph(box, ''); source(row, {source_locator: match[1], source_url: match[2]}); row.append(document.createTextNode(match[3])); }
      else box.append(element(line.startsWith('### ') ? 'h3' : 'p', line.replace(/^### /, '').replace(/\*\*/g, '')));
    }
  }
  function card(box, entry) {
    const node = element('article', undefined, 'guide-card'), fields = entry.fields || {};
    node.append(element('h3', entry.title || '指南条目'));
    const badges = element('div', undefined, 'row');
    badges.append(element('span', '证据等级：' + (fields['证据等级'] || '原文未提供'), 'pill'));
    node.append(badges);
    if (entry.match_reason) paragraph(node, entry.match_reason, 'hint');
    paragraph(node, fields['说人话'] || '请查看完整指南条目。');
    paragraph(node, '成本：' + (fields['成本'] || '原文未提供'), 'hint');
    paragraph(node, '限制与备注：' + (fields['备注'] || '原文未提供'), 'restriction');
    source(node, entry);
    const details = element('details'); details.append(element('summary', '展开完整条目'));
    const list = element('dl');
    for (const [name, value] of Object.entries(fields)) { list.append(element('dt', name), element('dd', String(value ?? '原文未提供'))); }
    details.append(list); paragraph(details, '指南编号：' + (entry.guide_id || '未提供'), 'hint'); node.append(details); box.append(node);
  }
  function result(box, data, memoryEnabled = true) {
    let value = data.result;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
    if (value && (value.message || value.clarification || value.cards?.length)) {
      paragraph(box, value.message || value.clarification || '找到以下指南条目，请结合适用限制选择。', value.status === 'unsupported' ? 'notice' : undefined);
      for (const entry of value.cards || []) card(box, entry);
    } else markdown(box, data.markdown);
    if (data.summary) paragraph(box, data.summary.message || (data.summary.saved ? '摘要已保存。' : '本轮未写入记忆。'), 'summary-note' + (!data.summary.saved && memoryEnabled ? ' error' : ''));
  }
  function turn(query) {
    const node = element('article', undefined, 'turn'), question = element('div', undefined, 'question');
    question.append(element('span', '你', 'speaker')); paragraph(question, query); node.append(question);
    const answer = element('div'); node.append(answer); $('chat').append(node); return { node, answer };
  }
  return { $, labels, element, paragraph, button, markdown, card, result, turn, status(text, tone = '') { $('status').textContent = text; $('status').dataset.tone = tone; } };
})();
