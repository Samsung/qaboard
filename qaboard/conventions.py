"""
The conventions about where QA-Board stores results.
"""
import os
import re
import json
import hashlib
from pathlib import Path
from typing import List, Dict, Union, Optional

import yaml
import click

from .git import git_show



def location_from_spec(spec: Union[str, Dict, os.PathLike], interpolation_vars: Optional[Dict] = None) -> Path:
  if isinstance(spec, dict):
    # Mounts are often called differently on linux and windows
    mount_flavor = 'windows' if os.name == 'nt' else 'linux'
    try:
      location = spec[mount_flavor] if mount_flavor in spec else spec["path"]
    except Exception:
      raise ValueError(f"Expected a key named {mount_flavor} or path in {spec}.")
  else:
    location = spec
  location = os.path.expandvars(location)
  if interpolation_vars:
    location = location.format(**interpolation_vars)
  return Path(location)


# `qa run` says where the run it is doing is saved, to the code it runs and what that code starts: qaboard.start_run()
# must not start that run again (qaboard/active_run.py)
RUN_DIR_VARIABLE = 'QABOARD_RUN_DIR'

# The token QA-Board gives the runs of a batch it starts (tokens.mint_for_batch in backend/backend/tokens.py): runners forward it to the
# machines and pods that run them, unlike other secrets (qaboard/runners/env.py)
BATCH_TOKEN_PREFIX = 'qab_bat_'

# `storage: upload` (or QA_STORAGE=upload): results are sent to the server over HTTP, see qaboard/upload.py
UPLOAD_STORAGE = 'upload'

def is_upload_storage(storage) -> bool:
  """Whether storage settings (`storage` in qaboard.yaml, $QA_STORAGE) say to send results to the server, not to save them in a folder it reads"""
  return isinstance(storage, str) and storage.strip().lower() == UPLOAD_STORAGE


def ci_project() -> Optional[str]:
  """The project of runs created without a qaboard.yaml, from the environment: QA_PROJECT, else the CI's repository"""
  return os.environ.get('QA_PROJECT') or os.environ.get('GITHUB_REPOSITORY') or os.environ.get('CI_PROJECT_PATH') or None


class Reason:
  """
  Why the server refuses what clients send: the `reason` of its JSON errors, {"error": <for people>, "reason": <for
  programs>}. The server answers with these (backend/uploads.py UploadError, api/outputs.py, api/commit_artifacts.py,
  api/batch.py) and qa compares them (qaboard/http_client.py `ResultsError.reason`): change them on both sides at once.
  The sign-in and access refusals (missing_scope, missing_role...) are backend/auth's, explained in qaboard/credentials.py.
  """
  # --- the run or the project can't send files ---
  UPLOADS_DISABLED = 'uploads_disabled'                        # the server takes no files (QABOARD_UPLOAD_ROOT), or not this project's
  UPLOADS_UNSUPPORTED_PROJECT = 'uploads_unsupported_project'  # the project has a folder named like the server's runs folder
  UPLOADS_FOLDER = 'uploads_folder'                            # results saved directly in the folder of uploaded files
  INVALID_RUN = 'invalid_run'                                  # the run's names can't be folders' names
  NOT_UPLOADED = 'not_uploaded'                                # the run (or commit's artifacts) is in a shared storage, not sent
  NOT_RUNNING = 'not_running'                                  # the run ended: its files and progress don't change anymore
  PROXY_MISCONFIGURED = 'proxy_misconfigured'                  # nginx didn't check the token first: its configuration misses a snippet
  METRICS_EXIST = 'metrics_exist'                              # run.log_metrics() of metrics the run returned, without overwrite
  LOCAL_CHANGES_NOT_ALLOWED = 'local_changes_not_allowed'      # a patch of the run's local changes, above runs.local_changes
  # --- one file ---
  INVALID_PATH = 'invalid_path'
  INVALID_SIZE = 'invalid_size'
  INCOMPLETE = 'incomplete'                                    # the body ended before its Content-Length
  DIGEST_REQUIRED = 'digest_required'                          # no X-Content-SHA256
  DIGEST_MISMATCH = 'digest_mismatch'
  TOO_LARGE = 'too_large'                                      # 413, with `max_file_size`
  STORAGE_FULL = 'storage_full'                                # 507
  PATH_CONFLICT = 'path_conflict'                              # a file where there is a folder, or the other way
  OFFSET_MISMATCH = 'offset_mismatch'                          # 409 with the file's `size`: send it whole, or from there
  # --- a commit's artifacts ---
  INVALID_COMMIT = 'invalid_commit'
  UNKNOWN_COMMIT = 'unknown_commit'
  DELETED = 'deleted'
  # --- batches started from the web app ---
  NO_SERVER_RUNNER = 'no_server_runner'                        # QABOARD_TUNING_RUNNER unset: the server starts no batches
  # --- batch tokens (tokens.mint_for_batch in backend/backend/tokens.py) ---
  BATCH_TOKEN_REQUIRED = 'batch_token_required'                # only the batch's own token sends its log
  INVALID_LOG_DIR = 'invalid_log_dir'
  BATCH_TOKEN_LIMITED = 'batch_token_limited'                  # a batch's token only changes its batch (commit + label) of its project


# Why the server refuses runs that send their files, and what to do about it (qa run, start_run(), qa upload)
UPLOAD_REFUSALS = (Reason.UPLOADS_DISABLED, Reason.UPLOADS_UNSUPPORTED_PROJECT, Reason.INVALID_RUN)
# Why the server takes no more file of a run: the uploader stops asking (qaboard/upload.py)
RUN_FILES_REFUSALS = (Reason.UPLOADS_DISABLED, Reason.NOT_UPLOADED, Reason.NOT_RUNNING, Reason.PROXY_MISCONFIGURED)
# Why the server has no artifacts of a commit to give (qaboard/commit_artifacts.py): none to fetch, not an error
NO_ARTIFACTS = (Reason.NOT_UPLOADED, Reason.DELETED, Reason.UNKNOWN_COMMIT)
UPLOAD_FIX = ("Set `storage` in qaboard.yaml (or QA_STORAGE) to a folder the server reads too, or ask its administrators to accept files (QABOARD_UPLOAD_ROOT). "
              "If your organization has a site package (qaboard-site-...), install it: it says where results are saved.")


def storage_setting(config: Optional[Dict], qa_storage: Optional[str] = None):
  """
  The storage setting that applies to a project, for `qa` and the server alike: $QA_STORAGE, else `storage` in
  qaboard.yaml (or the site's), where `ci_root`, its former name, wins (like config.storage_roots). None if none.
  """
  config = config or {}
  return qa_storage or config.get('ci_root') or config.get('storage') or None


def sends_files(config: Optional[Dict], qa_storage: Optional[str] = None) -> bool:
  """Whether shared runs send their files to the server over HTTP: `storage: upload`, or no storage setting at all"""
  setting = storage_setting(config, qa_storage)
  return not setting or is_upload_storage(setting)


def get_settings(inputs_type, config):
  config_inputs = config.get('inputs', {})  
  config_inputs_types = config_inputs.get('types', {})
  if inputs_type != 'default' and inputs_type not in config_inputs_types:
    error = f'Error: Unknown input type <{inputs_type}>. It is not defined in your qaboard.yaml'
    click.secho(error, fg='red', err=True, bold=True)
    raise ValueError(error)
  settings = {
    **config_inputs,
    **config_inputs_types.get(inputs_type, {}),
    "type": inputs_type,
  }
  if 'globs' not in settings:
    settings['globs'] = settings.get('glob')
  return settings



def batches_files(config, batch_paths, project, subproject, root_qatools):
  if root_qatools:
    assert bool(config) ^ bool(batch_paths)

  paths = []
  if config:
    config_inputs = config.get('inputs', {})
    # "batches" is preferred, but we want to stay backward compatible
    paths = config_inputs.get('groups', config_inputs.get('batches')) or []
  elif batch_paths:
    paths = batch_paths

  if not paths:
    return paths
  if not (isinstance(paths, list) or isinstance(paths, tuple)):
    paths = [paths]
  paths = [location_from_spec(p, {"project": project, "subproject": subproject}) for p in paths]

  if any(['*' in str(paths)]):
    from itertools import chain
    from glob import iglob
    # no chdir: the cwd is process-wide, the server calls us from many threads
    paths = list(chain.from_iterable([iglob(str(path), root_dir=root_qatools) for path in paths]))
  return paths

def slugify(s : str, maxlength=32):
  # lowercased and shortened to 63 bytes
  slug = s.lower()
  if maxlength:
    slug = slug[:(maxlength - 1)]
  # everything except 0-9 and a-z replaced with -. 
  slug = re.sub('[^0-9a-z.=]', '-', slug)
  slug = re.sub('-{2,}', '-', slug)
  # No leading / trailing -.
  # if len(slug) > 1: # empty config: -
  #   slug = slug.strip('-') 
  slug = slug.strip('-') 
  return slug

def slugify_hash(s, maxlength=32):
  if not isinstance(s, str):
    s_to_slugify = json.dumps(s, sort_keys=True)
  else:
    s_to_slugify = s
  if len(s_to_slugify) < maxlength:
    return slugify(s_to_slugify, maxlength)
  s_hash = make_hash(s)[:8]
  return f"{s_hash}-{slugify(s_to_slugify[-(maxlength-8):], maxlength=None)}"


def deserialize_config(configuration: str) -> List:
  if configuration == '-':
    return []
  configurations: List = []
  configuration_part = ''

  is_windows = os.name == 'nt'
  for token in configuration.split(':'):
    # FIXME: For users that work locally on Windows,
    #        we take care of the special case "base:C://Users:delta"
    #        Ideally we should provide configs via `qa -c config1 -c C://file` and avoid this issue...
    if is_windows and not configuration_part and token[0] in ['\\', '/']:
      maybe_absolute_path = configurations[-1] + token if configurations else token
      if os.path.exists(maybe_absolute_path):
        configurations[-1] = maybe_absolute_path
        continue

    # FIXME: Same issue here: we started with ":"-separated arrays of configs
    #        Of course, hell breaks loose when we try to use json...
    maybe_start_of_json = token.startswith('{')
    if not configuration_part and not maybe_start_of_json:
      configurations.append(token)
    else:
      configuration_part = f"{configuration_part}:{token}" if configuration_part else token
      try:
        configurations.append(json.loads(configuration_part))
        configuration_part = ''
      except Exception:
        # It's not perfect: we should deal with quoting...
        # For now let's say using "{" or "}" is discouraged as part of config strings
        # Again, the better fix is not to do this ":"-separated serialization in the first place
        if configuration_part.count('{') == configuration_part.count('}'):
          configurations.append(configuration_part)
          configuration_part = ''
        else:
          pass
  if configuration_part:
      configurations.append(configuration_part)
  return configurations


def serialize_config(configurations: List) -> str:
  if not configurations:
    return '-'
  if isinstance(configurations, str):
    return configurations
  configurations = [json.dumps(c, sort_keys=True) if isinstance(c, dict) else (c if c is not None else "null") for c in configurations]
  configuration = ":".join(configurations)
  return configuration


def pretty_hash(params_str, maxlen=20):
  """Best effort attempt at making a human-readable name from tuning parameters"""
  params_hash = make_hash(params_str)
  params_hash_pretty = params_str.replace(",","_")
  for char in "\\{}:[] \r\n\"/":
    params_hash_pretty = params_hash_pretty.replace(char,"")
  if len(params_hash_pretty) > maxlen:
    params_hash_pretty = params_hash[:8] + '-' + re.sub("[a-zA-Z_]+", lambda x: x.group(0)[-2:], params_hash_pretty)
  if len(params_hash_pretty) > maxlen:
    params_hash_pretty = params_hash_pretty[-10:] + '-' + params_hash[:10]
  return params_hash_pretty



def hash_parameters(parameters):
  # we can specify either None, directly parameters, or a Path
  if not parameters:
    params = {}
  elif isinstance(parameters, dict):
    params = parameters
  else:
    with parameters.open('r') as f:
      if parameters.suffix == '.yaml':
        params = yaml.load(f, Loader=yaml.SafeLoader)
      elif parameters.suffix == '.cde':
        from cde import Config
        params = Config.loads(f.read()).asdict()
      else:
        params = json.load(f)
  return make_hash(params)




def make_hash(obj):
  params_s = json.dumps(obj, sort_keys=True)
  return hashlib.md5(params_s.encode()).hexdigest()



def get_commit_dirs(commit, repo_root: Optional[Path]=None) -> Path:
  # If there is no git data we store outputs in the current working directory,
  # or at the project root if using subprojects...
  # FIXME: on Windows the trick of returning an absolute path and have some_path / get_commit_dirs()
  #        be equal to get_commit_dirs() doesn't work...
  if not commit:
    if repo_root is None:
      raise ValueError("Not enough information about the commit to know where to store its data.")
    return repo_root.resolve()
  if isinstance(commit, str): # commit hexsha passed as string
    # we want to resolve the full hash if we weren't passed it already
    if re.match(r"[0-9a-f]{40}", commit):
      commit_id = commit
    else:
      try:
        commit_id = git_show(format='%H', reference=commit)
      except Exception:
        if repo_root is None:
          raise ValueError("Not enough information about the commit to know where to store its data.")
        # if we run within an artifact directory, we're not in a git repo, so "git show" will fail.
        click.secho(f"WARNING: Could not resolve the commit locally ({commit}). Not enough information to know where to store artifacts/runs.", fg='yellow', err=True)
        return repo_root.resolve()
  else: # likely a gitpython Commit object...
    commit_id = commit.hexsha
  return commit_dir_name(commit_id)


def commit_dir_name(commit_id: str) -> Path:
  """A commit's folder under its project's, in the storage. git hex hashes are size 40. For us 16 should be plenty enough..."""
  return Path(f'{commit_id[:2]}/{commit_id[2:16]}')


# backward compatibility for the CI of HW_ALG (tools/ci_scripts/find_valid_build.py) and has to exist for tof/swip_tof's runs
def get_commit_ci_dir(ci_dir, commit):
  return ci_dir / get_commit_dirs(commit)


def batch_folder_name(label:str) -> Path:
  return Path('output') if label == 'default' else Path('output') / slugify_hash(label)



def batch_dir(outputs_commit, batch_label, save_with_ci=False):
  from qaboard.config import is_ci, subproject
  batch_folder = batch_folder_name(batch_label)
  return outputs_commit / batch_folder if (is_ci or save_with_ci) else subproject.resolve() / batch_folder

def make_batch_dir(outputs_commit, batch_label, platform, configurations, extra_parameters, save_with_ci):
  return batch_dir(outputs_commit, batch_label, save_with_ci)

def batch_conf_dir_name(platform, configurations, extra_parameters) -> str:
  full_configurations = [platform] if platform != 'lsf' else []
  full_configurations.extend([*configurations, extra_parameters])
  return slugify_hash(full_configurations, maxlength=16)

def make_batch_conf_dir(outputs_commit, batch_label, platform, configurations, extra_parameters, save_with_ci):
  return (
    batch_dir(outputs_commit, batch_label, save_with_ci) /
    batch_conf_dir_name(platform, configurations, extra_parameters)
  )

def run_dir_in_commit(batch_label, platform, configurations, extra_parameters, rel_input_path, database, config) -> Path:
  """Where `qa run` saves a run, relative to its commit's outputs directory (or the project's, for local runs)"""
  # forwarded arguments (qa run -i input --some-arg) are not part of the run's directory
  extra_parameters = {k: v for k, v in (extra_parameters or {}).items() if k != 'forwarded_args'}
  return (
    batch_folder_name(batch_label) /
    batch_conf_dir_name(platform, configurations or [], extra_parameters) /
    output_dirs_for_input_part(Path(rel_input_path), Path(database), config)
  )

def output_dirs_for_input_part(input_path, database, config):
    input_dir = input_path.with_suffix('')
    input_dir = Path(slugify_hash(input_dir.as_posix(), maxlength=70))
    if config.get('outputs', {}).get('output_dir_uses_database'):
        if not database.is_absolute():
            input_dir = database / input_dir
        else:
            input_dir = database.relative_to(database.anchor) / input_dir
    return input_dir
