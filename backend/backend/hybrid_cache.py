import os
import functools
import time
import pickle
import threading
from collections import OrderedDict

import redis

redis_client = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    db=0,
    # Don't block requests for long if redis is unreachable
    socket_connect_timeout=2,
    socket_timeout=2,
)

# Thread-local cache
thread_local = threading.local()


class LocalCache:
    """A small LRU cache whose entries expire after `ttl` seconds"""
    def __init__(self, ttl, maxsize):
        self.ttl, self.maxsize = ttl, maxsize
        self.entries = OrderedDict()  # key => (expires_at, value)

    def get(self, key):
        """(True, value) if the key is cached and fresh, else (False, None)"""
        entry = self.entries.get(key)
        if entry is None:
            return False, None
        expires_at, value = entry
        if expires_at <= time.monotonic():
            del self.entries[key]
            return False, None
        self.entries.move_to_end(key)
        return True, value

    def set(self, key, value):
        self.entries[key] = (time.monotonic() + self.ttl, value)
        self.entries.move_to_end(key)
        while len(self.entries) > self.maxsize:
            self.entries.popitem(last=False)


def hybrid_cache(ttl=60, maxsize=128):
    """Hybrid cache: thread-local (fast, at most `maxsize` entries per function and thread) + Redis (shared).
    Both keep results for `ttl` seconds."""

    def decorator(func):
        name = f"{func.__module__}.{func.__qualname__}"

        def local_cache():
            # Ensure thread has its own cache instance
            caches = getattr(thread_local, "caches", None)
            if caches is None:
                caches = thread_local.caches = {}
            if name not in caches:
                caches[name] = LocalCache(ttl, maxsize)
            return caches[name]

        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            cache = local_cache()
            cache_key = f"{name}:{args}:{kwargs}"

            # 1️⃣ Check thread-local cache
            found, result = cache.get(cache_key)
            if found:
                return result

            # 2️⃣ Check Redis cache
            # Redis is only a cache: if it's down we compute the result instead of failing the request
            try:
                result = redis_client.get(cache_key)
            except redis.RedisError:
                result = None
            if result is not None:
                try:
                    result = pickle.loads(result)
                    # what's left of its TTL in redis would be better, it's another round-trip
                    cache.set(cache_key, result)
                    return result
                except Exception:
                    pass

            # 3️⃣ Compute result and store in both caches
            result = func(*args, **kwargs)

            cache.set(cache_key, result)
            try:
                redis_client.setex(cache_key, ttl, pickle.dumps(result))  # Store in Redis
            except redis.RedisError:
                pass

            return result

        return wrapper

    return decorator
