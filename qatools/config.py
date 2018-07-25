"""
Provides a default QA configuration for the projects, by reading the configuration file and the environment variables.
"""
import os
import sys
import yaml
from pathlib import Path, PurePosixPath

import click

verbose = os.getenv('QATOOLS_VERBOSE', False)


# The `init` command is implemented here to avoid lots of try/catch or fake values in the import
if sys.argv[1] == 'init':
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
  shutil.copy(str(qatools_dir/'sample_project/qatools.yaml'), 'qatools.yaml')
  click.secho('...added qatools.yaml', fg='green', dim=True)
  shutil.copytree(str(qatools_dir/'sample_project/qatools'), 'qatools')
  click.secho('...added qatools/', fg='green', dim=True)
  click.secho(
    'If you need help configuring qatools. please read the tutorial, and ask @arthurf for help\n'
    'http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial',
    fg='blue'
  )
  exit(0)



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



try:
    with Path('qatools.yaml').open('r') as f:
        config = yaml.load(f)
        if verbose: click.secho(str(config), dim=True)
except FileNotFoundError:
    click.secho('ERROR: Could not find the `qatools.yaml` configuration file.\nDid you run `qatools init` ?', fg='red', err=True)
    click.secho(
        'Please read the tutorial, and ask @arthurf for help\n'
        'http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial',
        dim=True, err=True)
    exit(1)
except:
    click.secho('ERROR: Could not parse the configuration file `qatools.yaml`.', fg='red', err=True)
    exit(1)


# All recordings used should be stored at the same location
# We will refer to them by their relative path related to the "database"
try:    
    database = config['inputs']['database'][mount_flavor]
except KeyError:
    click.secho(f'ERROR: Could not find the database location for {mount_flavor}', fg='red', err=True)
    exit(1)
database = Path(database)


# This flag identifies runs that happen within the CI or tuning experiments
# Those use artifacts, that may be at a different location than when building locally
ci_env_variables = [
    # set for tuning runs
    'QATOOlS_CI_COMMIT_DIR',
    # set by GitlabCI
    'CI_COMMIT_SHA',
    # set by Jenkins' git plugin
    'GIT_COMMIT',
]
is_ci = any([v in os.environ for v in ci_env_variables])


# bit-accuracy tests need data from previous commits
try:    
    ci_root = config['ci_root'][mount_flavor]
except KeyError:
    click.secho(f'ERROR: Could not find the ci_root_directory, where results are saved, for {mount_flavor}', fg='red', err=True)
    exit(1)
ci_dir = Path(ci_root) / config['project']['name']



if 'QATOOLS_CI_COMMIT_DIR' in os.environ:
    commit_ci_dir = os.environ['QATOOLS_CI_COMMIT_DIR']
else:
    import git
    try:
        try:
            repo = git.Repo('.')
        except: # just to make `qa` work in the sample_project
            repo = git.Repo('..')
        commit = repo.head.commit
        commit_ci_dir = ci_dir / 'commits' / f'{commit.authored_date}__git__{commit.hexsha[:8]}'
    except:
        commit_ci_dir = None
        commit = None
        repo = None

if verbose:
    click.secho(f'platform: {platform}', dim=True)
    click.secho(f'database: {database}', dim=True)
    click.secho(f'is_ci: {is_ci}', dim=True)
    click.secho(f'commit_ci_dir: {commit_ci_dir}', dim=True)

# We need to identify the version of the code we run on, and which branch
if is_ci:
    # We rely on the CI to provide us `CI_COMMIT_SHA` and `CI_COMMIT_REF_NAME`
    commit_type = config['project']['type']
    # CI_*/GIT_* variables are set by GitlabCI/JenkinsGit
    commit_id = os.getenv('CI_COMMIT_SHA', os.getenv('GIT_COMMIT', Path().resolve().name ))
    commit_branch = os.getenv('CI_COMMIT_REF_NAME', os.getenv('GIT_BRANCH'))
else:
    # we have no garantees about which version of the code we run on
    # with git we could check if the repo is dirty though
    commit_type = 'local'
    commit_id = '<local>'
    user = os.getenv('USERNAME', os.environ.get('USER'))
    commit_branch = f'<local:{user}>'

if verbose:
    click.secho(f'commit_type: {commit_type}', dim=True)
    click.secho(f'commit_id: {commit_id}', dim=True)
    click.secho(f'commit_branch: {commit_branch}', dim=True)
