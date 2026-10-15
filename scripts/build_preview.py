"""Build the product-only static demo. Never copy credentials, runtime or backend."""
import json
import re
import shutil
from pathlib import Path
from build_horizon_preview import build_horizon

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / '.preview-site'
PRODUCT_FILES = ('api.js', 'ui.js', 'services.js', 'scenes.js', 'app.js', 'styles.css')
GUIDE_IDS = ('15-01', '04-18', '03-01', '02-11', '05-01', '21-07', '15-06', '04-07')
PREVIEW_MARKER = '<!-- Preview modules are injected only by scripts/build_preview.py. -->'


def copy_architecture():
    """Keep the existing team explanation as a read-only reference entry."""
    doc = ROOT / 'docs/团队讲解'
    arch = DEST / 'architecture'
    arch.mkdir()
    html = (doc / '苟活项目架构与流程说明.html').read_text()

    def link(match):
        path = match.group(1)
        if path.startswith('../../'):
            return 'href="https://github.com/shuaishuaisylas/LifeOS/blob/main/' + path[6:] + '"'
        if path.startswith('../'):
            return 'href="https://github.com/shuaishuaisylas/LifeOS/blob/main/docs/' + path[3:] + '"'
        return match.group(0)

    (arch / 'index.html').write_text(re.sub(r'href="([^"]+)"', link, html))
    for path in doc.iterdir():
        if path.is_file() and path.suffix in {'.pdf', '.md'}:
            shutil.copyfile(path, arch / path.name)
    shutil.copytree(doc / '图示', arch / '图示')


def build():
    if DEST.exists():
        shutil.rmtree(DEST)
    DEST.mkdir()
    source = (ROOT / 'frontend/index.html').read_text()
    if source.count(PREVIEW_MARKER) != 1:
        raise ValueError('The production HTML must contain exactly one preview injection marker.')
    source = source.replace('<title>苟活 · LifeOS</title>', '<title>苟活 · 静态交互演示</title>')
    source = source.replace('</head>', '<link rel="stylesheet" href="preview.css"></head>')
    source = source.replace(PREVIEW_MARKER, '<script src="fixture.js"></script><script src="mock-service.js"></script><script src="preview.js"></script>')
    notice = '''<aside id="preview-notice" aria-label="演示环境说明"><details><summary>静态交互演示 · 虚构数据</summary><p>固定情境模拟，没有调用真实 AI 或后端；记录仅保留在本页，刷新即重置。</p><nav><a href="architecture/index.html">架构与流程说明</a><a href="ATTRIBUTION.txt">指南来源</a><a href="GUIDE-LICENSE.txt">CC BY 4.0</a><a href="assets/fonts/OFL.txt">字体许可</a></nav></details></aside>'''
    source = source.replace('<div id="status"', notice + '\n<div id="status"', 1)
    source = source.replace('真实问答需要组员提供的体验账号。', '仅可使用虚构演示账号 alice / bob，演示口令 preview。')
    (DEST / 'index.html').write_text(source)
    for name in PRODUCT_FILES:
        shutil.copyfile(ROOT / 'frontend' / name, DEST / name)
    shutil.copytree(ROOT / 'frontend/assets', DEST / 'assets')
    for original, target in (('adapter.js', 'preview.js'), ('mock-service.js', 'mock-service.js'), ('styles.css', 'preview.css')):
        shutil.copyfile(ROOT / 'preview' / original, DEST / target)
    entries = {entry['guide_id']: entry for entry in json.loads((ROOT / 'data/guide.json').read_text())['entries']}
    guides = [entries[guide_id] for guide_id in GUIDE_IDS]
    (DEST / 'fixture.js').write_text('window.PREVIEW_GUIDES = ' + json.dumps(guides, ensure_ascii=False) + ';\n')
    for name in ('ATTRIBUTION.txt', 'GUIDE-LICENSE.txt'):
        shutil.copyfile(ROOT / 'data' / name, DEST / name)
    (DEST / '.nojekyll').touch()
    copy_architecture()
    build_horizon(DEST / 'horizon')
    print('Static product demo built at', DEST, '(synthetic in-page records; no model or backend).')


if __name__ == '__main__':
    build()
