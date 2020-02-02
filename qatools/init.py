"""
Initialize a qatools repository
```
qa init
```
"""
from pathlib import Path
import shutil

import git
import click

from .config import find_qatools_configs



def find_repo(path):
    path = path.resolve()
    parents = [path, *list(path.parents)]
    for parent in parents:
      try:
        return git.Repo(str(parent))
      except:
        pass
    return None


def qa_init():
  """Initialize a qatools repository"""
  _, qatools_config_paths = find_qatools_configs(Path('.'))
  if qatools_config_paths:
    click.secho(f'You already have a qatools.yaml configuration:', fg='green', bold=True, err=True)
    for p in qatools_config_paths:
      click.secho(str(p), fg='green')
    exit(0)

  # Locate the sample project's configuration
  try: # fast, available from python3.7
    from importlib import resources
    with resources.path('qa', '') as qatools_dir:
      pass
  except:
      import pkg_resources
      qatools_dir = Path(pkg_resources.resource_filename('qatools', ''))

  click.secho('Creating a `qatools` configuration based on the sample project 🎉', fg='green')
  shutil.copy(str(qatools_dir / 'sample_project/qatools.yaml'), 'qatools.yaml')

  click.secho('...added qatools.yaml', fg='green', dim=True)
  shutil.copytree(str(qatools_dir/'sample_project/qa'), 'qa')

  click.secho('...added qa/', fg='green', dim=True)
  click.secho(
    'If you need help configuring qatools. please read the tutorial at http://qa-docs/ or @arthurf for help\n',
    fg='blue'
  )

  # We try to tweak the sample configuration much as possible
  repo = find_repo(Path('.'))
  if not repo:
    click.secho('Warning: could not find a git repository', fg='yellow')
  else:
    try:
      remote = repo.remote()
      url = list(remote.urls)[0] #FIXME: preference for "origin"
      if url.startswith('git'):
        name = url.split(':')[-1].replace('.git', '')
      else:
        name =  '/'.join(url.split('/')[3:]).replace('.git', '')
      reference_branch = remote.refs.HEAD.reference.name.replace('origin/', '')
      config = Path('qatools.yaml')
      with config.open() as f:
        config_content = f.read()
      config_content = config_content.replace('name: my_group/sample_project', f"name: {name}")
      config_content = config_content.replace('url: git@gitlab-srv/my_group/sample_project', f"url: {url}")
      config_content = config_content.replace('reference_branch: master', f'reference_branch: {reference_branch}')
      # Write the file out again
      with config.open('w') as f:
        f.write(config_content)
    except:
      click.secho('Please edit qatools.yaml with your project name and url ', fg='yellow')


  exit(0)

