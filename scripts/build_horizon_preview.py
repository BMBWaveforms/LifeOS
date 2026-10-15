"""Build only the public Horizon candidate, with all real API access disabled."""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULES = (
    'app', 'answer-markdown', 'answer-reveals', 'service', 'runtime-config', 'chat-presentation', 'conversation-library',
    'conversation-ordering', 'conversation-understanding', 'decision-ledger', 'guide-detail', 'guide-share',
    'guide-share-card', 'scene-landing', 'landing-scenes', 'memory-navigation',
    'project-demo', 'workspace-shell',
)
STYLES = ('styles', 'chat-enhancements', 'conversation-library',
          'conversation-understanding', 'decision-ledger', 'guide-detail',
          'guide-share', 'scene-landing', 'workspace-shell')


def build_horizon(destination):
    destination = Path(destination)
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    source = ROOT / 'frontend/horizon'
    for name in ('index.html', *(f'{m}.mjs' for m in MODULES), *(f'{s}.css' for s in STYLES)):
        shutil.copyfile(source / name, destination / name)
    assets = destination / 'assets'
    assets.mkdir()
    for name in ('mark.svg', 'media-sources.json'):
        shutil.copyfile(source / 'assets' / name, assets / name)
    # Always derive the preview from the repository's authoritative guide snapshot.
    for name in ('guide.json', 'ATTRIBUTION.txt', 'GUIDE-LICENSE.txt'):
        shutil.copyfile(ROOT / 'data' / name, assets / name)
    scenes = assets / 'scenes'
    scenes.mkdir()
    # Ship every registered scene, including new user-supplied local footage.
    # Only simple basenames are accepted; the manifest cannot escape assets/scenes.
    media = json.loads((source / 'assets/media-sources.json').read_text())
    scene_names = [clip['name'] for clip in media['clips']]
    if len(set(scene_names)) != len(scene_names):
        raise ValueError('Duplicate Horizon scene media name')
    for scene in scene_names:
        if not scene or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in scene):
            raise ValueError(f'Invalid Horizon scene media name: {scene!r}')
        for ext in ('mp4', 'jpg'):
            shutil.copyfile(source / 'assets/scenes' / f'{scene}.{ext}', scenes / f'{scene}.{ext}')
    (destination / 'runtime.json').write_text(json.dumps({'real_api_enabled': False}) + '\n')


if __name__ == '__main__':
    build_horizon(ROOT / '.preview-site/horizon')
