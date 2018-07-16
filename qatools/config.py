"""
Provides a default QA configuration for the projects, by reading the configuration file and the environment variables.
"""
import os
import sys
import yaml
from pathlib import Path, PurePosixPath

import click

verbose = os.getenv('QATOOLS_VERBOSE', False)

try:
    with Path('qatools.yaml').open('r') as f:
        config = yaml.load(f)
        if verbose: click.secho(str(config), dim=True)
except:
    click.secho('ERROR: Could not find the `qatools.yml` configuration file.', fg='red', err=True)
    click.secho(
        'Please read the tutorial, and ask @arthurf for help\n'
        'http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial',
        dim=True, err=True)
    exit(1)


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

# This flag identifies runs that happen within the CI or tuning experiments
# Those use artifacts, that may be at a different location than when building locally
ci_env_variables = [
    # set by the qatools's on_lsf
    'SAMSUNG_CI_COMMIT_DIR',
    # set by GitlabCI
    'CI_COMMIT_SHA',
    # set by Jenkins' git plugin
    'GIT_COMMIT',
]
is_ci = any([v in os.environ for v in ci_env_variables])

# All recordings used should be stored at the same location
# We will refer to them by their relative path related to the "database"
try:    
    database = config['inputs']['database'][mount_flavor]
except KeyError:
    click.secho(f'ERROR: Could not find the database location for {mount_flavor}', fg='red', err=True)
    exit(1)
database = Path(database)

# bit-accuracy tests need data from previous commits
try:    
    ci_root = config['ci_root'][mount_flavor]
except KeyError:
    click.secho(f'ERROR: Could not find the ci_root_directory, where results are saved, for {mount_flavor}', fg='red', err=True)
    exit(1)
ci_root = Path(ci_root) / config['project']['name']


if verbose:
    click.secho(f'platform: {platform}', dim=True)
    click.secho(f'database: {database}', dim=True)
    click.secho(f'is_ci: {is_ci}', dim=True)
    click.secho(f'ci results: {ci_root}', dim=True)

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
