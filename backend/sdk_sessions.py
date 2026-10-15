"""Private SDK transcripts with application-controlled, transactional resume markers.

Transcripts are never an API, evaluation artifact or source of durable business facts.
A successful SDK turn becomes resumable only after the business layer commits it.
"""
import hashlib
import json
import os
import secrets
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from backend.errors import ModelError

_LOCK = threading.RLock()


def _digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ModelError('SDK 会话目录异常，请联系维护者。')
    path.chmod(0o700)


def _write_private(path, data):
    temporary = path.with_suffix('.tmp-' + secrets.token_hex(6))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(data, stream, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _session_id(value):
    try:
        return str(UUID(value)) if isinstance(value, str) else None
    except ValueError:
        return None


def _secure_tree(root):
    # Do not follow links written into an unexpected runtime directory.
    for path in (root, *root.rglob('*')):
        if path.is_symlink():
            raise ModelError('SDK 会话文件异常，请重新开始会话。')
        path.chmod(0o700 if path.is_dir() else 0o600)


@dataclass
class SDKSessionLease:
    directory: Path
    conversation_id: str
    history_reset: bool
    binding: str
    token: str
    resume: str | None
    revoked_marker: Path
    session_id: str | None = None
    closed: bool = False

    @property
    def config_directory(self):
        return self.directory / 'config'

    def transcript(self, session_id=None):
        value = _session_id(session_id or self.session_id)
        if not value:
            raise ModelError('SDK 未返回有效会话编号，请重新开始会话。')
        return self.config_directory / 'projects' / 'session' / (value + '.jsonl')

    def ready(self, session_id):
        self.session_id = _session_id(session_id)
        path = self.transcript()
        if not path.is_file() or path.stat().st_size == 0:
            raise ModelError('SDK 会话历史未保存，本轮无法可靠续接，请重试。')
        _secure_tree(self.directory)

    def ensure_active(self):
        with _LOCK:
            if self.revoked_marker.exists():
                raise ModelError('对话已删除或已失效，请新建对话。')
            if self.closed or _read(self.directory / 'pending.json').get('token') != self.token:
                raise ModelError('SDK 会话已失效，请重新开始会话。')

    def commit(self, memory_revision):
        """Called under the store revision lock after all source/memory checks pass."""
        with _LOCK:
            if self.revoked_marker.exists():
                raise ModelError('对话已删除或已失效，请新建对话。')
            if self.closed or _read(self.directory / 'pending.json').get('token') != self.token:
                raise ValueError('SDK 会话已失效，请重新开始会话。')
            self.ready(self.session_id)
            _write_private(self.directory / 'committed.json', {
                'binding': self.binding, 'memory_revision': memory_revision,
                'session_id': self.session_id, 'updated': time.time(), 'lease_token': self.token,
            })
            (self.directory / 'pending.json').unlink(missing_ok=True)
            self.closed = True

    def discard(self):
        """Failed, interrupted or unvalidated turns must never be resumed."""
        with _LOCK:
            if self.closed:
                return
            pending_token = _read(self.directory / 'pending.json').get('token')
            # An invalidated live CLI can recreate its private transcript after
            # invalidate() removed the marker. Clean that orphan as well; only a
            # different active lease's marker prevents removal.
            committed_token = _read(self.directory / 'committed.json').get('lease_token')
            owned_or_orphaned = (pending_token == self.token or
                                 (pending_token is None and committed_token in (None, self.token)))
            if self.revoked_marker.exists() or owned_or_orphaned:
                shutil.rmtree(self.directory, ignore_errors=True)
            self.closed = True


class SDKSessionStore:
    def __init__(self, directory):
        self.owner_directory = Path(directory)
        self.root = self.owner_directory / 'sdk-sessions'
        self.revoked_root = self.owner_directory / 'sdk-revoked'

    def begin(self, owner, conversation_id, memory_revision, binding):
        if not isinstance(owner, str) or not owner or not isinstance(conversation_id, str) or not conversation_id:
            raise ValueError('SDK 会话需要有效用户和会话编号。')
        try:
            ttl = int(os.getenv('AGENT_SDK_SESSION_TTL_SECONDS', '604800'))
            maximum = int(os.getenv('AGENT_SDK_MAX_SESSIONS', '30'))
            if not 1 <= ttl <= 31536000 or not 1 <= maximum <= 1000:
                raise ValueError()
        except ValueError:
            raise ModelError('SDK 会话保留时间应为 1—31536000 秒，会话数量应为 1—1000。') from None

        def fingerprint(cid):
            return _digest(json.dumps({'owner': _digest(owner), 'conversation': _digest(cid),
                                      'context': binding}, sort_keys=True, ensure_ascii=False))

        key = _digest(owner + '\0' + conversation_id)
        directory = self.root / key
        revoked_marker = self.revoked_root / (key + '.json')
        now = time.time()
        with _LOCK:
            _private_directory(self.owner_directory)
            if revoked_marker.exists():
                raise ModelError('对话已删除或已失效，请新建对话。')
            _private_directory(self.root)
            saved = _read(directory / 'committed.json')
            resume = _session_id(saved.get('session_id'))
            transcript = directory / 'config' / 'projects' / 'session' / ((resume or '') + '.jsonl')
            updated = saved.get('updated', 0)
            expires_at = binding.get('expires_at')
            not_expired = expires_at is None or (isinstance(expires_at, (int, float)) and expires_at > now)
            valid = (not_expired and saved.get('binding') == fingerprint(conversation_id)
                     and saved.get('memory_revision') == memory_revision
                     and isinstance(updated, (int, float)) and updated > now - ttl
                     and resume and transcript.is_file() and transcript.stat().st_size > 0
                     and not (directory / 'pending.json').exists())
            if not valid:
                shutil.rmtree(directory, ignore_errors=True)
                resume = None
                # The application ID stays stable and can be revoked even before
                # the first turn starts. Only the native SDK history is reset.
            candidates = []
            for child in self.root.iterdir():
                if child == directory or not child.is_dir():
                    continue
                record = _read(child / 'committed.json')
                timestamp = record.get('updated', child.stat().st_mtime)
                if not isinstance(timestamp, (int, float)) or timestamp <= now - ttl:
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    candidates.append((timestamp, child))
            for _, child in sorted(candidates, key=lambda item: item[0])[:max(0, len(candidates) - maximum + 1)]:
                shutil.rmtree(child, ignore_errors=True)
            _private_directory(directory)
            _private_directory(directory / 'config')
            # A process crash leaves an unresumable turn, not dirty history.
            (directory / 'committed.json').unlink(missing_ok=True)
            token = secrets.token_hex(24)
            _write_private(directory / 'pending.json', {'token': token})
            return SDKSessionLease(directory, conversation_id, not bool(resume),
                                   fingerprint(conversation_id), token, resume, revoked_marker)

    def delete(self, owner, conversation_id):
        """Revoke one application conversation before removing its SDK history.

        The marker is outside sdk-sessions so ordinary context invalidation cannot
        undo deletion. It contains a timestamp only and is retained across restart.
        """
        if not isinstance(owner, str) or not owner or not isinstance(conversation_id, str) or not conversation_id:
            raise ValueError('删除 SDK 会话需要有效用户和会话编号。')
        key = _digest(owner + '\0' + conversation_id)
        directory = self.root / key
        with _LOCK:
            _private_directory(self.owner_directory)
            _private_directory(self.revoked_root)
            _write_private(self.revoked_root / (key + '.json'), {'revoked_at': time.time()})
            shutil.rmtree(directory, ignore_errors=True)

    def invalidate(self):
        """Drop all SDK history for this owner; SQLite business state is untouched."""
        with _LOCK:
            shutil.rmtree(self.root, ignore_errors=True)
