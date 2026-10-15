"""Inspect tracked source files without reading or printing local credentials."""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def check():
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    errors = []
    for name in filter(None, files):
        p = Path(name)
        if (set(p.parts) & {'.runtime', '.venv', '__pycache__', '.pytest_cache', '.preview-site', '.private-backups'}
                or any(part.startswith('.venv-') for part in p.parts)
                or p.name in {'api.json', 'auth.json', 'login.json'}
                or (p.name.startswith('.env') and p.name != '.env.example')
                or '.sqlite' in p.name):
            errors.append(name + ': private runtime/config file')
            continue
        raw = (ROOT / p).read_bytes()
        if re.search(rb'sk-[A-Za-z0-9_-]{20,}', raw):
            errors.append(name + ': possible credential')
        if re.search(rb'(?m)^-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----\r?$', raw):
            errors.append(name + ': private key')
    if errors:
        raise SystemExit('\n'.join(errors))
    print('Tracked source check passed; credentials and runtime files excluded.')

if __name__ == '__main__':
    check()
