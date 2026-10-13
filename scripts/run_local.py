"""Launch two independent processes; Ctrl+C only stops the children launched here."""
import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    for port in (8780, 8781):
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', port)) == 0:
                raise SystemExit('端口 %d 已被占用。请先停止独立版进程或使用其他端口启动。' % port)
    processes = []
    try:
        processes.append(subprocess.Popen([sys.executable, '-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8781', '--workers', '1', '--no-access-log'], cwd=ROOT))
        processes.append(subprocess.Popen([sys.executable, str(ROOT / 'scripts/frontend_server.py')], cwd=ROOT))
        for _ in range(50):
            if any(p.poll() is not None for p in processes):
                raise RuntimeError('启动失败，请查看上述错误。')
            with socket.socket() as s:
                ready = s.connect_ex(('127.0.0.1', 8781)) == 0
            if ready:
                break
            time.sleep(0.1)
        print('苟活独立版：http://localhost:8780\n登录账号和首次密码：' + str(ROOT / '.runtime/login.json') + '\n按 Ctrl+C 停止本次启动的前后端进程。', flush=True)
        if os.getenv('NO_BROWSER') != '1':
            webbrowser.open('http://localhost:8780')
        while all(p.poll() is None for p in processes):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for p in processes:
            if p.poll() is None:
                p.terminate()
        for p in processes:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
