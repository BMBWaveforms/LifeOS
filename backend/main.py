"""Independent FastAPI service. Run one worker while using SQLite and in-process runs."""
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
from backend.store import Store
from backend.model import AgentService, ModelClient, ModelError
from backend.workbench import Workbench
from backend.accounts import initialize_accounts
from backend.prompts import PromptRegistry
from backend.evaluation import Evaluation, STAGES, RULES

ROOT = Path(__file__).resolve().parents[1]

def create_app(directory=None, client=None, executors=None):
    directory = Path(directory or os.getenv('DATA_DIR', str(ROOT / '.runtime')))
    directory.mkdir(parents=True, exist_ok=True)
    store = Store(directory)
    auth = initialize_accounts(store, os.getenv('TEST_ACCOUNT_PASSWORD'))
    registry = PromptRegistry(directory)
    service = AgentService(store, client, executors, registry.snapshot)
    workbench = Workbench(directory, service.client, executors, registry)
    evaluation = Evaluation(directory, service.client, registry, executors)
    sessions = {}
    attempts = {}
    login_lock = threading.Lock()
    locks = {owner: threading.Lock() for owner in store.profiles}
    test_locks = {owner: threading.Lock() for owner in store.profiles}
    origins = os.getenv('ALLOWED_ORIGINS', 'http://localhost:8780,http://127.0.0.1:8780').split(',')
    app = FastAPI(title='苟活独立 API', version='1.0.0')
    app.state.store = store
    app.state.service = service
    app.state.evaluation = evaluation
    app.state.registry = registry
    app.state.workbench = workbench
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True,
                       allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])

    @app.middleware('http')
    async def limits(request, call_next):
        if request.method == 'POST':
            origin = request.headers.get('origin')
            if origin and origin not in origins:
                return JSONResponse({'message': '请求来源不受信任。'}, status_code=403)
            try:
                body = await request.body()
            except Exception:
                return JSONResponse({'message': '请求格式异常。'}, status_code=400)
            limit = 2000000 if request.url.path in ('/api/eval/datasets', '/api/prompts/versions', '/api/prompts/import') else 20000
            if len(body) > limit:
                return JSONResponse({'message': '请求过大。'}, status_code=413)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    def owner(request):
        token = request.cookies.get('gouhuo_session', '')
        with login_lock:
            session = sessions.get(token)
            if not session or session['expires'] < time.time():
                sessions.pop(token, None)
                raise PermissionError('请先登录。')
            return session['owner']

    @app.exception_handler(PermissionError)
    async def forbidden(request, exc):
        return JSONResponse({'status': 'error', 'message': str(exc)}, status_code=401)

    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        return JSONResponse({'status': 'error', 'message': '结果格式无效，请重试。' if isinstance(exc, json.JSONDecodeError) else str(exc)}, status_code=400)

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse({'status': 'error', 'message': '请求或模型结果缺少必要字段。'}, status_code=400)

    @app.exception_handler(ModelError)
    async def model_error(request, exc):
        return JSONResponse({'status': 'error', 'message': str(exc)}, status_code=502)

    @app.get('/health')
    def health():
        return {'status': 'ok', 'entries': len(store.entries), 'content_version': store.guide['content_version'],
                'model': service.client.ready(), 'backend': 'python-direct-api', 'agent_runtime': service.runtime_status()}

    @app.post('/api/login')
    def login(data: dict, request: Request):
        ip = request.client.host if request.client else 'unknown'
        with login_lock:
            recent = [t for t in attempts.get(ip, []) if t > time.time() - 60]
            if len(recent) >= 10:
                return JSONResponse({'message': '登录尝试过多，请一分钟后重试。'}, status_code=429)
            attempts[ip] = recent + [time.time()]
            attempts.update({k: v for k, v in list(attempts.items()) if v and v[-1] > time.time()-60})
            user = data.get('username', '')
            password = data.get('password', '')
            p = auth.get(user) if isinstance(user, str) else None
            candidate = hashlib.pbkdf2_hmac('sha256', str(password).encode(), (p or {'salt': 'invalid'})['salt'].encode(), 260000).hex()
            if not p or not secrets.compare_digest(candidate, p['hash']):
                raise PermissionError('账号或密码错误。')
            token = secrets.token_urlsafe(32)
            now = time.time()
            for expired in [k for k, v in sessions.items() if v['expires'] < now]:
                sessions.pop(expired, None)
            sessions[token] = {'owner': user, 'expires': now + 28800}
        response = JSONResponse({'user': {'id': user, 'name': store.profiles[user]['name']}})
        response.set_cookie('gouhuo_session', token, max_age=28800, httponly=True, samesite='strict',
                            secure=os.getenv('COOKIE_SECURE', 'false').lower() == 'true')
        return response

    @app.post('/api/logout')
    def logout(request: Request):
        with login_lock:
            sessions.pop(request.cookies.get('gouhuo_session'), None)
        response = JSONResponse({'ok': True})
        response.delete_cookie('gouhuo_session')
        return response

    @app.get('/api/me')
    def me(request: Request):
        user = owner(request)
        return {'user': {'id': user, 'name': store.profiles[user]['name']}}

    @app.get('/api/memories')
    def memories(request: Request):
        return store.state(owner(request))

    @app.get('/api/runtimes')
    def runtimes(request: Request):
        owner(request)
        return service.runtime_status()

    @app.post('/api/test-sessions')
    def test_session(data: dict, request: Request):
        return workbench.create_session(owner(request), data.get('runtime', service.default_runtime), data.get('memory_enabled', True), data.get('bundle_id'))

    @app.post('/api/test-run')
    def test_run(data: dict, request: Request):
        user = owner(request)
        if not test_locks[user].acquire(blocking=False):
            return JSONResponse({'message': '上一轮测试仍在运行，请稍后重试。'}, status_code=409)
        try:
            return workbench.run(user, data)
        finally:
            test_locks[user].release()

    @app.get('/api/test-runs')
    def test_results(request: Request):
        return {'runs': workbench.results(owner(request))}

    @app.get('/api/test-runs/{run_id}')
    def test_result(run_id: str, request: Request):
        return workbench.result(owner(request), run_id)

    @app.get('/api/prompts')
    def prompt_catalog(request: Request):
        owner(request)
        return registry.catalog()

    @app.get('/api/prompts/versions/{version_id}')
    def prompt_version(version_id: str, request: Request):
        owner(request)
        return registry.version(version_id)

    @app.post('/api/prompts/versions')
    def save_prompt(data: dict, request: Request):
        return registry.save(owner(request), data)

    @app.post('/api/prompts/bundles')
    def save_bundle(data: dict, request: Request):
        return registry.create_bundle(owner(request), data)

    @app.get('/api/prompts/bundles/{bundle_id}')
    def export_bundle(bundle_id: str, request: Request):
        owner(request)
        return registry.snapshot(bundle_id)

    @app.post('/api/prompts/diff')
    def prompt_diff(data: dict, request: Request):
        owner(request)
        return registry.diff(data.get('left'), data.get('right'))

    @app.post('/api/prompts/activate')
    def activate_prompt(data: dict, request: Request):
        user = owner(request)
        if not evaluation.tested_bundle(data.get('bundle_id')):
            raise ValueError('请先用此提示词组合完成至少一个评测用例，再决定是否启用。')
        return registry.activate(user, data)

    @app.post('/api/prompts/import')
    def import_prompts(data: dict, request: Request):
        return registry.import_bundle(owner(request), data)

    @app.get('/api/eval/datasets')
    def eval_datasets(request: Request):
        owner(request)
        return {'datasets': evaluation.datasets(), 'stages': STAGES, 'rule_types': RULES}

    @app.get('/api/eval/datasets/{dataset_id}')
    def eval_dataset(dataset_id: str, request: Request, version: int | None = None):
        owner(request)
        return evaluation.dataset(dataset_id, version)

    @app.post('/api/eval/datasets')
    def save_eval_dataset(data: dict, request: Request):
        return evaluation.save_dataset(owner(request), data)

    @app.post('/api/eval/archive')
    def archive_dataset(data: dict, request: Request):
        owner(request)
        return evaluation.archive(data)

    @app.post('/api/eval/jobs')
    def create_eval_job(data: dict, request: Request):
        return evaluation.create_job(owner(request), data)

    @app.get('/api/eval/jobs')
    def eval_jobs(request: Request):
        return {'jobs': evaluation.jobs(owner(request))}

    @app.get('/api/eval/jobs/{job_id}')
    def eval_job(job_id: str, request: Request):
        return evaluation.job(owner(request), job_id)

    @app.get('/api/eval/jobs/{job_id}/export')
    def export_eval_job(job_id: str, request: Request):
        return evaluation.export(owner(request), job_id)

    @app.post('/api/eval/jobs/{job_id}/cancel')
    def cancel_eval_job(job_id: str, request: Request):
        return evaluation.cancel(owner(request), job_id)

    @app.post('/api/eval/jobs/{job_id}/rerun')
    def rerun_eval_job(job_id: str, data: dict, request: Request):
        return evaluation.rerun(owner(request), job_id, data.get('failed_only', False) is True)

    @app.get('/api/eval/results/{result_id}')
    def eval_result(result_id: str, request: Request):
        return evaluation.result(owner(request), result_id)

    @app.post('/api/eval/results/{result_id}/review')
    def review_eval_result(result_id: str, data: dict, request: Request):
        return evaluation.review(owner(request), result_id, data)

    @app.post('/api/memory-action')
    def change(data: dict, request: Request):
        user = owner(request)
        if data.get('action') not in ('settings', 'correct_summary', 'delete', 'clear', 'feedback'):
            raise ValueError('未知的记忆管理操作。')
        return store.change(user, data['action'], data)

    @app.get('/api/guide-entry')
    def guide(guide_id: str, request: Request):
        owner(request)
        if guide_id not in store.entries:
            raise ValueError('指南条目不存在。')
        return store.entries[guide_id]

    @app.post('/api/run')
    def run(data: dict, request: Request):
        user = owner(request)
        if data.get('mode', 'chat') not in ('chat', 'home'):
            raise ValueError('未知模式。')
        if not locks[user].acquire(blocking=False):
            return JSONResponse({'message': '上一轮仍在处理，请稍后重试。'}, status_code=409)
        try:
            return service.home(user) if data.get('mode') == 'home' else service.chat(user, data)
        finally:
            locks[user].release()

    return app

app = create_app()
