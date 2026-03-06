"""
Small utility tools.
"""
import os
import yaml
import datetime
import requests
from hashlib import md5
from pathlib import Path
from functools import cache
from urllib.parse import urlparse

from .hybrid_cache import hybrid_cache


@hybrid_cache(ttl=12*60*60) # 12h
def get_users_per_name(search_filter):
  """Retrievies users from Gitlab"""
  if 'GITLAB_ACCESS_TOKEN' not in os.environ:
    return {}

  headers = {'Private-Token': os.environ['GITLAB_ACCESS_TOKEN']}
  gitlab_api = "http://gitlab-srv.transchip.com/api/v4"
  users_db = {} # tries to matche a name/fullname/firstname/id to a gitlab user

  # gitlab paginates each 100 users
  page = 1
  users_on_page = {}
  while page==1 or users_on_page:
    url = f'{gitlab_api}/users/?{search_filter}'
    print(f"GET {url}", page)
    r = requests.get(
      url,
      headers=headers,
      params={'per_page':1000, 'page': page},
      proxies={}
    )
    users_on_page = r.json()
    print(f"{len(users_on_page)} users")
    for u in users_on_page:
      # need gitlab admin rights
      if 'email' in u:
        users_db[u['email']] = u
        email_base = u['email'].split('@')[0]
        users_db[email_base] = u
        users_db[email_base.lower()] = u
        users_db[email_base.lower().replace('.', '')] = u
      if 'username' in u:
        users_db['username'] = u
      users_db[u['name'].lower()] = u
      users_db[u['username'].lower()] = u
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





def gravatar_url(name):
  name_hash = md5(name.encode('utf8')).hexdigest()
  return f'http://gravatar.com/avatar/{name_hash}'


@cache
def get_avatar_url(name):
  users_per_name = get_users_per_name("")
  if not users_per_name or not name:
    return ''

  name = name.lower()

  # try to get info from gitlab (TODO: it's really ugly)
  user = None
  if name in users_per_name:
    user = users_per_name[name]
  elif name.replace('.', '') in users_per_name:
    user = users_per_name[name.replace('.', '')]
  elif name.replace(' ', '') in users_per_name:
    user = users_per_name[name.replace(' ', '')]
  elif name.replace(' ', '.') in users_per_name:
    user = users_per_name[name.replace(' ', '.')]

  if user:
    if "gravatar" in user['avatar_url'] and 'username' in user:
      # only SIRC users have avatars...
      identities = user.get('identities', [])
      if all(['ou=guests' not in i['extern_uid'] for i in identities]):
        return f"https://dag.sirc.co.il:8081/{user['username']}.jpg"
    return user['avatar_url']
  else:
    return gravatar_url(name)

def detect_hosting_type(url):
  """Detect whether a URL points to a GitHub or GitLab instance."""
  if not url:
    return "gitlab"  # backward compat default
  parsed = urlparse(url)
  hostname = parsed.hostname or ''
  if "github" in hostname:
    return "github"
  return "gitlab"


def _github_api_base(web_url):
  """Derive the GitHub API base URL from a repository web URL."""
  parsed = urlparse(web_url)
  if parsed.hostname == 'github.com':
    return 'https://api.github.com'
  # GitHub Enterprise: https://github.example.com/api/v3
  return f'{parsed.scheme}://{parsed.hostname}/api/v3'


@hybrid_cache(ttl=12*60*60) # 12h
def get_github_avatar_url(name, web_url=''):
  """Retrieve avatar URL for a user from GitHub API."""
  github_token = os.environ.get('GITHUB_ACCESS_TOKEN', '')
  api_base = _github_api_base(web_url) if web_url else 'https://api.github.com'

  headers = {}
  if github_token:
    headers['Authorization'] = f'Bearer {github_token}'

  # Try searching by name
  try:
    r = requests.get(
      f'{api_base}/search/users',
      params={'q': f'{name} in:name'},
      headers=headers,
      timeout=5,
      proxies={},
    )
    if r.ok:
      items = r.json().get('items', [])
      if items:
        return items[0].get('avatar_url', '')
  except Exception as e:
    print(f'[WARNING] GitHub avatar lookup failed for {name}: {e}')

  # Fall back to gravatar
  return gravatar_url(name)


# Wrapp function calls in profiled(my_call()) to profile code
import cProfile, pstats, io
import contextlib
import sys

@contextlib.contextmanager
def profiled():
    pr = cProfile.Profile()
    pr.enable()
    yield
    pr.disable()
    s = io.StringIO()
    ps = pstats.Stats(pr, stream=s).sort_stats('cumulative') # cumulative  tottime
    ps.print_stats(35)
    ps.print_callers(35)
    print(s.getvalue(), file=sys.stderr)
