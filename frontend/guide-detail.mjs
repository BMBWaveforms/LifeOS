// Recompose the returned guide for reading; preserve every original field verbatim.
const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
function field(label,value,name,cls='guide-reader-field'){
 const section=make('section',undefined,cls);section.dataset.field=name;
 section.append(make('h3',label),make('p',value));return section;
}
export function renderGuideDetail(body,card){
 const fields=card.fields||{},reader=make('article',undefined,'guide-reader');
 const summary=fields['说人话']||card.full_text;
 if(summary){const intro=field('建议要点',summary,'说人话','guide-reader-intro');reader.append(intro);}
 const facts=make('aside',undefined,'guide-reader-facts');facts.setAttribute('aria-label','投入与证据');
 if(fields['成本'])facts.append(field('需要投入',fields['成本'],'成本'));
 const evidence=make('section',undefined,'guide-reader-field guide-reader-evidence');evidence.dataset.field='证据等级';evidence.append(make('h3','证据等级'),make('p',fields['证据等级']||'未标注','guide-reader-grade'));facts.append(evidence);
 const edition=make('div',undefined,'guide-reader-edition');edition.append(make('span','资料版本'),make('span','2026-10-12'));facts.append(edition);reader.append(facts);
 const article=make('div',undefined,'guide-reader-article');
 if(fields['收益'])article.append(field('收益与依据',fields['收益'],'收益'));
 if(fields['备注'])article.append(field('适用范围与提醒',fields['备注'],'备注'));
 const standard=new Set(['说人话','成本','收益','证据等级','备注','来源']);
 for(const [name,text]of Object.entries(fields))if(!standard.has(name))article.append(field(name,text,name));
 reader.append(article);
 const source=make('details',undefined,'guide-reader-source');source.dataset.field='来源';source.append(make('summary','出处与参考资料'),make('p',fields['来源']||'本条指南未提供独立来源说明。'));reader.append(source);
 reader.append(make('p','以上为指南收录时的内容，资料可能更新，请结合自身情况判断。','guide-reader-note'));
 body.append(reader);
}
