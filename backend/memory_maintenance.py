"""Bounded, best-effort topic consolidation outside the reply critical path."""
import hashlib
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path


PROMPT = Path(__file__).resolve().parents[1] / 'prompts' / 'memory-consolidation.md'


class MemoryMaintenance:
    def __init__(self, store, client):
        self.store, self.client = store, client
        self._lock = threading.Lock()
        self._pending = set()
        self._futures = set()
        self._pool = None

    def schedule(self, owner, topic_id=None):
        if os.getenv('MEMORY_CONSOLIDATION_ENABLED', 'true').lower() != 'true':
            return False
        key = (owner, topic_id)
        with self._lock:
            # One worker and a bounded queue; repeated turns coalesce per topic.
            if key in self._pending or len(self._pending) >= 32:
                return False
            self._pending.add(key)
        try:
            job = self.store.topic_memory.prepare(owner, topic_id)
            if not job:
                with self._lock:
                    self._pending.discard(key)
                return False
            with self._lock:
                if self._pool is None:
                    self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='memory-topics')
                future = self._pool.submit(self._process, key, job)
                self._futures.add(future)
            future.add_done_callback(self._forget)
            return True
        except Exception:
            # Maintenance cannot turn an already validated reply into an error.
            with self._lock:
                self._pending.discard(key)
            return False

    def _forget(self, future):
        with self._lock:
            self._futures.discard(future)

    def _process(self, key, job):
        try:
            # Queued snapshots may have been deleted or disabled while another
            # topic was running. Check before disclosure as well as at commit.
            if not self.store.topic_memory.is_current(job):
                self.store.topic_memory.abandon(job)
                return
            instruction = PROMPT.read_text()
            version = hashlib.sha256(instruction.encode()).hexdigest()
            # complete() is the existing tool-free SDK transport; no chat resume.
            message = self.client.complete([
                {'role': 'system', 'content': instruction},
                {'role': 'user', 'content': json.dumps({
                    'sources': job['sources'], 'partial': job.get('partial', False),
                }, ensure_ascii=False)},
            ], timeout=45)
            self.store.topic_memory.commit(job, message.get('content') or '', version)
        except Exception:
            # Never persist provider exceptions, credentials or private traces.
            self.store.topic_memory.fail(job)
        finally:
            with self._lock:
                self._pending.discard(key)

    def wait_idle(self, timeout=60):
        """Bounded drain for isolated verification and graceful shutdown."""
        with self._lock:
            futures = tuple(self._futures)
        return not wait(futures, timeout=timeout).not_done

    def close(self):
        with self._lock:
            pool = self._pool
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
