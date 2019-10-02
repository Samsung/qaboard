"""
Provides a default QA configuration for the projects, by reading the configuration file and the environment variables.
"""
import os
import sys
from itertools import chain
from pathlib import Path, PurePosixPath

import yaml
import click

from .utils import getenvs, _Commit, _Repo
from .conventions import slugify, get_commit_ci_dir

# In case the qatools.yaml configuration has errors, we don't want to exit directly.
# We want to show all the errors to fix, and still allow qatools.config to be imported.
config_has_error = False


# We handle deprecate flag names here
renamings = (
  ('--input-path', '--input'),
  ('--output-path', '--output'),
  ('save_artifacts', 'save-artifacts'),
  ('check_bit_accuracy', 'check-bit-accuracy'),
  ('--reference-branch', '--reference'),
  ('--batch-label', '--label'),
  ('--inputs-database', '--database'),
  ('--inputs-globs', 'REMOVED: Use "inputs.types" in qatools.yaml'),
  ('--save-manifests', '--save-manifests-in-database'),
  ('--return-prefix-outputs-path', '--list-output-dirs'),
  ('--ci', '--share'),
  ('--group', '--batch'),
  ('--groups-file', '--batches-file'),
)
def renamed_deprecated(arg):
  for before, after in renamings:
    if arg == before:
      click.secho(f'Deprecation: {before} was replaced by {after} and will be removed in a future release.', fg='yellow')
      return after
  return arg
sys.argv = [renamed_deprecated(arg) for arg in sys.argv]
if '--lsf-sequential' in sys.argv:
  click.secho('WARNING: --lsf-sequential was replaced with `--runner local`', fg='yellow', bold=True)


def find_qatools_configs(path):
    """Returns the parsed content and paths of qatools.yaml files that should be loaded for a (sub)project at the `path`.
    Returns a tuple (configs, paths). Each element is a list - the root qatools.yaml is first and the subproject's is last.
    """
    qatools_configs = []
    qatools_config_paths = []
    # We need a full path to iterate on the parents
    path = path.resolve()
    # We look for qatools.yaml configuration files in the path folder and its parents
    parents = [path, *list(path.parents)]
    for parent in parents:
        qatools_config_path = parent / 'qatools.yaml'
        if not qatools_config_path.exists(): continue
        with qatools_config_path.open('r') as f:
            qatools_config = yaml.load(f, Loader=yaml.SafeLoader)
            qatools_configs.append(qatools_config)
            qatools_config_paths.append(qatools_config_path)
            if qatools_config.get('root'): break
    qatools_configs.reverse()
    qatools_config_paths.reverse()
    return qatools_configs, qatools_config_paths



# The `init` command is implemented here to avoid printing config error messages
# when users use qatools for the first time. Its goal is to provide a sample qatools configuration
if len(sys.argv)>1 and sys.argv[1] == 'init':
  from .init import qa_init
  qa_init()


# to avoid printing lots and lots of warnings, we define
no_config_warning = '--help' in sys.argv or not sys.argv

qatools_configs, qatools_config_paths = find_qatools_configs(path=Path())
if not qatools_configs:
  config_has_error = True
  if not no_config_warning:
    click.secho('ERROR: Could not find a `qatools.yaml` configuration file.\nDid you run `qatools init` ?', fg='red', err=True)
    click.secho(
        'Please read the tutorial or ask Arthur Flam for help:\n'
        'http://qa-docs/',
        dim=True, err=True)
  no_config_warning = True


def merge(src, dest):
    # https://stackoverflow.com/questions/20656135/python-deep-merge-dictionary-data
    for key, value in src.items():
      if isinstance(value, dict):
        node = dest.setdefault(key, {})
        merge(value, node)
      elif value:
        # "super" is a reserved keyword
        if isinstance(value, list) and "super" in value:
          value = list(chain.from_iterable([[e] if e != "super" else dest[key] for e in value]))
        dest[key] = value
    return dest


config = qatools_configs[0]
for c in qatools_configs[1:]:
  config = merge(c, config)

# The top-most qatools.yaml is the root project
# The current subproject corresponds to the lowest qatools.yaml
if not qatools_config_paths:
  root_qatools = None
  project_dir = None
  root_qatools_config = {}
  subproject = Path(".")
else:
  if len(qatools_config_paths)==1:
    root_qatools = qatools_config_paths[0].parent
    project_dir = root_qatools
    root_qatools_config = qatools_configs[0]
  else:
    root_qatools, *_, project_dir = [c.parent for c in qatools_config_paths]
    root_qatools_config, *_ = qatools_configs
  subproject = project_dir.relative_to(root_qatools) if root_qatools else None

  # We check for consistency
  if root_qatools_config.get('project').get('url') != config.get('project').get('url'):
    config_has_error = True
    if not no_config_warning:
      click.secho(f"ERROR: Don't redefine the project's URL in ./qatools.yaml.", fg='red', bold=True, err=True)
      click.secho(f"Changed from {root_qatools_config['project']['url']} to {config['project']['url']}", fg='red')
      no_config_warning = True

  # We identify sub-qatools projects using the location of qatools.yaml related to the project root
  # It's not something the user should change...
  leaf_project_name = root_qatools_config['project']['name'] / subproject
  uncoherent_name = config['project']['name'] not in [root_qatools_config['project']['name'], leaf_project_name]
  if uncoherent_name:
    config_has_error = True
    if not no_config_warning:
      click.secho(f"ERROR: Don't redefine <project.name> in ./qatools.yaml", fg='red', bold=True, err=True)
      click.secho(f"Changed from {root_qatools_config['project']['name']} to {config['project']['name']})", fg='red')
      no_config_warning = True
  config['project']['name'] = leaf_project_name.as_posix()



# It's useful to know what's the platform since code is often compiled a different locations.
# For instance Linux builds are often at `build/bin/` vs `/x64/Release/` on Windows.
on_windows = os.name == 'nt'
on_linux = not on_windows
# SIRC-specific hosts
on_vdi = 'HOST' in os.environ and os.environ['HOST'].endswith("vdi")
on_lsf = 'HOST' in os.environ and (os.environ['HOST'].endswith("transchip.com") or os.environ['HOST'].startswith("planet"))

# Mounts and file paths are usually different on linux and windows
mount_flavor = 'windows' if on_windows else 'linux'


if on_windows:
    platform = 'windows'
else:
    # it could be "linux", but we stick to lsf for backward compatibility
    platform = 'lsf'



# Results are saved at a centralized location. This makes it easy to read results
# either from the web application, or for local bit-accuracy tests.
try:
    ci_root = config['ci_root'][mount_flavor]
except KeyError:
  config_has_error = True
  if not no_config_warning:
    click.secho(f'ERROR: Could not find the ci_root_directory, where results are saved, for {mount_flavor}', fg='red', err=True)
    click.secho(f'Consider adding to qatools.yaml:\n```\nci_root_directory:\n  linux: /net/stage/algo_data/ci\n  windows: "\\\\netapp\\algo_data\\ci"\n```', fg='red', err=True, dim=True)
    no_config_warning = True



ci_dir = Path(ci_root) / root_qatools_config['project']['name'] if root_qatools_config else None


repo_root = Path(os.environ.get('QATOOLS_REPO', str(root_qatools)))
is_in_git_repo = (repo_root / '.git').is_dir()


# This flag identifies runs that happen within the CI or tuning experiments
ci_env_variables = (
    # Set by most CI tools (GitlabCI, CircleCI, TravisCI...) except Jenkins,
    # and by the web application during tuning runs
    'CI',
    # set by Jenkins' git plugin
    'GIT_COMMIT',
)
is_ci = any([v in os.environ for v in ci_env_variables])

user = getenvs(('USERNAME', 'USER', 'HOSTNAME', 'HOST'))

if is_ci:
    commit_type = config.get('project', {}).get('type', 'git')
    # Different CI tools use different environment variables to tell us
    # what commit and branch we're running on
    commit_sha_variables = (
        'CI_COMMIT_SHA', # GitlabCI
        'GIT_COMMIT', # Jenkins, git plugin
        'CIRCLE_SHA1', # CircleCI
        'TRAVIS_COMMIT', # TravisCI
    )
    commit_id = getenvs(commit_sha_variables)

    branch_env_variables = (
        'CI_COMMIT_TAG', # GitlabCI, only when building tags
        'CI_COMMIT_REF_NAME', # GitlabCI
        'GIT_BRANCH', # Jenkins
        'gitlabBranch', # Jenkins gitlab plugin 
        'CIRCLE_BRANCH', # CircleCI
        'TRAVIS_BRANCH', # TravisCI
    )
    commit_branch = getenvs(branch_env_variables)
    if commit_branch:
      commit_branch = commit_branch.replace('origin/', '')
else:
    # we have no garantees about which version of the code we run on
    # with git we could check if the repo is dirty though
    commit_type = 'local'
    commit_branch = None
    commit_id = None


if not commit_id or not commit_branch:
    # using gitpython is very slow, so we read the git data directly
    if not is_in_git_repo:
      if not commit_branch:
        commit_branch = f'<local:{user}>'
      if not commit_id:
        commit_id = f'<local:{user}>'

    else:
      with (repo_root / '.git' / 'HEAD').open() as f:
        head_data = f.read().strip()
        if head_data.startswith('ref: refs/heads/'):
          commit_branch = head_data[16:]
        else:
          commit_branch = head_data
        refs_head_path = repo_root / '.git' / 'refs' / 'heads' / commit_branch
        if not refs_head_path.exists():
          commit_id = commit_branch
        else:
          with refs_head_path.open() as f:
            commit_id = f.read().strip()

try:
    branch_ci_dir = ci_dir / 'branches' / slugify(commit_branch)
except:
    branch_ci_dir = Path()



# This is where results should be saved
commit_rootproject_ci_dir = get_commit_ci_dir(ci_dir, commit_id)
commit_ci_dir = commit_rootproject_ci_dir / subproject if subproject else commit_rootproject_ci_dir

# When running qatools from a folder in which we saved a commit's artifacts,
# we don't have any information about the git commit we're looking at.
# Because of this, the web application that starts tuning runs will tell qatools what to
# by setting both the QATOOLS_CI_COMMIT_DIR and CI_COMMIT_SHA environment variables
if 'QATOOLS_CI_COMMIT_DIR' in os.environ:
    commit_ci_dir = Path(os.environ['QATOOLS_CI_COMMIT_DIR'])
    commit_rootproject_ci_dir = commit_ci_dir



# Lazy-evaluated gitpython objects for convenience
repo = _Repo(repo_root)
commit = _Commit(repo, commit_id)
# print(repo)
# print(list(repo.iter_commits(rev='refs/remotes/origin/master')))
# print(commit)
# print(commit.committer.email)
# print(commit.authored_datetime)

from .conventions import serialize_config
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
default_inputs_type = config_inputs_types.get('default', 'default')


def get_default_configuration(input_settings):
  default_configuration = input_settings.get('configurations', input_settings.get('configuration', "default"))
  if isinstance(default_configuration, list):
    default_configuration = serialize_config(default_configuration)
  return default_configuration

def get_default_database(input_settings):
  # All recordings used should be stored at the same location
  # We will refer to them by their relative path related to the "database"
  global no_config_warning
  database = input_settings.get('database', {}).get(mount_flavor)
  if not database:
    database = "."
    if not no_config_warning:
      click.secho(f'WARNING: Could not find the database location for {mount_flavor}, defaulting to "."', fg='yellow', err=True)
      click.secho(f'Consider adding to qatools.yaml:\n```\ninputs:\n  database:\n    linux: /net/stage/algo_data\n    windows: "\\\\netapp2\\algo_data"\n```', fg='yellow', err=True, dim=True)
      no_config_warning = True
  return Path(database)




metrics_file = config.get('outputs', {}).get('metrics')
if not metrics_file:
  _metrics = {}
  available_metrics = {}
  main_metrics = []
else:
    with Path(root_qatools / metrics_file).open('r') as f:
        _metrics = yaml.load(f, Loader=yaml.SafeLoader)
        available_metrics = _metrics['available_metrics']
        main_metrics = _metrics['main_metrics']
