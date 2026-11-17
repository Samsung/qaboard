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
# it saves them in this folder, see backend/uploads.py. Not set: the server doesn't accept files.
# It is one of the storage roots: nginx and the image server must read it at the same path, like the others.
upload_root = Path(os.environ['QABOARD_UPLOAD_ROOT']) if os.environ.get('QABOARD_UPLOAD_ROOT') else None
if upload_root is not None and not any(upload_root.is_relative_to(root) for root in storage_roots):
  storage_roots.append(upload_root)
# The largest file runs can send, in MB. The proxy has its own limit (client_max_body_size, services/nginx/conf.d/qaboard.conf)
upload_max_file_size = int(float(os.environ.get('QABOARD_UPLOAD_MAX_FILE_MB') or 1024) * 1024 * 1024)
# Uploads are refused when the upload folder's disk has less free space than this, in GB
upload_min_free_space = int(float(os.environ.get('QABOARD_UPLOAD_MIN_FREE_GB') or 1) * 1024 ** 3)

# Commit lists don't aggregate the metrics of some projects' batches: the metrics.skip_aggregation setting (backend/settings.py)

# In these folders (e.g. /home), users only read the files under /s/ that their Unix account can read. Separated by ":".
# See backend/api/files.py, nginx must check permissions with services/nginx/snippets/qaboard-files-auth.conf
files_unix_permissions_roots = [p for p in os.environ.get('QABOARD_FILES_UNIX_PERMISSIONS', '').split(':') if p]
