"""
Small utility tools.
"""
import os
import yaml
import datetime
import requests
from pathlib import Path

from .config import default_recordings_directory


# Until we get a proper database, we need to cache things a bit
def cache(minutes=1440, func_skip_cache=None):
  """Cache function decorator with
  - minutes: time-to-live until the cache is expired. (default: 1day)
  - func_skip_cache: called on args[0], decides if we should skip the cache.
  """
  def cache_ttl_decorator(f):
    _cache = {}
    _last_accesses = {}
    def func_wrapper(*args, **kwargs):
      missing = args[0] not in _cache
      now = datetime.datetime.now()
      expired = missing or now - _last_accesses[args[0]] > datetime.timedelta(minutes=minutes)
      skipped = (func_skip_cache is not None) and func_skip_cache(args[0])
      if skipped or missing or expired:
        _last_accesses[args[0]] = now
        _cache[args[0]] = f(*args, **kwargs)
      return _cache[args[0]]
    return func_wrapper
  return cache_ttl_decorator


@cache(minutes=60)
def get_users_per_name(search_filter):
  """Retrievies users from Gitlab"""
  headers = {'Private-Token': os.environ['GITLAB_ACCESS_TOKEN']}
  gitlab_api = "http://gitlab-srv/api/v4"
  users_db = {} # tries to matche a name/fullname/firstname/id to a gitlab user

  # gitlab paginates each 100 users
  page = 1
  users_on_page = {}
  while page==1 or users_on_page:
    r = requests.get(f'{gitlab_api}/users/?{search_filter}',
                     headers=headers,
                     params={'per_page':1000, 'page': page},
                     proxies={}
                    )
    users_on_page = r.json()
    # sadly we don't have access to email adresses since we are not gitlab admins
    # and git authors are identified by emails...
    for u in users_on_page:
      users_db[u['name']] = u
      users_db[u['username']] = u
      try:
        first_name, family_name = u['name'].lower().split(' ')
        user_id = first_name[0] + family_name[:5]
        users_db[user_id] = u
        users_db[f'{first_name}.{family_name}'] = u
        if first_name not in users_db:
          users_db[first_name] = u
        else:
          pass
          # print(f'warning: {u}')
      except:
        pass
    page = page + 1
  return users_db


# copy-pasted from psp_swip/tools/performance-evaluation/utils.py
# database_directory->default_recordings_directory
# we should create a python package...
def iter_recordings(recording_groups, recording_groups_file):
  """Returns an iterator over the recordings from the selected groups
  params:
  - recording_groups: array of group labels
  - recording_groups_file: yaml file
  """
  available_batches = yaml.load(Path(recording_groups_file).open())
  try:
    for group in recording_groups:
      locations = available_batches[group]
      if not locations:
        print("Warning: the selected batch is empty")
        continue
      for location in locations:
        yield from (default_recordings_directory/location).rglob('*.bin')
        if location.endswith('.bin') and (default_recordings_directory/location).is_file():
          yield Path(default_recordings_directory/location)
  except:
    return []
