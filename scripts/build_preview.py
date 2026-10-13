"""Build a static UI preview. Never copies local configs, runtime data or backend code."""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / '.preview-site'

def build():
    if DEST.exists():
        shutil.rmtree(DEST)
    DEST.mkdir()
    source = (ROOT / 'frontend/index.html').read_text()
    source = source.replace('<title>苟活 · 问题回访与会话记忆</title>', '<title>苟活 · 团队静态预览</title>')
    source = source.replace('<span class="pill">Python 独立版</span>', '<span class="pill">团队静态预览 · 模拟交互</span>')
    source = source.replace('体验账户为虚构数据；咨询内容来自固定指南快照。', '没有连接模型或后端；记忆仅保存在当前浏览器。')
    source = source.replace('模型记录你明确表达的状态、问题和咨询过的指南，无需每次手动保存。', '正式版由模型记录状态、问题和咨询过的指南；本页仅模拟该过程。')
    source = source.replace('<section id="login">', '''<section><strong>这是界面和流程预览，不是实际 AI 服务。</strong><p>可体验回访、纠正、删除、关闭记忆和账号切换。演示问答固定使用“手机通知打断工作”案例；真实功能请运行仓库中的 Docker 版。</p><div class="row"><button id="demo-alice">进入 Alice 预览</button><button id="demo-bob">进入 Bob 预览</button><button id="demo-reset">重置演示数据</button><a href="architecture/index.html">架构与流程图</a><a href="https://github.com/shuaishuaisylas/LifeOS">源码与调试说明</a></div></section><section id="login">''')
    source = source.replace('<h2>登录</h2>', '<h2>进入虚构账号</h2><small>账号 alice 或 bob，演示口令 preview；不对应真实服务的账号密码。</small>')
    source = source.replace('<script src="/app.js"></script>', '<script src="fixture.js"></script><script src="preview.js"></script><script src="app.js"></script>')
    (DEST / 'index.html').write_text(source)
    (DEST / 'app.js').write_text((ROOT / 'frontend/app.js').read_text().replace('模型会话摘要', '前端模拟摘要'))
    shutil.copyfile(ROOT / 'preview/adapter.js', DEST / 'preview.js')
    guide = json.loads((ROOT / 'data/guide.json').read_text())
    entry = next(e for e in guide['entries'] if e['guide_id'] == '03-01')
    (DEST / 'fixture.js').write_text('window.PREVIEW_GUIDE = ' + json.dumps(entry, ensure_ascii=False) + ';\n')
    (DEST / '.nojekyll').touch()
    doc = ROOT / 'docs/团队讲解'
    arch = DEST / 'architecture'
    arch.mkdir()
    html = (doc / '苟活项目架构与流程说明.html').read_text()
    # Code references are for the project tree, not the static artifact.
    import re
    def link(match):
        path = match.group(1)
        if path.startswith('../../'):
            return 'href="https://github.com/shuaishuaisylas/LifeOS/blob/main/' + path[6:] + '"'
        if path.startswith('../'):
            return 'href="https://github.com/shuaishuaisylas/LifeOS/blob/main/docs/' + path[3:] + '"'
        return match.group(0)
    html = re.sub(r'href="([^"]+)"', link, html)
    (arch / 'index.html').write_text(html)
    for p in doc.iterdir():
        if p.is_file() and p.suffix in {'.pdf', '.md'}:
            shutil.copyfile(p, arch / p.name)
    shutil.copytree(doc / '图示', arch / '图示')
    print('Static preview built at', DEST, '(synthetic browser records; no model calls).')

if __name__ == '__main__':
    build()
