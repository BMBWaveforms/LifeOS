"""Use the existing pytest CI entry point to validate the candidate Nginx image."""
import os
from pathlib import Path
import shutil
import subprocess
import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(os.getenv('GITHUB_ACTIONS') != 'true' or not shutil.which('docker'),
                    reason='Container validation requires the GitHub-hosted Docker environment')
def test_horizon_nginx_configuration_in_frontend_image():
    build = subprocess.run(['docker', 'build', '--tag', 'lifeos-frontend-check', '--file',
                            'deploy/Dockerfile.frontend', '.'], cwd=ROOT,
                           capture_output=True, text=True, timeout=240)
    assert build.returncode == 0, build.stdout + build.stderr
    result = subprocess.run(['docker', 'run', '--rm', '--add-host', 'backend:127.0.0.1',
                             'lifeos-frontend-check', 'nginx', '-t'], cwd=ROOT,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
