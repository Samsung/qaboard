import os
from pathlib import Path

qaboard_url = os.getenv('QABOARD_URL', 'http://qaboard')

# Deprecated: git hosts are configured in git_hosts/__init__.py, use `git_hosts.default.url`
git_server = os.getenv('GITLAB_HOST', 'https://gitlab.com')

# Where we save "non-metadata" qaboard data
qaboard_data_dir = Path(os.getenv('QABOARD_DATA_DIR', '/var/qaboard')).resolve()
qaboard_data_dir.mkdir(exist_ok=True, parents=True)

# Where we save custom per-project groups (currently used only for extra-runs and tuning in api/tuning.py)
qaboard_data_shared_dir = Path(os.environ.get("QABOARD_DATA_SHARED_DIR", qaboard_data_dir / 'shared'))
# Where we clone git repositories
qaboard_data_git_dir = Path(os.environ.get("QABOARD_DATA_GIT_DIR", qaboard_data_dir / 'git'))

default_storage_root = Path('/mnt/qaboard')
default_outputs_root = default_storage_root
default_artifacts_root = default_storage_root

# Clients tell us where they saved their results, but the server only writes, deletes or runs code inside these
# folders (see backend/storage.py). Separated by ":" like $PATH.
storage_roots = [Path(p) for p in os.environ.get('QABOARD_STORAGE_ROOTS', str(default_storage_root)).split(':') if p]

# Runs without a storage shared with the server send it their files over HTTP (`storage: upload` in qaboard.yaml):
# it saves them in this folder, see backend/uploads.py. "off": the server doesn't accept files.
# Not set: on a server with the default storage (no QABOARD_STORAGE_ROOTS), in it, when the server can write there
# (docker-compose.yml mounts a volume there), so that a new server takes what a new project sends. Sites that chose
# their storage roots choose where uploads go.
# It is one of the storage roots: nginx and the image server must read it at the same path, like the others.
def _upload_root(environ=os.environ):
  """(the upload root or None, why there is none)"""
  value = (environ.get('QABOARD_UPLOAD_ROOT') or '').strip()
  if value.lower() in ('off', 'false', 'no', '0', 'none'):
    return None, "QABOARD_UPLOAD_ROOT is off"
  if value:
    return Path(value), None
  if (environ.get('QABOARD_STORAGE_ROOTS') or '').strip():
    return None, "QABOARD_UPLOAD_ROOT isn't set"
  if default_storage_root.is_dir() and os.access(default_storage_root, os.W_OK | os.X_OK):
    return default_storage_root, None
  return None, f"QABOARD_UPLOAD_ROOT isn't set, and the server can't write in the default storage, {default_storage_root}"

upload_root, upload_off_reason = _upload_root()
if upload_root is not None and not any(upload_root.is_relative_to(root) for root in storage_roots):
  storage_roots.append(upload_root)
# The largest file runs can send, in MB. The proxy has its own limit (client_max_body_size, services/nginx/conf.d/qaboard.conf)
upload_max_file_size = int(float(os.environ.get('QABOARD_UPLOAD_MAX_FILE_MB') or 1024) * 1024 * 1024)
# Uploads are refused when the upload folder's disk has less free space than this, in GB
upload_min_free_space = int(float(os.environ.get('QABOARD_UPLOAD_MIN_FREE_GB') or 1) * 1024 ** 3)

# Runs that say they send heartbeats (data.heartbeat, from recent `qa` and qaboard.start_run()) and stay silent this
# long are marked failed, e.g. when their machine was killed (backend/heartbeats.py). 0: never.
silent_run_timeout_minutes = float(os.environ.get('QABOARD_SILENT_RUN_TIMEOUT_MINUTES') or 15)

# Commit lists don't aggregate the metrics of some projects' batches: the metrics.skip_aggregation setting (backend/settings.py)

# In these folders (e.g. /home), users only read the files under /s/ that their Unix account can read. Separated by ":".
# See backend/api/files.py, nginx must check permissions with services/nginx/snippets/qaboard-files-auth.conf
files_unix_permissions_roots = [p for p in os.environ.get('QABOARD_FILES_UNIX_PERMISSIONS', '').split(':') if p]
