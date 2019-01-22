"""
Provides a default QA configuration for the projects, by reading the configuration file and the environment variables.
"""
import os
import sys
import yaml
from pathlib import Path, PurePosixPath

import click

verbose = os.getenv('QATOOLS_VERBOSE', False)
config_has_error = False


# The `init` command is implemented here to avoid lots of try/catch or fake values in the import
if len(sys.argv)>1 and sys.argv[1] == 'init':
  if Path('qatools.yaml').exists():
    click.secho('You already have a qatools.yaml configuration.', fg='green')
    exit(0)
  import shutil
  try: # fast, available from python3.7
    from importlib import resources
    with resources.path('qatools', '') as qatools_dir:
      pass
  except:
      import pkg_resources
      qatools_dir = Path(pkg_resources.resource_filename('qatools', ''))
  click.secho('Creating a `qatools` configuration based on the sample project 🎉', fg='green')
  shutil.copy(str(qatools_dir / 'sample_project/qatools.yaml'), 'qatools.yaml')
  click.secho('...added qatools.yaml', fg='green', dim=True)
  shutil.copytree(str(qatools_dir/'sample_project/qatools'), 'qatools')
  click.secho('...added qatools/', fg='green', dim=True)
  click.secho(
    'If you need help configuring qatools. please read the tutorial, and ask @arthurf for help\n'
    'http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial',
    fg='blue'
  )
  exit(0)




def find_qatools_configs(path):
    """Returns the parsed content and paths of qatools.yaml files that should be loaded for this (sub)project.
    Returns a tuple (configs, paths), each element is a list with the root qatools.yaml is first and the subproject's last.
    """
    qatools_configs = []
    qatools_config_paths = []
    # we need a full path to iterate on the parents
    path = path.resolve()
    # We look for qatools.yaml configuration files in the path folder and its parents
    parents = [path, *list(path.parents)]
    for parent in parents:
        qatools_config_path = parent / 'qatools.yaml'
        if not qatools_config_path.exists(): continue
        if verbose: click.secho(f"loading {qatools_config_path}", fg='blue')
        with qatools_config_path.open('r') as f:
            qatools_config = yaml.load(f)
            qatools_configs.append(qatools_config)
            qatools_config_paths.append(qatools_config_path)
            if qatools_config.get('root'): break
    qatools_configs.reverse() 
    qatools_config_paths.reverse()
    return qatools_configs, qatools_config_paths


qatools_configs, qatools_config_paths = find_qatools_configs(path=Path())
if not qatools_configs:
    click.secho('ERROR: Could not find a `qatools.yaml` configuration file.\nDid you run `qatools init` ?', fg='red', err=True)
    click.secho(
        'Please read the tutorial, and ask @arthurf for help\n'
        'http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial',
        dim=True, err=True)
    config_has_error = True

def merge(qatools_configs):
    """Merge qatools configurations 2-level deep"""
    config = {}
    for c in qatools_configs:
        for key, value in c.items():
          if isinstance(value, dict):
              node = config.setdefault(key, {})
              node.update(value)
          elif value is not None:
              config[key] = value
    return config
  
config = merge(qatools_configs)
if verbose:
    for k, v in config.items():
      click.secho(f"{k}: {v}", dim=True, err=True)

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


# It's useful to know what's the platform since code is often compiled a different locations
# For instance build/bin/ vs /x64/Release/
on_windows = os.name == 'nt'
on_linux = not on_windows
on_vdi = 'HOST' in os.environ and os.environ['HOST'].endswith("vdi")
on_lsf = 'HOST' in os.environ and (os.environ['HOST'].endswith("transchip.com") or os.environ['HOST'].startswith("planet"))

# mounts and file paths are usually different on linux and windows
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


# This flag identifies runs that happen within the CI or tuning experiments
# Those use artifacts, that may be at a different location than when building locally
ci_env_variables = [
    # set by GitlabCI
    'CI_COMMIT_SHA',
    # set by Jenkins' git plugin
    'GIT_COMMIT',
    # set for tuning runs
    'QATOOLS_CI_COMMIT_DIR',
]
is_ci = any([v in os.environ for v in ci_env_variables])


# bit-accuracy tests need data from previous commits
try:
    ci_root = config['ci_root'][mount_flavor]
except KeyError:
    click.secho(f'ERROR: Could not find the ci_root_directory, where results are saved, for {mount_flavor}', fg='red', err=True)
    click.secho(f'Consider adding to qatools.yaml:\n```\nci_root_directory:\n  linux: /net/stage/algo_data/ci\n  windows: "\\\\netapp\\algo_data\\ci"\n```', fg='red', err=True, dim=True)
    config_has_error = True

ci_dir = Path(ci_root) / root_qatools_config['project']['name'] if root_qatools_config else None

# we find were we should save our results
if 'QATOOLS_CI_COMMIT_DIR' in os.environ:
    commit_ci_dirname = None
    commit_ci_dir = Path(os.environ['QATOOLS_CI_COMMIT_DIR'])
    commit_rootproject_ci_dir = commit_ci_dir
    commit = None
    repo = None
else:
    # if not (root_qatools / '.git').exists():
    #     click.secho(f"ERROR: qatools.yaml should be located at the root of the git repository, at {root_qatools}.", fg='red')
    #     config_has_error = True

    import git
    try:
        repo = git.Repo(str(root_qatools))
        commit = repo.head.commit
        commit_ci_dirname = f'{commit.authored_date}__{commit.author.name.replace(".","")}__{commit.hexsha[:8]}'
        commit_rootproject_ci_dir = ci_dir / 'commits' / commit_ci_dirname
        if subproject:
            commit_ci_dir = commit_rootproject_ci_dir / subproject
        else:
            commit_rootproject_ci_dir
    except:
        commit_ci_dirname = None
        commit_rootproject_ci_dir = Path()
        commit_ci_dir = Path()
        commit = None
        repo = None

if verbose:
    click.secho(f'platform: {platform}', dim=True, err=True)
    click.secho(f'database: {database}', dim=True, err=True)
    click.secho(f'is_ci: {is_ci}', dim=True, err=True)
    click.secho(f'commit_ci_dir: {commit_ci_dir}', dim=True, err=True)

# We need to identify the version of the code we run on, and which branch
if is_ci:
    # We rely on the CI to provide us `CI_COMMIT_SHA` and `CI_COMMIT_REF_NAME`
    commit_type = config['project']['type']
    # CI_*/GIT_* variables are set by GitlabCI/JenkinsGit
    commit_id = os.getenv('CI_COMMIT_SHA', os.getenv('GIT_COMMIT', Path().resolve().name ))
    commit_branch = os.getenv('CI_COMMIT_REF_NAME', os.getenv('GIT_BRANCH', '').replace('origin/', ''))
    reference_slug = os.getenv('CI_COMMIT_REF_SLUG', os.getenv('GIT_BRANCH', '').replace('origin/', '').replace('/', '-'))
    try:
        branch_ci_dir = ci_dir / 'branches' / reference_slug
    except:
        branch_ci_dir = Path()
else:
    # we have no garantees about which version of the code we run on
    # with git we could check if the repo is dirty though
    commit_type = 'local'
    commit_id = '<local>'
    user = os.getenv('USERNAME', os.environ.get('USER'))
    commit_branch = f'<local:{user}>'
    branch_ci_dir = Path()

if verbose:
    click.secho(f'commit_type: {commit_type}', dim=True, err=True)
    click.secho(f'commit_id: {commit_id}', dim=True, err=True)
    click.secho(f'commit_branch: {commit_branch}', dim=True, err=True)


try:
    with Path(config['outputs']['metrics']).open('r') as f:
        _metrics = yaml.load(f)
        available_metrics = _metrics['available_metrics']
        main_metrics = _metrics['main_metrics']
except:
    _metrics = {}
    available_metrics = {}
    main_metrics = []
