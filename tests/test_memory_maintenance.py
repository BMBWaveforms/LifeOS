import json
import threading
from types import SimpleNamespace

from backend.memory_maintenance import MemoryMaintenance


class Topics:
    def __init__(self):
        self.committed, self.failed = [], []

    def prepare(self, owner, topic_id):
        return {'owner': owner, 'topic_id': topic_id, 'sources': [
            {'id': 'source-1', 'query': '当前租房预算五千元'}]}

    def commit(self, job, raw, version):
        self.committed.append((job, json.loads(raw), version))

    def fail(self, job):
        self.failed.append(job)

    def is_current(self, job):
        return True

    def abandon(self, job):
        pass


def test_maintenance_does_not_wait_for_model_and_coalesces_topic(monkeypatch):
    monkeypatch.setenv('MEMORY_CONSOLIDATION_ENABLED', 'true')
    topics = Topics()
    started, release = threading.Event(), threading.Event()

    class Client:
        def complete(self, messages, **kwargs):
            assert kwargs['timeout'] == 45
            assert set(json.loads(messages[1]['content'])) == {'sources', 'partial'}
            assert '只能包含一个 source_id' in messages[0]['content']
            started.set()
            assert release.wait(3)
            return {'content': '{"items":[{"source_id":"source-1","quote":"预算五千元"}]}'}

    maintenance = MemoryMaintenance(SimpleNamespace(topic_memory=topics), Client())
    try:
        assert maintenance.schedule('alice', 'topic-1')
        assert started.wait(1)
        assert not maintenance.schedule('alice', 'topic-1')
        assert not topics.committed
        release.set()
        assert maintenance.wait_idle(3)
        assert len(topics.committed) == 1 and not topics.failed
        assert len(topics.committed[0][2]) == 64
    finally:
        release.set()
        maintenance.close()


def test_maintenance_queue_is_bounded_and_failures_are_not_exposed(monkeypatch):
    monkeypatch.setenv('MEMORY_CONSOLIDATION_ENABLED', 'true')
    topics = Topics()
    release = threading.Event()

    class Client:
        def complete(self, *args, **kwargs):
            assert release.wait(3)
            raise RuntimeError('synthetic-private-provider-output')

    maintenance = MemoryMaintenance(SimpleNamespace(topic_memory=topics), Client())
    try:
        for index in range(32):
            assert maintenance.schedule('alice', f'topic-{index}')
        assert not maintenance.schedule('alice', 'overflow')
        release.set()
        assert maintenance.wait_idle(5)
        assert len(topics.failed) == 32 and not topics.committed
        assert 'synthetic-private' not in json.dumps(topics.failed)
    finally:
        release.set()
        maintenance.close()


def test_maintenance_can_be_disabled_without_preparing_or_calling_model(monkeypatch):
    monkeypatch.setenv('MEMORY_CONSOLIDATION_ENABLED', 'false')
    topics = Topics()
    maintenance = MemoryMaintenance(SimpleNamespace(topic_memory=topics), None)
    assert not maintenance.schedule('alice', 'topic-1')
    assert maintenance._pool is None
    assert not topics.committed and not topics.failed


def test_queued_sources_are_not_sent_after_memory_is_disabled_and_cleared(tmp_path, monkeypatch):
    from backend.store import Store
    monkeypatch.setenv('MEMORY_CONSOLIDATION_ENABLED', 'true')
    monkeypatch.setenv('MEMORY_CONSOLIDATE_SOURCES', '1')
    store = Store(tmp_path)
    store.change('alice', 'settings', {'enabled': True})
    store.change('alice', 'save', {'confirmed': True, 'text': '第一个主题的合成来源'})
    store.change('alice', 'save', {'confirmed': True, 'text': '第二个主题的合成私人编号4422'})
    topics = store.state('alice')['topics']
    first = next(t for t in topics if '第一个' in t['sources'][0]['query'])
    second = next(t for t in topics if '4422' in t['sources'][0]['query'])
    started, release = threading.Event(), threading.Event()
    sent = []

    class Client:
        def complete(self, messages, **kwargs):
            payload = json.loads(messages[-1]['content'])
            sent.append(payload)
            started.set()
            assert release.wait(3)
            source = payload['sources'][0]
            return {'content': json.dumps({'items': [{'source_id': source['source_id'], 'quote': source['text']}]})}

    maintenance = MemoryMaintenance(store, Client())
    try:
        assert maintenance.schedule('alice', first['id'])
        assert started.wait(1)
        assert maintenance.schedule('alice', second['id'])
        store.change('alice', 'settings', {'enabled': False})
        store.change('alice', 'clear', {})
        release.set()
        assert maintenance.wait_idle(3)
        assert len(sent) == 1
        assert '4422' not in json.dumps(sent, ensure_ascii=False)
        assert store.state('alice')['topics'] == []
    finally:
        release.set()
        maintenance.close()
