"""
Initialize a QA-Board project
```
qa init
```
"""
from pathlib import Path
import subprocess
import shutil

import click

from .config import find_configs




def qa_init(ctx):
  """Initialize a qatools repository"""
  config_paths = [p for  _, p in find_configs(Path('.'))]
  if config_paths:
    click.secho(f'You already have a qaboard.yaml configuration:', fg='green', bold=True, err=True)
    for p in config_paths:
      click.secho(str(p), fg='green')
    exit(0)

  # Locate the sample project's configuration
  try: # fast, available from python3.7
    from importlib import resources
    with resources.path('qa', '') as qatools_dir:
      pass
  except:
      import pkg_resources
      qatools_dir = Path(pkg_resources.resource_filename('qaboard', ''))

  click.secho('Creating a `qatools` configuration based on the sample project 🎉', fg='green')
  if not ctx.obj['dryrun']:
    shutil.copy(str(qatools_dir / 'sample_project/qaboard.yaml'), 'qaboard.yaml')

  click.secho('...added qaboard.yaml', fg='green', dim=True)
  if not ctx.obj['dryrun']:
    shutil.copytree(str(qatools_dir/'sample_project/qa'), 'qa')

  click.secho('...added qa/', fg='green', dim=True)
  click.secho(
    'If you need help configuring qatools. please read the tutorial at https://samsung.github.io/qaboard\n',
    fg='blue'
  )

  # We try to tweak the sample configuration much as possible
  try:
    subprocess.run("git rev-parse --is-inside-work-tree", shell=True, stdout=subprocess.PIPE, check=True)
  except:
    click.secho('Warning: Could not find a git repository', fg='yellow')
    exit(0)


  try:
    p = subprocess.run("git remote show", stdout=subprocess.PIPE, shell=True, check=True, encoding='utf-8')
    remotes = p.stdout.strip().splitlines()
    assert remotes
    if len(remotes)>1:
      print(f"We use the first of the git remotes: {remotes}")
    remote = remotes[0]
    print(f"git remote name: {remote}")

    p = subprocess.run(f"git remote get-url {remote}", shell=True, stdout=subprocess.PIPE, check=True, encoding='utf-8')
    url = p.stdout.strip()
    print(f"git remote url: {url}")
    if url.startswith('git'):
      name = url.split(':')[-1].replace('.git', '')
    else:
      name =  '/'.join(url.split('/')[3:]).replace('.git', '')
    print(f"project name: {name}")

    p = subprocess.run(f"git remote show {remote}", stdout=subprocess.PIPE, shell=True, check=True, encoding='utf-8')
    head_info = [l for l in p.stdout.strip().splitlines() if 'HEAD branch:' in l]
    reference_branch = head_info[0].split(':')[1]
    try:
      p = subprocess.run(f"git remote show {remote}", stdout=subprocess.PIPE, shell=True, check=True, encoding='utf-8')
      head_info = [l for l in p.stdout.strip().splitlines() if 'HEAD branch:' in l]
      reference_branch = head_info[0].split(':')[1]
    except:
      click.secho('Warning: Could not find the remote HEAD, using master as reference branch', fg='yellow')
      reference_branch = 'master'
    print(f"reference_branch: {reference_branch}")

    config = Path('qaboard.yaml')
    with config.open() as f:
      config_content = f.read()
    config_content = config_content.replace('name: user/sample_project', f"name: {name}")
    config_content = config_content.replace('url: git@github.com/user/sample_project', f"url: {url}")
    config_content = config_content.replace('reference_branch: master', f'reference_branch: {reference_branch}')
    with config.open('w') as f:
      if not ctx.obj['dryrun']:
        f.write(config_content)
  except:
    click.secho('Please edit qaboard.yaml with your project name and url ', fg='yellow')
