"""
Provides a default QA configuration for the projects, by reading the configuration file and the environment variables.
"""
import os
import sys
import json
import datetime
from getpass import getuser
from pathlib import Path
from typing import Dict, Any, Tuple, List, Optional, Union

import yaml
import click

from .utils import merge, getenvs
from .git import git_head, git_show
from .conventions import slugify, get_commit_dirs, location_from_spec, batches_files
from .iterators import flatten
from .site_config import site_config, site_qaboard_config, without_locations_from


# In case the qaboard.yaml configuration has errors, we don't want to exit directly.
# but first show all the errors that need to be fixed.
config_has_error = False

# Don't lots of verbose info if the users just wants the help, or start a new project
ignore_config_errors = len(sys.argv)==1 or '--help' in sys.argv or 'init' in sys.argv
# `qa auth` doesn't need a project: we don't even read qaboard.yaml, it may have errors
is_auth_command = sys.argv[1:2] == ['auth']
ignore_config_errors = ignore_config_errors or is_auth_command
# When the code is imported we care less about warnings...
ignore_config_errors = ignore_config_errors or not sys.argv or not sys.argv[0].endswith('qa')

def find_configs(path : Path) -> List[Tuple[Dict, Path]]:
    """Returns the parsed content and paths of qaboard.yaml files that should be loaded for a (sub)project at the `path`.
    Returns a tuple (configs, paths). Each element is a list - the root qaboard.yaml is first and the subproject's is last.
    """
    configsxpaths = []
    # We need a full path to iterate on the parents
    path = Path(os.path.abspath(path)) # abspath() instead of resolve(), since it fails on Windows by dereferencing mapped drives
    # We look for qaboard.yaml configuration files in the path folder and its parents
    parents = [path, *list(path.parents)]
    for parent in parents:
        qatools_config_path = parent / 'qaboard.yaml'
        if not qatools_config_path.exists():
          qatools_config_path = parent / 'qatools.yaml' # backward compatibility
          if not qatools_config_path.exists():
            continue
        with qatools_config_path.open('r') as f:
            qatools_config = yaml.load(f, Loader=yaml.SafeLoader)
            if not qatools_config: # support empty files that just mark subprojects
              qatools_config = {}
            configsxpaths.append((qatools_config, qatools_config_path))
            if qatools_config.get('root'):
              break
    configsxpaths.reverse()
    return configsxpaths




qatools_configsxpaths = find_configs(path=Path()) if not is_auth_command else []
qatools_configs = [q[0] for q in qatools_configsxpaths]
qatools_config_paths = [q[1] for q in qatools_configsxpaths]
if not qatools_configsxpaths:
  config_has_error = True
  if not ignore_config_errors:
    click.secho('ERROR: Could not find a `qaboard.yaml` configuration file.', fg='red', err=True)
    if 'QABOARD_TUNING' not in os.environ:
      click.secho('       If you are starting a new project, run `qa init`.', fg='red', err=True)
    else:
      click.secho(f'       It seems "artifacts" are missing. To save them:', fg='red', err=True)
      click.secho(f'       1. cd your/project', fg='red', err=True)
      click.secho(f'       2. git checkout {os.environ.get("GIT_COMMIT", "your-commit")}', fg='red', err=True)
      click.secho(f'       3. # build whatever is needed', fg='red', err=True)
      click.secho(f'       4. qa save-artifacts', fg='red', err=True)


def expand_paths(value: str, interpolation_vars):
  if "{" not in value:
    return value
  else:
    return location_from_spec(value, interpolation_vars)


# Final merged config
config : Dict[str, Any] = {}

# The top-most qaboard.yaml is the root project
# The current subproject corresponds to the lowest qaboard.yaml
if not qatools_config_paths:
  root_qatools = None
  project_dir = None
  root_qatools_config: Dict[str, Any] = {}
  project = None
  project_root = None
  subproject = Path(".")
  interpolation_vars = {}
else:
  if len(qatools_config_paths)==1:
    root_qatools = qatools_config_paths[0].parent
    project_dir = root_qatools
    root_qatools_config = qatools_configs[0]
  else:
    root_qatools, *__, project_dir = [c.parent for c in qatools_config_paths]
    root_qatools_config, *_ = qatools_configs
  subproject = project_dir.relative_to(root_qatools) if root_qatools else Path(".")

  # The site's base qaboard.yaml (e.g. from qaboard-site-sirc) provides defaults for all projects
  config = without_locations_from(site_qaboard_config(), qatools_configs)
  # take care not to mutate the root config, as its project.name is the git repo name
  for c in qatools_configs:
    if "include" in c:
      # paths will be relative to the root qaboard.yaml
      c_include_path = root_qatools / c["include"]
      with c_include_path.open() as f:
        c_include = yaml.load(f, Loader=yaml.SafeLoader)
      c = merge(c_include, c)
    config = merge(c, config)

  # We check for consistency
  if root_qatools_config and config:
    if root_qatools_config.get('project', {}).get('url') != config.get('project', {}).get('url'):
      config_has_error = True
      if not ignore_config_errors:
        click.secho(f"ERROR: Don't redefine the project's URL in ./qaboard.yaml.", fg='red', bold=True, err=True)
        click.secho(f"Changed from {root_qatools_config.get('project', {}).get('url')} to {config.get('project', {}).get('url')}", fg='red')

  # we support "prefix/{root_path.name}" to make configuration easier for groups
  # that have tons of small repos configured the name
  interpolation_vars = {"root_path": root_qatools, "project_path": project_dir}
  root_qatools_config['project']['name'] = expand_paths(root_qatools_config['project']['name'], interpolation_vars)
  root_qatools_config['project']['url'] = expand_paths(root_qatools_config['project']['url'], interpolation_vars)
  config['project']['name'] = expand_paths(config['project']['name'], interpolation_vars)
  config['project']['url'] = expand_paths(config['project']['url'], interpolation_vars)


  # We identify sub-qatools projects using the location of qaboard.yaml related to the project root
  # It's not something the user should change...
  project_root = Path(root_qatools_config['project']['name'])
  project = project_root / subproject
  uncoherent_name = config['project']['name'] not in [root_qatools_config['project']['name'], project]
  if uncoherent_name:
    config_has_error = True
    if not ignore_config_errors:
      click.secho(f"ERROR: Don't redefine <project.name> in ./qaboard.yaml", fg='red', bold=True, err=True)
      click.secho(f"Changed from {root_qatools_config['project']['name']} to {config['project']['name']})", fg='red')
  # make sure everything is consistent even if users call this directly
  config['project']['name'] = project.as_posix()
  root_qatools_config['project']['name'] = project_root.as_posix()


# It's useful to know what's the platform since code is often compiled a different locations.
# For instance Linux builds are often at `build/bin/` vs `/x64/Release/` on Windows.
on_windows = os.name == 'nt'
on_linux = not on_windows

platform = 'windows' if on_windows else 'linux'


user = os.environ.get('QA_USER', getuser())
local_commit_placeholder = f'<local:{user}>'


def storage_roots(config: Dict, project: Path, subproject: Path, user_name: Optional[str] = None) -> Tuple[Path, Path, Path]:
  """`user_name` replaces {user} in the storage settings, by default the current user."""
  if user_name is not None:
    user_ = user_name
  # useful when migration results to a new default location
  elif 'QABOARD_NO_CACHE_USER' in os.environ:
    user_ = os.environ.get('QA_USER', getuser())
  else:
    user_ = user
  try:
    if 'ci_root' in config:
      # click.secho('DEPRECATION WARNING: the config key "ci_root" was renamed "storage"', fg='yellow', err=True)
      config['storage'] = config['ci_root']
    config_storage: Union[str, Dict] = os.environ.get('QA_STORAGE', config.get('storage', {}))
    interpolation_vars = {"project": project, "subproject": subproject, "user": user_}
    spec_artifacts = config_storage.get('artifacts', config_storage) if isinstance(config_storage, dict) else config_storage
    spec_outputs = config_storage.get('outputs', config_storage) if isinstance(config_storage, dict) else config_storage
    artifacts_root = location_from_spec(spec_artifacts, interpolation_vars)
    outputs_root = location_from_spec(spec_outputs, interpolation_vars)
    # some project are submodules and rely in relative paths outside of the project itself
    # so we need some way to save their artifacts as if they were actually subprojects.
    # For example, if the real root is HW_ALG, with build in HW_ALG/CIS/build/Release/bin/cde_cis
    # and the project being HW_ALG/ALG_GEN/BAS/Block, defining artifacts as ../../../CIS/build/Release/bin/cde_cis
    # we'd need it to have in qaboard.yaml: storage.artifacts.subproject: ALG_GEN/BAS/{project.name}
    # and recreate the implicit hierarchy.
    if isinstance(spec_artifacts, dict) and "subproject" in spec_artifacts:
      subproject_for_artifacts = location_from_spec(spec_artifacts["subproject"], interpolation_vars)
    else:
      subproject_for_artifacts = Path()
    if not artifacts_root or not outputs_root:
      raise KeyError
  except KeyError:
    artifacts_root = Path()
    outputs_root = Path()
    if not ignore_config_errors:
      click.secho('ERROR: Could not find the storage settings that define where outputs & artifacts are saved.', fg='red', err=True)
      click.secho('Consider adding to qaboard.yaml:\n```storage:\n  linux: /mnt/qaboard\n  windows: "\\\\server\\share\\qaboard"\n```', fg='red', err=True, dim=True)
      if not site_config('QABOARD_SITE_CONFIG'):
        click.secho('If your organization has a site package (e.g. qaboard-site-sirc), install it to get default settings.', fg='red', err=True, dim=True)
  return outputs_root, artifacts_root, subproject_for_artifacts

# The storage folders that don't exist, and that we couldn't create. Only the commands that save or read results
# there need them (see `storage_needed_by`): local runs save theirs in the project's output/ folder.
missing_storage: List[Path] = []

def mkdir(path: Path):
  if not path.exists():
    try:
      path.mkdir(parents=True)
      click.secho(f'Created: {path}', fg='blue', err=True)
    except Exception:
      if path not in missing_storage:
        missing_storage.append(path)


# Commands that always use the storage, and what for
commands_using_storage = {
  'save-artifacts': '`qa save-artifacts` saves the build there',
  'check-bit-accuracy': '`qa check-bit-accuracy` reads the reference results there',
  'optimize': '`qa optimize` saves its results there',
}

def storage_needed_by(command: Optional[str], share: bool, is_ci: bool) -> Optional[str]:
  """Why a command needs the storage, or None if it doesn't. Runs in CI or with --share save their results there."""
  if command in ('auth', 'init'):
    return None
  if is_ci:
    return 'In CI, `qa` saves results there'
  if share:
    return '`qa --share` saves results there'
  return commands_using_storage.get(command) if command else None


# No messages for --help, `qa init`, `qa auth` or when imported. Unlike `ignore_config_errors`, it doesn't change
# once a warning was shown.
shows_config_messages = not ignore_config_errors

def report_missing_storage(needed_by: Optional[str], environ=os.environ) -> bool:
  """
  Whether the command must stop because the storage it needs is missing, after an error that says what to do.
  When it doesn't need it, we warn about it, once: not again in the runs `qa batch` starts.
  `needed_by` is why the command needs the storage, see `storage_needed_by`.
  """
  if not missing_storage or not shows_config_messages:
    return False
  paths = ', '.join(f'"{p}"' for p in missing_storage)
  if needed_by:
    click.secho(f'ERROR: The storage path does not exist, and qa could not create it: {paths}', fg='red', bold=True, err=True)
    click.secho(f'       {needed_by}. To fix it: create the folder, mount your shared storage there,', fg='red', err=True)
    click.secho('       or set QA_STORAGE (or `storage` in qaboard.yaml) to a folder your QA-Board server reads.', fg='red', err=True)
    # Sites can explain how to get storage for new projects
    storage_help = site_config('QABOARD_STORAGE_HELP')
    if storage_help:
      click.secho(f'INFO: {storage_help}', fg='blue', err=True)
    return True
  if 'QA_BATCH' not in environ:
    click.secho(f'WARNING: The storage path does not exist: {paths}. Local runs save their results in output/ without it,', fg='yellow', err=True)
    click.secho('         but `qa --share`, CI runs and `qa save-artifacts` need it: create or mount it, or set QA_STORAGE.', fg='yellow', err=True)
  return False

outputs_root: Optional[Path]
artifacts_root: Optional[Path]
artifacts_project_root: Optional[Path]
artifacts_project: Optional[Path]
outputs_project_root: Optional[Path]
outputs_project: Optional[Path]
if root_qatools_config:
  assert project
  assert project_root
  outputs_root, artifacts_root, subproject_for_artifacts = storage_roots(config, project, subproject)
  mkdir(outputs_root)
  mkdir(artifacts_root)
  artifacts_project_root = artifacts_root / project_root
  artifacts_project = artifacts_root / project
  outputs_project_root = outputs_root / project_root
  outputs_project = outputs_root / project
else:
  outputs_root = None
  artifacts_root = None
  subproject_for_artifacts = Path()
  artifacts_project_root = None
  artifacts_project = None
  outputs_project_root = None
  outputs_project = None


# This flag identifies runs that happen within the CI or tuning experiments
ci_env_variables = (
    # Set by most CI tools (GitlabCI, CircleCI, TravisCI, Github Actions...) except Jenkins,
    # and by the web application during tuning runs
    'CI',
    # set by Jenkins' git plugin
    'GIT_COMMIT',
)
is_ci = any([v in os.environ for v in ci_env_variables])

# CI providers, and what tells them apart: QA-Board shows users their own runs, and can hide the CI's
ci_providers = (
  ('gitlab', 'GITLAB_CI'),
  ('github', 'GITHUB_ACTIONS'),
  ('jenkins', 'JENKINS_URL'),
  ('azure', 'TF_BUILD'),
  ('buildkite', 'BUILDKITE'),
  ('circleci', 'CIRCLECI'),
  ('teamcity', 'TEAMCITY_VERSION'),
  ('bitbucket', 'BITBUCKET_BUILD_NUMBER'),
  ('drone', 'DRONE'),
  ('travis', 'TRAVIS'),
)


def run_context(environ=os.environ) -> dict:
  """
  Where `qa` runs: {"origin": "webapp" | "ci" | "local", ...}. Runs QA-Board starts set QABOARD_TUNING (and CI, like
  pipelines). For CI pipelines: the provider, links to the pipeline and job, and who triggered them, when we know.
  """
  if 'QABOARD_TUNING' in environ:
    return {"origin": "webapp"}
  provider = next((name for name, variable in ci_providers if environ.get(variable)), None)
  if not provider and not any(v in environ for v in ci_env_variables):
    return {"origin": "local"}
  context = {"origin": "ci", "provider": provider or "unknown"}
  if provider == 'gitlab':
    context.update(pipeline_url=environ.get('CI_PIPELINE_URL'), job_url=environ.get('CI_JOB_URL'),
                   triggered_by=environ.get('GITLAB_USER_EMAIL') or environ.get('GITLAB_USER_LOGIN'))
  elif provider == 'github':
    server, repository, run_id = environ.get('GITHUB_SERVER_URL'), environ.get('GITHUB_REPOSITORY'), environ.get('GITHUB_RUN_ID')
    if server and repository and run_id:
      context['pipeline_url'] = f"{server}/{repository}/actions/runs/{run_id}"
    context['triggered_by'] = environ.get('GITHUB_TRIGGERING_ACTOR') or environ.get('GITHUB_ACTOR')
  elif provider == 'jenkins':
    context.update(job_url=environ.get('BUILD_URL'), triggered_by=environ.get('BUILD_USER_EMAIL') or environ.get('BUILD_USER_ID'))
  elif provider == 'buildkite':
    context.update(job_url=environ.get('BUILDKITE_BUILD_URL'), triggered_by=environ.get('BUILDKITE_BUILD_CREATOR_EMAIL'))
  return {k: v for k, v in context.items() if v}


def github_pull_request_head() -> Optional[str]:
  """In Github Actions workflows triggered by pull requests, the last commit of the pull request."""
  if not os.environ.get('GITHUB_EVENT_NAME', '').startswith('pull_request'):
    return None
  try:
    with open(os.environ['GITHUB_EVENT_PATH']) as f:
      return json.load(f)['pull_request']['head']['sha']
  except (KeyError, OSError, ValueError, TypeError):
    return None


if is_ci:
    # This field is not used at the moment, possibly in the future we'll want to support other VCS like SVN
    commit_type = config.get('project', {}).get('type', 'git')
    # Different CI tools use different environment variables to tell us
    # what commit and branch we're running on
    commit_sha_variables = (
        'CI_COMMIT_SHA', # GitlabCI
        'GIT_COMMIT',    # Jenkins, git plugin
        'CIRCLE_SHA1',   # CircleCI
        'TRAVIS_COMMIT', # TravisCI
        'GITHUB_SHA'     # Github Actions
    )
    # For pull requests, Github Actions' GITHUB_SHA is a temporary merge commit: we use the PR's last commit
    commit_id = github_pull_request_head() or getenvs(commit_sha_variables)

    branch_env_variables = (
        'CI_COMMIT_TAG',      # GitlabCI, only when building tags
        'CI_COMMIT_REF_NAME', # GitlabCI
        'GIT_BRANCH',         # Jenkins
        'gitlabBranch',       # Jenkins gitlab plugin
        'CIRCLE_BRANCH',      # CircleCI
        'TRAVIS_BRANCH',      # TravisCI
        'GITHUB_HEAD_REF',    # Github Actions, the source branch of pull requests
        'GITHUB_REF_NAME',    # Github Actions, the branch or tag
        'GITHUB_REF'          # Github Actions
    )
    commit_branch = getenvs(branch_env_variables)
    if commit_branch:
      commit_branch = commit_branch.replace('origin/', '').replace('refs/heads/', '').replace('refs/tags/', '')

    tag_env_variables = (
        'CI_COMMIT_TAG',      # GitlabCI
        'GIT_TAG_NAME',       # Jenkins git plugin
        'CIRCLE_TAG',         # CircleCI
        'TRAVIS_TAG',         # TravisCI
    )
    commit_tag = getenvs(tag_env_variables)
    if not commit_tag and os.environ.get('GITHUB_REF_TYPE') == 'tag':
      commit_tag = os.environ.get('GITHUB_REF_NAME')
else:
    commit_type = None
    # If possible we'll complete the information later
    commit_id = None
    commit_branch = None
    commit_tag = None


# TODO: refactor in git.py, consider calling git directly...
# some projects are submodules, and for those the parent git repo is not what we are interested in
# so we cannot start the search at root_qatools
repo_root = Path(os.environ.get('QA_REPO', str(project_dir if project_dir else Path())))
is_in_git_repo = False
for d in (repo_root, *list(repo_root.parents)):
  if (d / '.git').exists():
    is_in_git_repo = True
    repo_root = d
    break


def _git_head_or_placeholder(repo_root: Path) -> Tuple[str, str]:
  """The (branch, commit) of the git HEAD, or placeholders outside git or if the HEAD can't be read."""
  if is_in_git_repo:
    try:
      return git_head(repo_root)
    except (OSError, ValueError) as e: # e.g. a .git pointer to a missing directory, an undecodable file
      click.secho(f'WARNING: Could not read the git HEAD, using placeholders: {e}', fg='yellow', err=True)
  return local_commit_placeholder, local_commit_placeholder


if not commit_id or not commit_branch:
    fallback_branch, fallback_id = _git_head_or_placeholder(repo_root)
    commit_branch = commit_branch or fallback_branch
    commit_id = commit_id or fallback_id

if artifacts_project_root:
    artifacts_branch_root = artifacts_project_root / 'branches' / slugify(commit_branch) / subproject_for_artifacts
    artifacts_branch = artifacts_branch_root / subproject
else:
    artifacts_branch_root = Path()
    artifacts_branch = Path()

commit_committer_name: Optional[str] = user
commit_committer_email: Optional[str] = None
# who wrote it: commits merged from GitHub/GitLab have the forge, or the maintainer who rebased, as committer
commit_author_email: Optional[str] = None
commit_authored_datetime = os.environ.get("GIT_AUTHORED_DATETIME", datetime.datetime.now(datetime.timezone.utc).isoformat())
commit_message: Optional[str] = os.environ.get("GIT_MESSAGE")
commit_parents: List[str] = []
if commit_id and is_in_git_repo:
  fields = ['%cn', '%ce', '%ae', '%ai', '%P', "%B"]
  try:
    commit_info = git_show("%n".join(fields), commit_id)
    fields_values = commit_info.split('\n', maxsplit=len(fields)-1)
    commit_committer_name, commit_committer_email, commit_author_email, commit_authored_datetime_, commit_parents_str, commit_message_ = fields_values
    if not commit_authored_datetime:
      commit_authored_datetime = commit_authored_datetime_
    if not commit_message:
      commit_message = commit_message_
    commit_parents = commit_parents_str.split()
  except Exception as e:
    # The commit can be missing from the clone (shallow CI clones, the first commit in a repo like in our tests...),
    # or come from the CI's environment variables: we do without what git would tell us about it.
    if 'QA_VERBOSE' in os.environ:
      print(e, file=sys.stderr)


if root_qatools_config:
  assert artifacts_project_root
  assert outputs_project_root
  commit_dirs = get_commit_dirs(commit_id, repo_root)
  artifacts_commit_root = artifacts_project_root / commit_dirs / subproject_for_artifacts
  artifacts_commit      = artifacts_commit_root / subproject
  outputs_commit_root   = outputs_project_root   / commit_dirs
  outputs_commit        = outputs_project_root   / commit_dirs / subproject
else:
  artifacts_commit_root = Path()
  artifacts_commit = Path() # / subproject? FIXME: check...
  outputs_commit_root = Path()
  outputs_commit = Path() # / subproject? FIXME: check...
# backward compatibility for HW_ALG's runs. And tof/swip_tof's runs: has to exist
commit_ci_dir = artifacts_commit  # used for PRODUCT_DIR
# backward compatibility for HW_ALG/tools/ci_tools/find_valid_build.py
ci_dir = artifacts_project_root

# When running qa from a folder with a commit's artifacts,
# there is no information about the git commit, no .git/ folder.
# During tuning/extra runs, QA-Board will provide this info using
# the QA_OUTPUTS_COMMIT and GIT_COMMIT environment variables
if 'QA_OUTPUTS_COMMIT' in os.environ:
  outputs_commit = Path(os.environ['QA_OUTPUTS_COMMIT'])



default_platform = platform
default_batch_label = 'default'

config_inputs = config.get('inputs', {})

default_batches_files = batches_files(config, None, project, subproject, root_qatools)

config_inputs_types = config_inputs.get('types', {})
default_input_type = config_inputs_types.get('default', 'default')


def get_default_configuration(input_settings) -> str:
  from .conventions import serialize_config
  default_configuration = input_settings.get('configs', input_settings.get('configurations', input_settings.get('configuration', [])))
  default_configuration = list(flatten(default_configuration))
  return serialize_config(default_configuration)

def get_default_database(inputs_settings, interpolation_vars=None):
  # All recordings used should be stored at the same location
  # We will refer to them by their relative path related to the "database"
  # `interpolation_vars` fills {project} and {subproject}, by default with the current project's (the server passes the commit's)
  global ignore_config_errors
  if 'type' in inputs_settings and inputs_settings['type'] in inputs_settings and 'database' in inputs_settings[inputs_settings['type']]:
    database_spec = inputs_settings[inputs_settings['type']]['database']
  else:
    database_spec = inputs_settings.get('database', {})
  if interpolation_vars is None:
    interpolation_vars = {"project": project, "subproject": subproject}
  try:
    database = location_from_spec(database_spec, interpolation_vars)
  except Exception:
    database = Path("/")
  if not database:
    database = "."
    if not ignore_config_errors:
      click.secho(f'WARNING: Could not find the default database location, defaulting to "."', fg='yellow', err=True)
      click.secho(f'Consider adding to qaboard.yaml:\n```\ninputs:\n  database:\n    linux: /mnt/datasets\n    windows: "\\\\server\\datasets"\n```', fg='yellow', err=True, dim=True)
      ignore_config_errors = True
  return Path(database)




_metrics: Dict = {}
available_metrics: Dict[str, Dict[str, Any]] = {}
main_metrics: List = []

metrics_file = config.get('outputs', {}).get('metrics')
if metrics_file:
  metrics_file_path = Path(root_qatools / metrics_file)
  if not metrics_file_path.exists():
    if not ignore_config_errors:
      click.secho(f'WARNING: Could not find the file containing metrics ({metrics_file})', fg='yellow', err=True)
      click.secho(f'         It is defined in qaboard.yaml under outputs.metrics', fg='yellow', err=True, dim=True)
      ignore_config_errors = True
  else:
    with metrics_file_path.open(errors="surrogateescape") as f:
      try:
        _metrics = yaml.load(f, Loader=yaml.SafeLoader)
      except Exception as e:
        config_has_error = True
        if not ignore_config_errors:
          click.secho(f'ERROR: Unable to parse {metrics_file}', fg='red', err=True, bold=True)
          click.secho(f'{e}', fg='red', err=True)
          ignore_config_errors = False
      # an empty file, or `available_metrics:` with only comments under it, are null
      available_metrics = (_metrics or {}).get('available_metrics') or {}
      main_metrics = (_metrics or {}).get('main_metrics') or []

# reexport for backward compat

# backward compat only for HW_ALG's tools/find_valid_build.py (removed 28/07/20)
from .git import _Repo, _Commit
repo = _Repo(repo_root)
commit = _Commit(repo, commit_id)
