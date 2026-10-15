// A small, DOM-only Markdown renderer for assistant messages. Raw HTML and
// images stay text; no model output is assigned to innerHTML or executed.
export function safeMarkdownUrl(value){
 const raw=String(value||'').trim();
 if(!raw||/[\u0000-\u0020\u007f]/.test(raw))return null;
 if(/^#[\w-]+$/.test(raw))return raw;
 try{const url=new URL(raw);return ['https:','http:','mailto:'].includes(url.protocol)?url.href:null;}catch{return null;}
}
export function parseInline(source,depth=0){
 const text=String(source||''),nodes=[];let i=0,buffer='';
 const flush=()=>{if(buffer){nodes.push({type:'text',text:buffer});buffer='';}};
 while(i<text.length){
  if(text[i]==='\\'&&/[\\`*_{}\[\]()#+.!>~-]/.test(text[i+1]||'')){buffer+=text[i+1];i+=2;continue;}
  const rest=text.slice(i),code=rest.match(/^(`+)([\s\S]*?)\1(?!`)/);
  if(code){flush();nodes.push({type:'code',text:code[2].replace(/\n/g,' ')});i+=code[0].length;continue;}
  const link=depth<12&&rest.match(/^\[([^\]\n]+)\]\(([^\s()]+)(?:\s+"[^"\n]*")?\)/);
  if(link&&safeMarkdownUrl(link[2])){flush();nodes.push({type:'link',href:safeMarkdownUrl(link[2]),children:parseInline(link[1],depth+1)});i+=link[0].length;continue;}
  let matched=false;
  if(depth<12)for(const [marker,type]of [['**','strong'],['__','strong'],['~~','del'],['*','em'],['_','em']]){
   if(!rest.startsWith(marker)||/\s/.test(rest[marker.length]||'')||(marker==='_'&&/[\p{L}\p{N}]/u.test(text[i-1]||'')))continue;
   const end=text.indexOf(marker,i+marker.length);
   if(end<=i+marker.length||/\s/.test(text[end-1]))continue;
   flush();nodes.push({type,children:parseInline(text.slice(i+marker.length,end),depth+1)});i=end+marker.length;matched=true;break;
  }
  if(matched)continue;
  buffer+=text[i++];
 }
 flush();return nodes;
}
const listLine=line=>line.match(/^( *)([-+*]|\d+[.)])\s+(.*)$/);
const fenceLine=line=>line.match(/^ {0,3}(`{3,}|~{3,})([^`~]*)$/);
const headingLine=line=>line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
const ruleLine=line=>/^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(line);
const blockStart=line=>listLine(line)||fenceLine(line)||headingLine(line)||/^ {0,3}>/.test(line)||ruleLine(line);
export function parseMarkdown(source,depth=0){
 const lines=String(source??'').replace(/\r\n?/g,'\n').replace(/\t/g,'    ').split('\n'),blocks=[];let i=0;
 if(depth>12)return [{type:'paragraph',children:[{type:'text',text:lines.join('\n')}]}];
 while(i<lines.length){
  const line=lines[i];if(!line.trim()){i++;continue;}
  const fence=fenceLine(line);
  if(fence){const content=[];i++;while(i<lines.length&&!new RegExp('^ {0,3}'+fence[1][0]+'{'+fence[1].length+',}\\s*$').test(lines[i]))content.push(lines[i++]);if(i<lines.length)i++;blocks.push({type:'codeblock',text:content.join('\n')});continue;}
  const heading=headingLine(line);
  if(heading){blocks.push({type:'heading',level:Math.min(6,heading[1].length+1),children:parseInline(heading[2])});i++;continue;}
  if(ruleLine(line)){blocks.push({type:'rule'});i++;continue;}
  if(/^ {0,3}>/.test(line)){const quoted=[];while(i<lines.length&&/^ {0,3}>/.test(lines[i]))quoted.push(lines[i++].replace(/^ {0,3}> ?/,''));blocks.push({type:'quote',children:parseMarkdown(quoted.join('\n'),depth+1)});continue;}
  const first=listLine(line);
  if(first){const indent=first[1].length,ordered=/\d/.test(first[2][0]),items=[],start=ordered?Number.parseInt(first[2],10):undefined;
   while(i<lines.length){const match=listLine(lines[i]);if(!match||match[1].length!==indent||/\d/.test(match[2][0])!==ordered)break;
    const offset=match[0].length-match[3].length,content=[match[3]];i++;
    while(i<lines.length){const next=listLine(lines[i]);if(next&&next[1].length<=indent)break;
     if(!lines[i].trim()){let j=i+1;while(j<lines.length&&!lines[j].trim())j++;if(j===lines.length||lines[j].search(/\S/)<offset)break;content.push('');i++;continue;}
     if(lines[i].search(/\S/)>=offset){content.push(lines[i++].slice(offset));continue;}
     if(blockStart(lines[i]))break;
     content.push(lines[i++].trimStart());
    }
    items.push(parseMarkdown(content.join('\n'),depth+1));
    while(i<lines.length&&!lines[i].trim()){let j=i+1;while(j<lines.length&&!lines[j].trim())j++;const next=listLine(lines[j]||'');if(next&&next[1].length===indent){i=j;break;}break;}
   }
   blocks.push({type:'list',ordered,start,items});continue;
  }
  const paragraph=[line.trimStart()];i++;
  while(i<lines.length&&lines[i].trim()&&!blockStart(lines[i]))paragraph.push(lines[i++].trimStart());
  blocks.push({type:'paragraph',children:parseInline(paragraph.join('\n'))});
 }
 return blocks;
}
function inlineNodes(nodes,doc){
 const fragment=doc.createDocumentFragment();
 for(const node of nodes){
  if(node.type==='text'){const lines=node.text.split('\n');lines.forEach((line,i)=>{if(i)fragment.append(doc.createElement('br'));fragment.append(doc.createTextNode(line));});continue;}
  const tag={strong:'strong',em:'em',del:'del',code:'code',link:'a'}[node.type];if(!tag)continue;
  const el=doc.createElement(tag);
  if(node.type==='code')el.textContent=node.text;else el.append(inlineNodes(node.children,doc));
  if(node.type==='link'){el.href=node.href;if(!node.href.startsWith('#')){el.target='_blank';el.rel='noopener noreferrer';}}
  fragment.append(el);
 }
 return fragment;
}
function blockNodes(blocks,doc){
 const fragment=doc.createDocumentFragment();
 for(const block of blocks){
  const tag={paragraph:'p',heading:'h'+block.level,rule:'hr',quote:'blockquote',codeblock:'pre',list:block.ordered?'ol':'ul'}[block.type];if(!tag)continue;
  const el=doc.createElement(tag);
  if(block.type==='codeblock'){const code=doc.createElement('code');code.textContent=block.text;el.append(code);}
  else if(block.type==='list'){if(block.ordered&&block.start!==1)el.start=block.start;for(const item of block.items){const li=doc.createElement('li');li.append(blockNodes(item,doc));el.append(li);}}
  else if(block.type==='quote')el.append(blockNodes(block.children,doc));
  else if(block.children)el.append(inlineNodes(block.children,doc));
  fragment.append(el);
 }
 return fragment;
}
export function renderMarkdown(target,source){
 target.classList.add('answer-markdown');target.replaceChildren(blockNodes(parseMarkdown(source),target.ownerDocument));return target;
}
