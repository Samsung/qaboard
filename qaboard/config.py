"""
Provides a default QA configuration for the projects, by reading the configuration file and the environment variables.
"""
import os
import sys
import datetime
from getpass import getuser
from pathlib import Path, PurePosixPath
from typing import Dict, Any, Tuple, List, Optional, Union

import yaml
import click

from .utils import merge, getenvs
from .git import git_head, git_show
from .conventions import slugify, get_commit_dirs, location_from_spec
from .iterators import flatten


# In case the qaboard.yaml configuration has errors, we don't want to exit directly.
# but first show all the errors that need to be fixed.
config_has_error = False

# Don't lots of verbose info if the users just wants the help, or start a new project
ignore_config_errors = len(sys.argv)==1 or '--help' in sys.argv or 'init' in sys.argv
# When the code is imported we care less about warnings...
ignore_config_errors = ignore_config_errors or not sys.argv[0].endswith('qa')

def find_configs(path : Path) -> List[Tuple[Dict, Path]]:
    """Returns the parsed content and paths of qaboard.yaml files that should be loaded for a (sub)project at the `path`.
    Returns a tuple (configs, paths). Each element is a list - the root qaboard.yaml is first and the subproject's is last.
    """
    configsxpaths = []
    # We need a full path to iterate on the parents
    path = path.resolve()
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




qatools_configsxpaths = find_configs(path=Path())
qatools_configs = [q[0] for q in qatools_configsxpaths]
qatools_config_paths = [q[1] for q in qatools_configsxpaths]
if not qatools_configsxpaths:
  config_has_error = True
  if not ignore_config_errors:
    click.secho('ERROR: Could not find a `qaboard.yaml` configuration file.\nDid you run `qatools init` ?', fg='red', err=True)
    click.secho(
        'Please read the tutorial or ask Arthur Flam for help:\n'
        'http://qa-docs/',
        dim=True, err=True)


# take care not to mutate the root config, as its project.name is the git repo name
config : Dict[str, Any] = {}
for c in qatools_configs:
  config = merge(c, config)

# The top-most qaboard.yaml is the root project
# The current subproject corresponds to the lowest qaboard.yaml
if not qatools_config_paths:
  root_qatools = None
  project_dir = None
  root_qatools_config: Dict[str, Any] = {}
  project = None
  project_root = None
  subproject = Path(".")
else:
  if len(qatools_config_paths)==1:
    root_qatools = qatools_config_paths[0].parent
    project_dir = root_qatools
    root_qatools_config = qatools_configs[0]
  else:
    root_qatools, *__, project_dir = [c.parent for c in qatools_config_paths]
    root_qatools_config, *_ = qatools_configs
  subproject = project_dir.relative_to(root_qatools) if root_qatools else Path(".")

  # We check for consistency
  if root_qatools_config and config:
    if root_qatools_config.get('project', {}).get('url') != config.get('project', {}).get('url'):
      config_has_error = True
      if not ignore_config_errors:
        click.secho(f"ERROR: Don't redefine the project's URL in ./qaboard.yaml.", fg='red', bold=True, err=True)
        click.secho(f"Changed from {root_qatools_config.get('project', {}).get('url')} to {config.get('project', {}).get('url')}", fg='red')

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
  config['project']['name'] = project.as_posix()


# It's useful to know what's the platform since code is often compiled a different locations.
# For instance Linux builds are often at `build/bin/` vs `/x64/Release/` on Windows.
on_windows = os.name == 'nt'
on_linux = not on_windows

# SIRC-specific hosts
on_vdi = 'HOST' in os.environ and os.environ['HOST'].endswith("vdi")
on_lsf = 'HOST' in os.environ and (os.environ['HOST'].endswith("transchip.com") or os.environ['HOST'].startswith("planet"))

platform = 'windows' if on_windows else 'linux'

user = getuser()


def storage_roots(config: Dict, project: Path, subproject: Path) -> Tuple[Path, Path]: 
  # we do compute it twice, but it gives us some flexibility
  user = getuser()
  try:
    if 'ci_root' in config:
      # click.secho('DEPRECATION WARNING: the config key "ci_root" was renamed "storage"', fg='yellow', err=True)
      config['storage'] = config['ci_root']
    config_storage: Union[str, Dict] = os.environ.get('QA_STORAGE', config.get('storage', {}))
    interpolation_vars = {"project": project, "subproject": subproject, "user": user}
    spec_artifacts = config_storage.get('artifacts', config_storage) if isinstance(config_storage, dict) else config_storage
    spec_outputs = config_storage.get('outputs', config_storage) if isinstance(config_storage, dict) else config_storage
    artifacts_root = location_from_spec(spec_artifacts, interpolation_vars)
    outputs_root = location_from_spec(spec_outputs, interpolation_vars)
    if not artifacts_root or not outputs_root:
      raise KeyError
  except KeyError:
    artifacts_root = Path()
    outputs_root = Path()
    config_has_error = True
    if not ignore_config_errors:
      click.secho('ERROR: Could not find the storage settings that define where outputs & artifacts are saved.', fg='red', err=True)
      click.secho('Consider adding to qaboard.yaml:\n```storage:\n  linux: /net/stage/algo_data/ci\n  windows: "\\\\netapp\\algo_data\\ci"\n```', fg='red', err=True, dim=True)
  return outputs_root, artifacts_root

def mkdir(path: Path):
  global config_has_error
  if not path.exists():
    try:
      path.mkdir(parents=True)
      click.secho(f'Created: {path}', fg='blue', err=True)
    except:
      config_has_error = True
      if not ignore_config_errors:
        click.secho(f'ERROR: The storage path does not exist: "{path}".', fg='red', err=True)


outputs_root: Optional[Path]
artifacts_root: Optional[Path]
artifacts_project_root: Optional[Path]
artifacts_project: Optional[Path]
outputs_project_root: Optional[Path]
outputs_project: Optional[Path]
if root_qatools_config:
  assert project
  assert project_root
  outputs_root, artifacts_root = storage_roots(config, project, subproject)
  mkdir(outputs_root)
  mkdir(artifacts_root)
  artifacts_project_root = artifacts_root / project_root
  artifacts_project = artifacts_root / project
  outputs_project_root = outputs_root / project_root
  outputs_project = outputs_root / project
else:
  outputs_root = None
  artifacts_root = None
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
    commit_id = getenvs(commit_sha_variables)

    branch_env_variables = (
        'CI_COMMIT_TAG',      # GitlabCI, only when building tags
        'CI_COMMIT_REF_NAME', # GitlabCI
        'GIT_BRANCH',         # Jenkins
        'gitlabBranch',       # Jenkins gitlab plugin 
        'CIRCLE_BRANCH',      # CircleCI
        'TRAVIS_BRANCH',      # TravisCI
        'GITHUB_REF'          # Github Actions
    )
    commit_branch = getenvs(branch_env_variables)
    if commit_branch:
      commit_branch = commit_branch.replace('origin/', '').replace('refs/heads/', '')

    tag_env_variables = (
        'CI_COMMIT_TAG',      # GitlabCI
        'GIT_TAG_NAME',       # Jenkins git plugin
        'CIRCLE_TAG',         # CircleCI
        'TRAVIS_TAG',         # TravisCI
        # Github Actions uses GITHUB_REF too
    )
    commit_tag = getenvs(tag_env_variables)
else:
    commit_type = None
    # If possible we'll complete the information later
    commit_id = None
    commit_branch = None
    commit_tag = None


# TODO: refactor in git.py, consider calling git directly...
repo_root = Path(os.environ.get('QA_REPO', str(root_qatools if root_qatools else Path())))
is_in_git_repo = False
for d in (repo_root, *list(repo_root.parents)):
  if (d / '.git').is_dir():
    is_in_git_repo = True
    repo_root = d
if not commit_id or not commit_branch:
    if is_in_git_repo:
      commit_branch, commit_id = git_head(repo_root)
    else:
      if not commit_branch:
        commit_branch = f'<local:{user}>'
      if not commit_id:
        commit_id = f'<local:{user}>'

if artifacts_project_root:
    artifacts_branch_root = artifacts_project_root / 'branches' / slugify(commit_branch)
    artifacts_branch = artifacts_branch_root / subproject
else:
    artifacts_branch_root = Path()
    artifacts_branch = Path()

commit_committer_name: Optional[str] = user
commit_committer_email: Optional[str] = None
commit_authored_datetime = datetime.datetime.now(datetime.timezone.utc).isoformat()
commit_message: Optional[str] = None
commit_parents: List[str] = []
if commit_id and is_in_git_repo:
  fields = ['%cn', '%ce', '%aI', '%P', "%B"]
  try:
    commit_info = git_show("%n".join(fields), commit_id)
    fields_values = commit_info.split('\n', maxsplit=len(fields))
    commit_committer_name, commit_committer_email, commit_authored_datetime, commit_parents_str, commit_message = fields_values
    commit_parents = commit_parents_str.split()
  except:
    # may fail when working on the first commit in a repo, like in our tests
    pass


if root_qatools_config:
  assert artifacts_project_root
  assert outputs_project_root
  commit_dirs = get_commit_dirs(commit_id, repo_root)
  artifacts_commit_root = artifacts_project_root / commit_dirs
  artifacts_commit      = artifacts_project_root / commit_dirs / subproject
  outputs_commit_root   = outputs_project_root   / commit_dirs
  outputs_commit        = outputs_project_root   / commit_dirs / subproject
else:
  artifacts_commit_root = Path()
  artifacts_commit = Path()
  outputs_commit_root = Path()
  outputs_commit = Path()

# backward compatibility for HW_ALG's runs. And tof/swip_tof's runs: has to exist
commit_ci_dir = outputs_commit
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

# "batches" is prefered, but we want to stay backward compatible
default_batches_files = config_inputs.get('groups', config_inputs.get('batches'))
if not default_batches_files:
  default_batches_files = []
if not (isinstance(default_batches_files, list) or isinstance(default_batches_files, tuple)):
  default_batches_files = [default_batches_files]


config_inputs_types = config_inputs.get('types', {})
default_input_type = config_inputs_types.get('default', 'default')


def get_default_configuration(input_settings) -> str:
  from .conventions import serialize_config
  default_configuration = input_settings.get('configs', input_settings.get('configurations', input_settings.get('configuration', [])))
  default_configuration = list(flatten(default_configuration))
  return serialize_config(default_configuration)

def get_default_database(inputs_settings):
  # All recordings used should be stored at the same location
  # We will refer to them by their relative path related to the "database"
  global ignore_config_errors
  if 'type' in inputs_settings and inputs_settings['type'] in inputs_settings and 'database' in inputs_settings[inputs_settings['type']]:
    database_spec = inputs_settings[inputs_settings['type']]['database']
  else:
    database_spec = inputs_settings.get('database', {})
  try:
    database = location_from_spec(database_spec)
  except:
    database = Path("/")
  if not database:
    database = "."
    if not ignore_config_errors:
      click.secho(f'WARNING: Could not find the default database location, defaulting to "."', fg='yellow', err=True)
      click.secho(f'Consider adding to qaboard.yaml:\n```\ninputs:\n  database:\n    linux: /net/stage/algo_data\n    windows: "\\\\netapp2\\algo_data"\n```', fg='yellow', err=True, dim=True)
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
          ignore_config_errors = True
      available_metrics = _metrics.get('available_metrics', {})
      main_metrics = _metrics.get('main_metrics', [])



# We want to allow any user to use the Gitlab API, stay compatible with usage at Samsung 
# ...and remove the credentials from the repo
default_secrets_path = os.environ.get('QA_SECRETS', '/home/ispq/.secrets.yaml' if os.name != 'nt' else '//mars/raid/users/ispq/.secrets.yaml')
secrets_path = Path(config.get('secrets', default_secrets_path))
if secrets_path.exists():
  with secrets_path.open() as f:
    secrets = yaml.load(f, Loader=yaml.SafeLoader)
else:
  secrets = {}
