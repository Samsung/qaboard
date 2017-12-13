"""
Small utility tools.
"""
import os
import datetime
import requests


# until we get a proper database, we cache things a bit
# to understand the code, there is no need to read the following
# it should be replaced by a proper database :) 
def cache(minutes=1440, func_skip_cache=None):
    """Cache decorator with
    - minutes: time-to-live until the cache is expired. (default: 1day)
    - func_skip_cache: called on args[0], decides if we should skip the cache.
    """
    def cache_ttl_decorator(f):
        _cache = {}
        _last_accesses = {}
        def func_wrapper(*args, **kwargs):
            missing = args[0] not in _cache
            now = datetime.datetime.now()
            expired = missing or now-_last_accesses[args[0]]>datetime.timedelta(minutes=minutes)
            skipped = (func_skip_cache is not None) and func_skip_cache(args[0])
            if skipped or missing or expired:
                _last_accesses[args[0]] = now
                _cache[args[0]] = f(*args, **kwargs)
            return _cache[args[0]]
        return func_wrapper
    return cache_ttl_decorator




def is_new(commit, hours=1):
    return datetime.datetime.now().astimezone()-commit.authored_datetime < datetime.timedelta(hours=hours)



@cache(minutes=60)
def get_users_per_name(search_filter):
    headers = {'Private-Token': os.environ['GITLAB_ACCESS_TOKEN']}
    gitlab_api = "http://gitlab-srv/api/v4"
    r = requests.get(f'{gitlab_api}/users/?{search_filter}', headers=headers, params={'per_page':1000})
    users = r.json()
    # we try to match via anything...
    users_db = {}
    for u in users:
        users_db[u['name']] = u
        users_db[u['username']] = u
        # print(u['name'])
        try:
            first_name, family_name = u['name'].lower().split(' ')
            user_id = first_name[0] + family_name[:5]
            # print("user_id: "+user_id)
            users_db[user_id] = u
            if first_name not in users_db:
                users_db[first_name] = u
            else:
                print(f'warning: {u}')
        except:
            pass
    return users_db 






