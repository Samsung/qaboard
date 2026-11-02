"""
What we know about commit authors, learned from push webhooks (and from the CLI), to show their avatars.
Lists of commits need an avatar for each commit, so lookups are in memory. The data is shared via redis:
each worker reloads it every few minutes. If redis is down, workers only know what they learned themselves.
"""
import json
import time

import redis

from ..hybrid_cache import redis_client
from .base import is_email


REDIS_KEY = 'qaboard:git:committers'
RELOAD_EVERY = 5 * 60 # seconds

# name.lower() => {email, username, avatar_url, host}
_committers = {}
_loaded_at = -float('inf')


def _key(name):
  return name.strip().lower()


def _clean(committer, host_url):
  info = {
    "email": committer.get('email') if is_email(committer.get('email')) else None,
    "username": committer.get('username'),
    "avatar_url": committer.get('avatar_url'),
  }
  info = {k: v for k, v in info.items() if isinstance(v, str) and v}
  if info.get('username') and host_url:
    info['host'] = host_url
  return info


def remember(committers, host_url=None, overwrite=True):
  """
  committers: [{name, email, username, avatar_url}]
  overwrite: if False, we only fill what we didn't know (for unauthenticated sources)
  """
  learned = {}
  for committer in committers:
    name = committer.get('name')
    info = _clean(committer, host_url) if isinstance(name, str) and name.strip() else None
    if info:
      learned.setdefault(_key(name), {}).update(info)
  if not learned:
    return
  keys = list(learned)
  try:
    stored = redis_client.hmget(REDIS_KEY, keys)
  except redis.RedisError:
    stored = [None] * len(keys)
  updates = {}
  for key, stored_info in zip(keys, stored):
    known = {**_committers.get(key, {}), **(json.loads(stored_info) if stored_info else {})}
    merged = {**known, **learned[key]} if overwrite else {**learned[key], **known}
    _committers[key] = merged
    if merged != known:
      updates[key] = json.dumps(merged)
  if updates:
    try:
      redis_client.hset(REDIS_KEY, mapping=updates)
    except redis.RedisError as e:
      print(f"WARNING: could not save committers in redis: {e}")


def lookup(name):
  global _loaded_at
  if not name:
    return None
  if time.monotonic() - _loaded_at > RELOAD_EVERY:
    _loaded_at = time.monotonic()
    try:
      stored = redis_client.hgetall(REDIS_KEY)
    except redis.RedisError:
      stored = {}
    for key, info in stored.items():
      try:
        _committers[key.decode()] = json.loads(info)
      except ValueError:
        pass
  return _committers.get(_key(name))
