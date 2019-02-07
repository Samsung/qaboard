"""
Provides a default QA configuration for the projects, by reading the configuration file and the environment variables.
"""
import os
import sys
from pathlib import Path, PurePosixPath

import yaml
import git
import click

from .utils import getenvs
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
)
def renamed_deprecated(arg):
  for before, after in renamings:
    if arg == before: return after
  return arg
sys.argv = [renamed_deprecated(arg) for arg in sys.argv]




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
            qatools_config = yaml.load(f)
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


qatools_configs, qatools_config_paths = find_qatools_configs(path=Path())
if not qatools_configs:
    click.secho('ERROR: Could not find a `qatools.yaml` configuration file.\nDid you run `qatools init` ?', fg='red', err=True)
    click.secho(
        'Please read the tutorial, and ask @arthurf for help\n'
        'http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial',
        dim=True, err=True)
    config_has_error = True


def merge(configs):
    """Merge qatools configurations 2-level deep"""
    config = {}
    for c in configs:
        for key, value in c.items():
          if isinstance(value, dict):
              node = config.setdefault(key, {})
              node.update(value)
          elif value is not None:
              config[key] = value
    return config


config = merge(qatools_configs)

# The top-most qatools.yaml is the root project
# The current subproject corresponds to the lowest qatools.yaml
if not qatools_config_paths:
  root_qatools = None
  leaf_qatools = None
  root_qatools_config = {}
  subproject = Path(".")
else:
  if len(qatools_config_paths)==1:
    root_qatools = qatools_config_paths[0].parent
    leaf_qatools = root_qatools
    root_qatools_config = qatools_configs[0]
  else:
    root_qatools, *_, leaf_qatools = [c.parent for c in qatools_config_paths]
    root_qatools_config, *_ = qatools_configs
  subproject = leaf_qatools.relative_to(root_qatools) if root_qatools else None

  # We check for consistency
  if root_qatools_config.get('project').get('url') != config.get('project').get('url'):
      click.secho(f"ERROR: Don't redefine the project's URL in ./qatools.yaml.", fg='red', bold=True, err=True)
      click.secho(f"Changed from {root_qatools_config['project']['url']} to {config['project']['url']}", fg='red')
      config_has_error = True

  # We identify sub-qatools projects using the location of qatools.yaml related to the project root
  # It's not something the user should change...
  leaf_project_name = root_qatools_config['project']['name'] / subproject
  uncoherent_name = config['project']['name'] not in [root_qatools_config['project']['name'], leaf_project_name]
  if uncoherent_name:
      click.secho(f"ERROR: Don't redefine <project.name> in ./qatools.yaml", fg='red', bold=True, err=True)
      click.secho(f"Changed from {root_qatools_config['project']['name']} to {config['project']['name']})", fg='red')
      config_has_error = True
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
elif on_vdi or on_lsf:
    platform = 'lsf'
else: # unknown linux
    platform = 'linux'

# All recordings used should be stored at the same location
# We will refer to them by their relative path related to the "database"
database = config.get('inputs', {}).get('database', {}).get(mount_flavor)
if not database:
    click.secho(f'WARNING: Could not find the database location for {mount_flavor}, defaulting to "."', fg='yellow', err=True)
    click.secho(f'Consider adding to qatools.yaml:\n```\ninputs:\n  database:\n    linux: /net/stage/algo_data\n    windows: "\\\\netapp2\\algo_data"\n```', fg='yellow', err=True, dim=True)
    database = "."
database = Path(database)




# Results are saved at a centralized location. This makes it easy to read results
# either from the web application, or for local bit-accuracy tests.
try:
    ci_root = config['ci_root'][mount_flavor]
except KeyError:
    click.secho(f'ERROR: Could not find the ci_root_directory, where results are saved, for {mount_flavor}', fg='red', err=True)
    click.secho(f'Consider adding to qatools.yaml:\n```\nci_root_directory:\n  linux: /net/stage/algo_data/ci\n  windows: "\\\\netapp\\algo_data\\ci"\n```', fg='red', err=True, dim=True)
    config_has_error = True



ci_dir = Path(ci_root) / root_qatools_config['project']['name'] if root_qatools_config else None


# Make the git metadata easily accessible
try:
    repo = git.Repo(str(root_qatools))
    commit = repo.head.commit
except:
    repo = None
    commit = None



# This is where results should be saved
if repo and commit:
    commit_rootproject_ci_dir = get_commit_ci_dir(ci_dir, commit)
    commit_ci_dir = commit_rootproject_ci_dir / subproject if subproject else commit_rootproject_ci_dir
else:
    commit_rootproject_ci_dir = Path()
    commit_ci_dir = Path()
# When running qatools from a folder in which we saved a commit's artifacts,
# we don't have any information about the git commit we're looking at.
# Because of this, the web application that starts tuning runs will tell qatools what to
# by setting both the QATOOLS_CI_COMMIT_DIR and CI_COMMIT_SHA environment variables
if 'QATOOLS_CI_COMMIT_DIR' in os.environ:
    commit_ci_dir = Path(os.environ['QATOOLS_CI_COMMIT_DIR'])
    commit_rootproject_ci_dir = commit_ci_dir




# This flag identifies runs that happen within the CI or tuning experiments
ci_env_variables = (
    # Set by most CI tools (GitlabCI, CircleCI, TravisCI...) except Jenkins,
    # and by the web application during tuning runs
    'CI',
    # set by Jenkins' git plugin
    'GIT_COMMIT',
)
is_ci = any([v in os.environ for v in ci_env_variables])

user = getenvs(('USERNAME', 'USER'))

if is_ci:
    commit_type = config.get('project', {}).get('type', 'git')
    # Different CI tools use different environment variables to tell us
    # what commit and branch we're running on
    commit_sha_variables = (
        'CI_COMMIT_SHA', # GitlabCI 
        'GIT_COMMIT', # Jenkins
        'CIRCLE_SHA1', # CircleCI
        'TRAVIS_COMMIT', # TravisCI
    )
    commit_id = getenvs(commit_sha_variables, Path().resolve().name)
    branch_env_variables = (
        'CI_COMMIT_REF_NAME', # GitlabCI
        'GIT_BRANCH', # Jenkins
        'CIRCLE_BRANCH', # CircleCI
        'TRAVIS_BRANCH', # TravisCI
    )
    commit_branch = getenvs(branch_env_variables, '').replace('origin/', '')
else:
    # we have no garantees about which version of the code we run on
    # with git we could check if the repo is dirty though
    commit_type = 'local'
    commit_id = commit.hexsha if commit else f'<local:{user}>'
    try:
      commit_branch = repo.head.reference.name if repo else f'<local:{user}>'
    except:
      commit_branch = f'<local:{user}>'
try:
    branch_ci_dir = ci_dir / 'branches' / slugify(commit_branch)
except:
    branch_ci_dir = Path()




metrics_file = config.get('outputs', {}).get('metrics')
if not metrics_file:
  _metrics = {}
  available_metrics = {}
  main_metrics = []
else:
    with Path(root_qatools / metrics_file).open('r') as f:
        _metrics = yaml.load(f)
        available_metrics = _metrics['available_metrics']
        main_metrics = _metrics['main_metrics']
