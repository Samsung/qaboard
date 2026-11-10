"""
The environment of `qa batch` that runners forward to the runs they start on other machines.
"""
import os
import re
from typing import Dict, Iterable


# Variables specific to the host or the scheduler job qa runs in, not to the runs
excluded_env = {'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL', 'TMPDIR', 'TMP', 'TEMP', 'CUDA_VISIBLE_DEVICES', '_'}
excluded_env_prefixes = ('LSB_', 'LSF_', 'DASK_')

# When runners store the environment somewhere others can read it (e.g. a Kubernetes ConfigMap), credentials stay out.
# Names containing these...
secrets = ("TOKEN", "ACCESS", "AUTH", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE", "COOKIE", "JWT", "APIKEY")
# ...or with one of these words (OPENAI_API_KEY, DB_PASS...): as substrings they would match too much (KEYBOARD...)
secret_words = {"KEY", "PASS", "PW", "SESSION"}
# and values with credentials in URLs: postgres://user:password@host, https://gitlab-ci-token:xxx@gitlab/...
# A user name alone is no secret (ssh://git@host/..., https://user@host), unless it's long like a token (https://ghp_...@github.com)
credentials_in_url = re.compile(r'://(?:[^/@\s:]*:[^/@\s]*|[A-Za-z0-9_-]{24,})@')

def is_secret(name: str, value: str = '') -> bool:
  upper = name.upper()
  if any(s in upper for s in secrets) or secret_words & set(re.split(r'[^A-Z0-9]+', upper)):
    return True
  return bool(value) and bool(credentials_in_url.search(value))


def forwarded_env(excluded: Iterable[str] = (), excluded_prefixes: Iterable[str] = (), keep_secrets: bool = False) -> Dict[str, str]:
  """qa's environment, minus host-specific variables (and the given ones) and, unless `keep_secrets`, secrets."""
  excluded = excluded_env | set(excluded)
  prefixes = excluded_env_prefixes + tuple(excluded_prefixes)
  return {
    k: v for k, v in os.environ.items()
    if k not in excluded and not k.startswith(prefixes) and (keep_secrets or not is_secret(k, v))
  }
