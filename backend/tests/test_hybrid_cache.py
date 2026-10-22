"""backend/hybrid_cache.py: a thread-local cache in front of redis"""
import pytest

from backend import hybrid_cache as module


class FakeRedis:
  def __init__(self):
    self.values = {}
  def get(self, key):
    return self.values.get(key)
  def setex(self, key, ttl, value):
    self.values[key] = value


@pytest.fixture
def redis(monkeypatch):
  fake = FakeRedis()
  monkeypatch.setattr(module, 'redis_client', fake)
  monkeypatch.setattr(module, 'thread_local', type(module.thread_local)())
  return fake


@pytest.fixture
def clock(monkeypatch):
  now = [1000.0]
  monkeypatch.setattr(module.time, 'monotonic', lambda: now[0])
  return now


def counted(ttl=60, maxsize=128, name='compute', module_name=__name__):
  calls = []
  def compute(x):
    calls.append(x)
    return x * 2
  compute.__name__ = compute.__qualname__ = name
  compute.__module__ = module_name
  return module.hybrid_cache(ttl=ttl, maxsize=maxsize)(compute), calls


def test_results_are_cached(redis, clock):
  compute, calls = counted()
  assert compute(1) == compute(1) == 2
  assert calls == [1]


def test_local_results_expire(redis, clock):
  compute, calls = counted(ttl=10)
  compute(1)
  clock[0] += 11
  redis.values.clear()  # redis expired it too
  compute(1)
  assert calls == [1, 1]


def test_local_cache_is_bounded(redis, clock):
  compute, calls = counted(maxsize=2)
  for x in range(5):
    compute(x)
  cache, = module.thread_local.caches.values()
  assert len(cache.entries) == 2


def test_functions_with_the_same_name_dont_share_results(redis, clock):
  first, _ = counted(name='users', module_name='backend.git_hosts.gitlab')
  second, calls = counted(name='users', module_name='backend.git_hosts.gitea')
  first(1)
  second(1)
  assert calls == [1]
