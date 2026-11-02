"""
The environment of `qa batch` that runners forward to the runs they start on other machines.
"""
import os
from typing import Dict, Iterable


# Variables specific to the host or the scheduler job qa runs in, not to the runs
excluded_env = {'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL', 'TMPDIR', 'TMP', 'TEMP', 'CUDA_VISIBLE_DEVICES', '_'}
excluded_env_prefixes = ('LSB_', 'LSF_', 'DASK_')

# Like the celery runner: when runners store the environment somewhere others can read it, credentials stay out
secrets = ("TOKEN", "ACCESS", "AUTH", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL")
def is_secret(name: str) -> bool:
  return any(s in name.upper() for s in secrets)


def forwarded_env(excluded: Iterable[str] = (), excluded_prefixes: Iterable[str] = ()) -> Dict[str, str]:
  """qa's environment, minus host-specific variables (and the given ones) and secrets."""
  excluded = excluded_env | set(excluded)
  prefixes = excluded_env_prefixes + tuple(excluded_prefixes)
  return {
    k: v for k, v in os.environ.items()
    if k not in excluded and not k.startswith(prefixes) and not is_secret(k)
  }
