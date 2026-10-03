"""
Initialize a QA-Board project
```
qa init
```
"""
from pathlib import Path
from typing import Any, Dict, List, Tuple
import subprocess
import shutil

import click
import yaml

from .config import find_configs
from .site_config import site_qaboard_config, site_qaboard_config_path, LOCATION_KEYS


Key = Tuple[str, ...]

def shadowed_keys(sample: Dict[str, Any], site: Dict[str, Any], prefix: Key = ()) -> List[Key]:
  """
  Keys in the sample configuration that would override the site defaults.
  Lists are kept: they are usually project-specific, and can extend the site's with "super".
  """
  keys = []
  for key, site_value in site.items():
    if key not in sample or isinstance(sample[key], list):
      continue
    sample_value = sample[key]
    is_location = (*prefix, key) in LOCATION_KEYS
    if isinstance(site_value, dict) and isinstance(sample_value, dict) and not is_location:
      sub_keys = shadowed_keys(sample_value, site_value, (*prefix, key))
      # if the whole section would be overriden, we remove it
      if sample_value and set(sub_keys) == {(*prefix, key, k) for k in sample_value}:
        keys.append((*prefix, key))
      else:
        keys.extend(sub_keys)
    else:
      keys.append((*prefix, key))
  return keys


def last_line(node: yaml.Node) -> int:
  """Last line containing a value in a YAML node - ignoring trailing comments."""
  if isinstance(node, yaml.MappingNode):
    return max(last_line(n) for kv in node.value for n in kv) if node.value else node.end_mark.line
  if isinstance(node, yaml.SequenceNode):
    return max(last_line(n) for n in node.value) if node.value else node.end_mark.line
  # block scalars end at the start of the next line
  return node.end_mark.line - 1 if node.end_mark.column == 0 and node.end_mark.line > node.start_mark.line else node.end_mark.line


def use_site_defaults(sample_config: str, site: Dict[str, Any]) -> str:
  """
  Comment-out the sample configuration's settings that would override the site defaults,
  and show instead the values inherited from the site.
  """
  sample = yaml.load(sample_config, Loader=yaml.SafeLoader) or {}
  root = yaml.compose(sample_config)
  lines = sample_config.splitlines()
  replacements = []
  for key in shadowed_keys(sample, site):
    node, site_value = root, site
    for k in key:
      key_node, node = next((kn, vn) for kn, vn in node.value if kn.value == k)
      site_value = site_value[k]
    indent = " " * key_node.start_mark.column
    site_yaml = yaml.safe_dump({key[-1]: site_value}, default_flow_style=False, sort_keys=False)
    comment = [f"{indent}# Inherited from the site defaults, override if needed:"]
    comment += [f"{indent}# {l}" for l in site_yaml.splitlines()]
    replacements.append((key_node.start_mark.line, last_line(node), comment))
  for start, end, comment in sorted(replacements, reverse=True):
    lines[start:end+1] = comment
  header = [
    "# This configuration is merged on top of the site defaults (QABOARD_SITE_CONFIG, installed by your site package).",
    "# Settings defined here take precedence.",
  ]
  return "\n".join([*header, *lines]) + "\n"



def qa_init(ctx):
  """Initialize a qatools repository"""
  config_paths = [p for  _, p in find_configs(Path('.'))]
  if config_paths:
    click.secho(f'You already have a qaboard.yaml configuration:', fg='green', bold=True, err=True)
    for p in config_paths:
      click.secho(str(p), fg='green')
    exit(0)

  # Locate the sample project's configuration
  qatools_dir = Path(__file__).resolve().parent

  click.secho('Creating a `qatools` configuration based on the sample project 🎉', fg='green')
  sample_config = (qatools_dir / 'sample_project/qaboard.yaml').read_text()
  site = site_qaboard_config()
  if site:
    click.secho(f'Using the site defaults from {site_qaboard_config_path()} for: {", ".join(site)}', fg='green')
    sample_config = use_site_defaults(sample_config, site)
  if not ctx.obj['dryrun']:
    Path('qaboard.yaml').write_text(sample_config)

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
  except Exception:
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
    except Exception:
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
  except Exception:
    click.secho('Please edit qaboard.yaml with your project name and url ', fg='yellow')
