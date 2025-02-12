import os
import functools
import pickle
import threading

import redis

redis_client = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    db=0,
)

# Thread-local cache
thread_local = threading.local()


def hybrid_cache(ttl=60):
    """Hybrid cache decorator with both local and Redis caching.

    The TTL only affects redis, thread-local cache has no TTL, so make sure workers are killed before the ttl expires to keep freshness garantees.
    """

    def decorator(func):
        local_cache = functools.lru_cache(maxsize=None)(func)

        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # Ensure thread has its own cache instance
            if not hasattr(thread_local, "cache"):
                thread_local.cache = local_cache

            cache_key = f"{func.__name__}:{args}:{kwargs}"
            print(cache_key)

            # 1. Try local (thread) cache
            # We don't have a TTL here since we kill workers after a while
            try:
                return thread_local.cache(*args, **kwargs)
            except RuntimeError:
                pass  # Cache miss

            # 2. Try Redis
            result = redis_client.get(cache_key)
            if result is not None:
                # print("redis hit")
                return pickle.loads(result)
            # print("redis miss")

            # 3. Compute and store in both caches
            result = func(*args, **kwargs)

            thread_local.cache(*args, **kwargs)  # Store in local cache
            redis_client.setex(cache_key, ttl, pickle.dumps(result))  # Store in Redis

            return result

        return wrapper

    return decorator
