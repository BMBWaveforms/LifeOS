"""Render the architecture narrative and four editable diagrams into SVG, HTML and PDF.

Uses document-only dependencies installed outside the application virtual environment.
"""
from pathlib import Path
import json
import re
import html
from xml.etree import ElementTree as ET
import markdown
import fitz
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.graphics.shapes import String
from svglib.svglib import svg2rlg

ROOT=Path(__file__).resolve().parents[1]
FIG=ROOT/'图示'
TMP=ROOT/'维护/预览'
FIG.mkdir(exist_ok=True);TMP.mkdir(exist_ok=True)
FONT='/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
pdfmetrics.registerFont(TTFont('TeamCN',FONT))
pdfmetrics.registerFontFamily('TeamCN',normal='TeamCN',bold='TeamCN',italic='TeamCN',boldItalic='TeamCN')
P={'system':('#edf5ef','#2b6349'),'model':('#eaf1fa','#3a6692'),'store':('#fff5e2','#9a6b25'),'decision':('#f2eef9','#73578f'),'error':('#fff0ee','#a35244'),'neutral':('#f3f5f6','#637279')}

def n(id,x,y,w,h,text,style='system',diamond=False):
    return {'id':id,'x':x,'y':y,'w':w,'h':h,'text':text,'style':style,'diamond':diamond}
def e(a,b,points,label='',at=None,dashed=False):
    return {'a':a,'b':b,'points':points,'label':label,'at':at,'dashed':dashed}

graphs=[]
graphs.append({'name':'01整体架构','title':'整体架构','subtitle':'前端负责交互，Python 编排流程，模型返回选择和摘要，后端控制来源与写入。','width':1280,'height':995,
'nodes':[
n('U',465,35,350,90,'用户浏览器'),n('F',465,180,350,100,'独立前端\n静态页面与 API 转发'),n('API',465,345,350,100,'FastAPI\n身份验证与接口'),n('O',465,510,350,110,'AgentService\n问答、摘要、回访编排'),
n('T',40,510,345,110,'只读指南工具\n完整回读与结果校验'),n('G',40,730,345,110,'固定指南 JSON\n687 个完整条目','store'),n('M',900,510,340,110,'远程 DeepSeek API\n理解、选择、摘要','model'),
n('S',465,730,350,100,'Store\n记忆、用户归属、版本'),n('D',465,895,350,90,'SQLite\n长期摘要与问题进展','store'),n('P',900,730,340,110,'独立提示词与工具定义\nprompts/ 文件','neutral'),n('K',900,895,340,90,'后端私有凭据\n不进入前端','neutral')],
'edges':[e('U','F',[(640,125),(640,180)]),e('F','API',[(640,280),(640,345)]),e('API','O',[(640,445),(640,510)]),e('O','T',[(465,565),(385,565)]),e('T','G',[(212,620),(212,730)]),e('O','M',[(815,565),(900,565)]),e('O','S',[(640,620),(640,730)]),e('S','D',[(640,830),(640,895)]),e('P','O',[(900,785),(860,785),(860,600),(815,600)],dashed=True),e('K','M',[(1070,895),(1070,870),(1260,870),(1260,565),(1240,565)],dashed=True)],
'caption':'实线表示调用或资料读取，虚线表示配置输入。Python 方框是同一后端进程内的模块，不是多个独立服务。模型返回值仍须经过后端核对。'})

graphs.append({'name':'02问答流程','title':'问答与自动摘要的完整流程','subtitle':'先形成已校验答复，再尝试保存摘要，最后一起返回；前端随后刷新回访。','width':1280,'height':1520,
'nodes':[n('Q',450,20,380,80,'用户提交问题'),n('A',450,145,380,95,'验证身份\n构建本轮上下文'),n('L',450,290,380,95,'加载提示词\n调用问答 Agent','model'),n('T',515,440,250,125,'请求工具？','decision',True),n('R',915,450,330,110,'搜索候选标题\n或完整回读条目'),n('V',450,620,380,100,'校验来源、用户归属\n和记忆版本'),n('E',515,765,250,125,'通过？','decision',True),n('X',35,775,340,110,'技术错误\n不展示未校验结果','error'),n('C',450,945,380,80,'形成已校验答复'),n('B',515,1080,250,125,'记忆开启？','decision',True),n('S',915,1085,330,120,'调用摘要模型\n校验并尝试保存','model'),n('N',35,1085,340,120,'关闭长期记忆\n本轮不保存摘要','neutral'),n('O',450,1280,380,90,'返回答复\n及摘要保存状态'),n('H',450,1425,380,85,'展示答复、读取记忆\n刷新首页回访')],
'edges':[e('Q','A',[(640,100),(640,145)]),e('A','L',[(640,240),(640,290)]),e('L','T',[(640,385),(640,440)]),e('T','R',[(765,502),(915,502)],'是',(838,486)),e('R','L',[(1080,450),(1080,337),(830,337)]),e('T','V',[(640,565),(640,620)],'否',(670,600)),e('L','X',[(450,337),(410,337),(410,830),(375,830)],'调用失败',(340,600)),e('V','E',[(640,720),(640,765)]),e('E','X',[(515,827),(375,827)],'否',(447,810)),e('E','C',[(640,890),(640,945)],'是',(675,923)),e('C','B',[(640,1025),(640,1080)]),e('B','S',[(765,1142),(915,1142)],'是',(839,1128)),e('B','N',[(515,1142),(375,1142)],'否',(445,1128)),e('S','O',[(1080,1205),(1080,1245),(640,1245),(640,1280)]),e('N','O',[(205,1205),(205,1245),(640,1245),(640,1280)]),e('O','H',[(640,1370),(640,1425)])],
'caption':'来源、模型或工具失败不等于“指南未覆盖”。摘要失败会明确提示未写入；记忆管理导致版本变化时，旧结果失效。工具循环和调用时长均有上限。'})

graphs.append({'name':'03记忆更新','title':'长期摘要的保存与更新','subtitle':'摘要是否有效与问题是否解决是两种独立状态；已解决经历仍可保留。','width':1280,'height':1295,
'nodes':[n('A',450,20,380,90,'本轮答复已校验\n且记忆开启'),n('B',450,165,380,95,'模型生成会话摘要\n和结构化字段','model'),n('C',450,315,380,105,'校验原文、真实指南\n关联记录及记忆版本'),n('D',515,480,250,125,'通过？','decision',True),n('X',35,487,340,110,'不写入\n明确提示摘要失败','error'),n('P',515,670,250,125,'延续旧问题？','decision',True),n('S',915,680,330,110,'旧摘要变为\nsuperseded','store'),n('N',35,680,340,110,'作为新问题\n或无问题摘要','neutral'),n('W',450,880,380,105,'事务写入新摘要 active\n同时更新记忆版本','store'),n('H',515,1050,250,125,'问题已解决？','decision',True),n('R',915,1055,330,120,'保留咨询经历\n首页不再回访','store'),n('F',35,1055,340,120,'尚未解决或未说明\n有具体主题才回访')],
'edges':[e('A','B',[(640,110),(640,165)]),e('B','C',[(640,260),(640,315)]),e('C','D',[(640,420),(640,480)]),e('D','X',[(515,542),(375,542)],'否',(445,524)),e('D','P',[(640,605),(640,670)],'是',(673,642)),e('P','S',[(765,732),(915,732)],'是',(840,715)),e('P','N',[(515,732),(375,732)],'否',(445,715)),e('S','W',[(1080,790),(1080,830),(640,830),(640,880)]),e('N','W',[(205,790),(205,830),(640,830),(640,880)]),e('W','H',[(640,985),(640,1050)]),e('H','R',[(765,1112),(915,1112)],'是',(840,1095)),e('H','F',[(515,1112),(375,1112)],'否',(445,1095))],
'caption':'同一问题的新摘要替代旧摘要参与后续上下文。resolved 不会自动把摘要变成 superseded；问候可保存摘要，但没有问题主题就不创建回访。'})

graphs.append({'name':'04首页回访','title':'首页回访与用户后续选择','subtitle':'首页先问进展；用户继续提交问题后，才查询和展示指南正文。','width':1280,'height':1395,
'nodes':[n('A',450,20,380,85,'进入首页或刷新回访'),n('B',450,160,380,95,'读取当前用户\n近期有效记忆'),n('C',450,305,380,100,'筛选具体问题\n且未确认已解决'),n('D',515,465,250,125,'有候选？','decision',True),n('N',35,475,340,115,'暂无回访\n无需调用首页模型','neutral'),n('M',450,670,380,95,'模型选择候选记录 ID','model'),n('V',450,825,380,100,'后端核对 ID\n生成进展与咨询询问'),n('U',515,985,250,125,'用户选择','decision',True),n('P',35,990,340,120,'已解决或还没解决\n关联原问题的新对话'),n('Q',915,990,330,120,'继续问相关指南\n预填并由用户提交'),n('S',35,1240,340,110,'重新总结进展\n保存后刷新首页','store'),n('F',915,1240,330,110,'进入问答流程\n检索后展示指南')],
'edges':[e('A','B',[(640,105),(640,160)]),e('B','C',[(640,255),(640,305)]),e('C','D',[(640,405),(640,465)]),e('D','N',[(515,527),(375,527)],'否',(445,510)),e('D','M',[(640,590),(640,670)],'是',(673,638)),e('M','V',[(640,765),(640,825)]),e('V','U',[(640,925),(640,985)]),e('U','P',[(515,1047),(375,1047)],'记录进展',(445,1020)),e('U','Q',[(765,1047),(915,1047)],'继续咨询',(840,1020)),e('P','S',[(205,1110),(205,1240)]),e('Q','F',[(1080,1110),(1080,1240)])],
'caption':'当前从最近最多 12 条有效记忆中筛选最多 3 条候选。首页只接收记录 ID、主题、最新状态及时间，回访本身不生成新的对话摘要。'})

(FIG/'图示源数据.json').write_text(json.dumps(graphs,ensure_ascii=False,indent=2))

def mermaid(g):
    lines=['flowchart TB']
    for node in g['nodes']:
        label=node['text'].replace('\n','<br/>')
        shape=('{"'+label+'"}') if node['diamond'] else ('["'+label+'"]')
        lines.append('  '+node['id']+shape)
    for edge in g['edges']:
        connector=' -.-> ' if edge['dashed'] else ' --> '
        label='|'+edge['label']+'|' if edge['label'] else ''
        lines.append('  '+edge['a']+connector+label+edge['b'])
    for style in P:
        fill,stroke=P[style]
        lines.append('  classDef '+style+' fill:'+fill+',stroke:'+stroke+',color:#20362c,stroke-width:2px')
        ids=','.join(n['id'] for n in g['nodes'] if n['style']==style)
        if ids:lines.append('  class '+ids+' '+style)
    return '\n'.join(lines)+'\n'

def svg(g):
    w,h=g['width'],g['height']
    out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="{html.escape(g["title"])}">',
         '<defs><marker id="arrow" markerWidth="11" markerHeight="11" refX="10" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L10 5 L0 10 Z" fill="#5a7167"/></marker></defs>',
         f'<rect width="{w}" height="{h}" fill="#ffffff"/>']
    for edge in g['edges']:
        pts=edge['points'];path='M '+' L '.join(f'{x},{y}' for x,y in pts)
        dash=' stroke-dasharray="8 7"' if edge['dashed'] else ''
        out.append(f'<path d="{path}" fill="none" stroke="#5a7167" stroke-width="2.6" marker-end="url(#arrow)"{dash}/>')
    for node in g['nodes']:
        x,y,w,h=(node[k] for k in ('x','y','w','h'));fill,stroke=P[node['style']]
        if node['diamond']:
            points=f'{x+w/2},{y} {x+w},{y+h/2} {x+w/2},{y+h} {x},{y+h/2}'
            out.append(f'<polygon points="{points}" fill="{fill}" stroke="{stroke}" stroke-width="2.3"/>')
        else:
            out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="17" fill="{fill}" stroke="{stroke}" stroke-width="2.3"/>')
        lines=node['text'].split('\n');size=27 if node['diamond'] else 28
        start=y+h/2-(len(lines)-1)*19+10
        for i,line in enumerate(lines):
            out.append(f'<text x="{x+w/2}" y="{start+i*38}" text-anchor="middle" font-family="TeamCN, Arial Unicode MS, PingFang SC, Microsoft YaHei, sans-serif" font-size="{size}" fill="#20362c">{html.escape(line)}</text>')
            assert pdfmetrics.stringWidth(line,'TeamCN',size) < w-18, (g['name'],line)
    for edge in g['edges']:
        if edge['label']:
            x,y=edge['at'];s=html.escape(edge['label'])
            out.append(f'<text x="{x}" y="{y}" text-anchor="middle" font-family="TeamCN, Arial Unicode MS, PingFang SC, Microsoft YaHei, sans-serif" font-size="24" fill="#3c5549">{s}</text>')
    return ''.join(out)+'</svg>'

for g in graphs:
    (FIG/(g['name']+'.mmd')).write_text(mermaid(g))
    (FIG/(g['name']+'.svg')).write_text(svg(g))

mdpath=ROOT/'苟活项目架构与流程说明.md'
md=mdpath.read_text()
assert len(re.findall(r'```mermaid\n.*?```',md,re.S))==4
parts=re.split(r'```mermaid\n.*?```',md,flags=re.S)
md=''.join(p+('```mermaid\n'+mermaid(graphs[i])+'```' if i<len(graphs) else '') for i,p in enumerate(parts))
mdpath.write_text(md)

html_md=md
for i,g in enumerate(graphs):
    html_md=re.sub(r'```mermaid\n.*?```',f'<div class="diagram"><figure><figcaption><strong>{i+1:02d} {g["title"]}</strong><p>{g["subtitle"]}</p></figcaption>{svg(g)}<p class="caption">{g["caption"]}</p><a href="图示/{g["name"]}.svg" download>下载 SVG</a> · <a href="图示/{g["name"]}.mmd" download>下载 Mermaid</a></figure></div>',html_md,count=1,flags=re.S)
body=markdown.markdown('[TOC]\n\n'+html_md,extensions=['tables','fenced_code','toc'])
css='''*{box-sizing:border-box}body{margin:0;color:#243c30;background:#f4f6f2;font:16px/1.85 system-ui,-apple-system,"PingFang SC",sans-serif}header{background:#244837;color:#fff;padding:40px 7vw}header p{color:#d4e2d8;margin:0}header h1{font-size:32px;margin:0 0 10px}main{max-width:1060px;margin:36px auto;padding:0 28px 60px}main>h1{display:none}h2{font-size:25px;color:#28523d;margin:54px 0 20px;padding-top:10px}p{margin:16px 0}table{width:100%;border-collapse:collapse;background:#fff;font-size:14px;line-height:1.65;margin:22px 0}th{text-align:left;background:#e5eee4;color:#284e39}th,td{border:1px solid #d4dfd3;padding:12px;vertical-align:top}code{font-size:.9em;background:#e9efe6;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}a{color:#286547}.diagram{background:white;border:1px solid #d4dfd3;border-radius:14px;margin:26px 0;padding:18px}.diagram figure{margin:0}.diagram svg{display:block;max-width:100%;height:auto;max-height:860px;margin:20px auto}.diagram figcaption strong{font-size:22px}.diagram figcaption p,.caption{font-size:14px;color:#596d5d;line-height:1.7}.caption{padding:12px;background:#f4f7f1;border-radius:6px}.actions{display:flex;gap:16px;flex-wrap:wrap;margin-top:20px}.actions a{color:#fff;background:#3d6650;padding:8px 16px;border-radius:8px;text-decoration:none}.toc{font-size:14px;background:#eaf0e6;padding:18px 28px;border-radius:12px}@media(max-width:700px){main{padding:0 16px}header{padding:26px 16px}table{display:block;overflow-x:auto}th,td{min-width:130px}}@media print{body{background:white;font-size:11pt}header{background:white;color:#243c30;padding:0}header p{color:#536956}.actions,.toc{display:none}main{padding:0;max-width:100%;margin:0}.diagram{break-inside:avoid}.diagram svg{max-height:650px}h2{break-after:avoid}a{color:inherit}}'''
(ROOT/'苟活项目架构与流程说明.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>苟活项目架构与流程说明</title><style>'+css+'</style><header><h1>苟活项目架构与流程说明</h1><p>Python 独立版 v1.0 · 面向团队讲解 · 2026-10-13</p><div class="actions"><a href="苟活项目架构与流程说明.pdf">阅读 PDF</a><a href="苟活项目架构与流程说明.md">编辑 Markdown</a></div></header><main>'+body+'</main></html>')

# Parse a document structure without relying on browser printing.
from html.parser import HTMLParser
class Blocks(HTMLParser):
    def __init__(self):
        super().__init__();self.depth=0;self.current=[];self.blocks=[]
    def handle_starttag(self,tag,attrs):
        if self.depth==0:self.current=[]
        if tag not in ('br','hr','img','input','meta','link'):self.depth+=1
        self.current.append('<'+tag+''.join(' '+k+'="'+html.escape(v or '',quote=True)+'"' for k,v in attrs)+'>')
    def handle_endtag(self,tag):
        self.current.append('</'+tag+'>');self.depth-=1
        if self.depth==0:self.blocks.append(''.join(self.current))
    def handle_data(self,data):
        if self.depth:self.current.append(html.escape(data))

# Replace diagram code blocks with small markers, then parse standard markdown HTML.
textmd=md
for i in range(4):textmd=re.sub(r'```mermaid\n.*?```',f'<p>DIAGRAM_{i}</p>',textmd,count=1,flags=re.S)
parser=Blocks();parser.feed(markdown.markdown(textmd,extensions=['tables','fenced_code']))
styles=getSampleStyleSheet()
for key in ('Normal','BodyText','Title','Heading1','Heading2','Heading3'):
    styles[key].fontName='TeamCN';styles[key].wordWrap='CJK'
styles['BodyText'].fontSize=10;styles['BodyText'].leading=16;styles['BodyText'].spaceAfter=9
styles['Heading2'].keepWithNext=1;styles['Heading1'].keepWithNext=1;styles['Heading2'].fontSize=15;styles['Heading2'].leading=22;styles['Heading2'].spaceBefore=17;styles['Heading2'].spaceAfter=9
styles['Heading1'].fontSize=23;styles['Heading1'].leading=32;styles['Heading1'].spaceAfter=18
styles.add(ParagraphStyle(name='SmallCN',fontName='TeamCN',fontSize=8.4,leading=12,wordWrap='CJK',textColor=colors.HexColor('#526658')))
styles.add(ParagraphStyle(name='CellCN',fontName='TeamCN',fontSize=8.7,leading=13,wordWrap='CJK'))
styles.add(ParagraphStyle(name='CellHead',parent=styles['CellCN'],textColor=colors.HexColor('#244d37')))

def plain(text):return html.unescape(re.sub('<[^>]+>','',text))
def inline(text):
    text=re.sub(r'</?p[^>]*>','',text)
    text=text.replace('<strong>','<b>').replace('</strong>','</b>').replace('<em>','<i>').replace('</em>','</i>')
    text=re.sub(r'</?code[^>]*>','',text)
    # Avoid local relative links being interpreted as nonexistent PDF link targets.
    text=re.sub(r'<a\s+[^>]*>(.*?)</a>',r'\1',text,flags=re.S)
    return text

def drawing(g):
    d=svg2rlg(str(FIG/(g['name']+'.svg')))
    def adjust(item):
        if isinstance(item,String):item.fontName='TeamCN'
        for child in getattr(item,'contents',[]):adjust(child)
    adjust(d)
    scale=min(510/d.width,620/d.height)
    d.scale(scale,scale);d.width*=scale;d.height*=scale
    return d

# Reusable PNG exports for messaging and team slides, derived from the same vector diagrams.
from reportlab.graphics import renderPDF
for g in graphs:
    payload=renderPDF.drawToString(drawing(g))
    with fitz.open(stream=payload,filetype='pdf') as image_pdf:
        image_pdf[0].get_pixmap(matrix=fitz.Matrix(3,3),alpha=False).save(str(FIG/(g['name']+'.png')))

story=[]
for block in parser.blocks:
    tag=re.match('<(\w+)',block).group(1)
    contents=re.sub(r'^<[^>]+>|</[^>]+>$','',block)
    marker=re.search(r'DIAGRAM_(\d)',contents)
    if marker:
        i=int(marker[1]);g=graphs[i]
        story.append(PageBreak())
        section_titles=['2 整体架构和职责','3 一次问答怎样完成','4 长期记忆怎样保存和更新','5 首页如何回访']
        story.append(Paragraph(section_titles[i],styles['Heading2']))
        story.append(Paragraph(f'图 {i+1} {g["title"]}',styles['SmallCN']))
        story.append(Paragraph(g['subtitle'],styles['SmallCN']))
        story.append(Spacer(1,10));story.append(drawing(g));story.append(Spacer(1,9))
        story.append(Paragraph(g['caption'],styles['SmallCN']))
        story.append(PageBreak());continue
    if tag in ('h1','h2','h3'):
        # The following diagram has its own full page; keep the section title with intro text.
        story.append(Paragraph(inline(contents),styles['Heading1' if tag=='h1' else 'Heading2']))
    elif tag=='p':story.append(Paragraph(inline(contents),styles['BodyText']))
    elif tag=='table':
        rows=[]
        for tr in re.findall(r'<tr>(.*?)</tr>',contents,re.S):
            cells=re.findall(r'<(?:td|th)[^>]*>(.*?)</(?:td|th)>',tr,re.S)
            rows.append([Paragraph(inline(c),styles['CellHead' if not rows else 'CellCN']) for c in cells])
        count=len(rows[0]);widths=[510/count]*count
        if count==3:widths=[120,195,195]
        t=Table(rows,colWidths=widths,repeatRows=1,hAlign='LEFT')
        t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e8f0e5')),('GRID',(0,0),(-1,-1),0.4,colors.HexColor('#d2dccf')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
        story.append(KeepTogether([t,Spacer(1,12)]))
    elif tag in ('ul','ol'):
        for li in re.findall(r'<li>(.*?)</li>',contents,re.S):story.append(Paragraph('• '+inline(li),styles['BodyText']))

# Remove headings directly before figure page breaks to avoid lonely heading pages.
for i in range(len(story)-2,-1,-1):
    if isinstance(story[i],Paragraph) and isinstance(story[i+1],PageBreak) and re.match(r'[2345] ',story[i].getPlainText()):
        del story[i]

# Keep an entire table with its heading, avoiding a heading stranded on the prior page.
for i in range(len(story)-2,-1,-1):
    if isinstance(story[i],Paragraph) and story[i].style.name=='Heading2' and isinstance(story[i+1],KeepTogether):
        bundle=story[i+1]._content
        story[i:i+2]=[KeepTogether([story[i]]+list(bundle))]


def footer(canvas,doc):
    canvas.setFont('TeamCN',8);canvas.setFillColor(colors.HexColor('#607165'))
    canvas.drawString(42,23,'苟活 Python 独立版 v1.0  |  团队架构说明  |  2026-10-13')
    canvas.drawRightString(A4[0]-42,23,str(doc.page))

pdf=ROOT/'苟活项目架构与流程说明.pdf'
doc=SimpleDocTemplate(str(pdf),pagesize=A4,rightMargin=42,leftMargin=42,topMargin=38,bottomMargin=38,title='苟活项目架构与流程说明',author='苟活项目',allowSplitting=1)
doc.build(story,onFirstPage=footer,onLaterPages=footer)
with fitz.open(pdf) as f:
    metadata=[]
    for i,page in enumerate(f):
        pix=page.get_pixmap(matrix=fitz.Matrix(1.15,1.15),alpha=False)
        pix.save(str(TMP/f'page-{i+1:02d}.png'))
        metadata.append({'page':i+1,'characters':len(page.get_text()),'text_start':page.get_text()[:130]})
    (TMP/'页面检查.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
    print(json.dumps({'pages':len(f),'pdf_bytes':pdf.stat().st_size,'svg_count':len(graphs),'html':str(ROOT/'苟活项目架构与流程说明.html')},ensure_ascii=False))
