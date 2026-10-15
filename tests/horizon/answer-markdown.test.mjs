import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkdown,parseInline,safeMarkdownUrl} from '../../frontend/horizon/answer-markdown.mjs';
const textOf=nodes=>nodes.map(n=>n.text??textOf(n.children||n.items?.flat()||[])).join('');

test('assistant answers support headings, emphasis, both lists and quotes',()=>{
 const blocks=parseMarkdown('先**整理重点**。\n\n## 提前一周\n\n1. 确认时间\n2. **先打包低频物品**\n\n### 随身清单\n\n- 证件\n- 充电器\n\n> 这是示例。');
 assert.deepEqual(blocks.map(b=>b.type),['paragraph','heading','list','heading','list','quote']);
 assert.equal(blocks[0].children[1].type,'strong');assert.equal(blocks[1].level,3);
 assert.equal(blocks[2].ordered,true);assert.equal(blocks[2].items.length,2);assert.equal(blocks[4].ordered,false);assert.equal(textOf(blocks[5].children),'这是示例。');
});
test('nested lists, continued paragraphs, start numbers and fenced code retain their meaning',()=>{
 const blocks=parseMarkdown('3. 主步骤\n   - 子步骤\n   - 另一项\n4. 最后一步\n\n```js\n<script>不要执行</script>\n**也不是加粗**\n```');
 assert.equal(blocks[0].start,3);assert.equal(blocks[0].items.length,2);assert.equal(blocks[0].items[0][1].type,'list');assert.equal(blocks[0].items[0][1].items.length,2);
 assert.equal(blocks[1].type,'codeblock');assert.equal(blocks[1].text,'<script>不要执行</script>\n**也不是加粗**');
 assert.equal(textOf(parseMarkdown('普通文本\n保留换行')[0].children),'普通文本\n保留换行');
});
test('untrusted HTML and active URL schemes never become executable tokens',()=>{
 const html='<img src=x onerror=alert(1)><script>alert(2)</script>';
 assert.deepEqual(parseMarkdown(html),[{type:'paragraph',children:[{type:'text',text:html}]}]);
 for(const url of ['javascript:alert(1)','jAvAsCrIpT:alert(1)','data:text/html,test','vbscript:msgbox','file:///tmp/test','java\nscript:alert(1)','https://example.com/\u0000bad'])assert.equal(safeMarkdownUrl(url),null);
 assert.equal(parseInline('[点击](javascript:alert)')[0].type,'text');
 assert.equal(safeMarkdownUrl('https://example.com/guide'),'https://example.com/guide');assert.equal(safeMarkdownUrl('#section'),'#section');
 assert.equal(parseInline('[来源](https://example.com/guide)')[0].type,'link');
});
test('code and escaped markers remain literal, unfinished streaming syntax is readable',()=>{
 const nodes=parseInline('`**原文**` 和 \\*不是强调\\*，以及 **重点**');assert.equal(nodes[0].type,'code');assert.equal(nodes[0].text,'**原文**');assert.match(textOf(nodes),/\*不是强调\*/);
 const source='## 标题\n\n1. **先整理**\n2. 然后处理\n\n> 逐步完成';
 for(let i=0;i<=source.length;i++)assert.doesNotThrow(()=>parseMarkdown(source.slice(0,i)));
 assert.equal(textOf(parseInline('这句 **还没结束')),'这句 **还没结束');
});
