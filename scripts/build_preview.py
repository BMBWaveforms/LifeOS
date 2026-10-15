"""Build the product-only Horizon demo; exclude backend, workbench and private data."""
import re
import shutil
from pathlib import Path
from build_horizon_preview import build_horizon

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / '.preview-site'


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
    build_horizon(DEST)
    (DEST / '.nojekyll').touch()
    copy_architecture()
    print('Static Horizon demo built at', DEST, '(synthetic browser records; no model or backend).')


if __name__ == '__main__':
    build()
