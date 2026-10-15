#!/bin/zsh
set -e
cd "$(dirname "$0")"
lifeos_env=''
for candidate in .venv-sdk/bin/python .venv/bin/python; do
  if [ -x "$candidate" ] && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
    lifeos_env="$candidate"
    break
  fi
done
if [ -z "$lifeos_env" ]; then
  lifeos_python=''
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
      lifeos_python="$candidate"
      break
    fi
  done
  if [ -z "$lifeos_python" ]; then
    print '请先安装 Python 3.10 或以上；也可以使用 Docker 启动。'
    exit 1
  fi
  "$lifeos_python" -m venv .venv-sdk
  lifeos_env='.venv-sdk/bin/python'
fi
if ! "$lifeos_env" -c 'import claude_agent_sdk, fastapi, uvicorn' >/dev/null 2>&1; then
  "$lifeos_env" -m pip install -r requirements-lock.txt
fi
exec "$lifeos_env" scripts/run_local.py
