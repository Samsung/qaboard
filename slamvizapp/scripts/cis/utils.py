"""
Useful utilities to import data from the CIS CI
"""
import re
from datetime import datetime
from pathlib import Path

# https://docs.python.org/3/howto/regex.html
date = '(?P<date>\d{4}_\d{2}_\d{2})'
version = '(?P<version>.*)'
time_hm = '(?P<hm>\d{2}_\d{2})?'
time_hms = '(?P<hms>\d{2}_\d{2}_\d{2})?'
re_ci_dir = re.compile(f'{date}_*{time_hms}{time_hm}_+{version}')
# print(re_ci_dir)

def parse_ci_dir(directory):
  """Returns a dict with info on a CI directory if the directory looks like one, None otherwise."""
  match = re_ci_dir.match(str(directory.name))
  if not match: return None
  m = match.groupdict()
  output = {
    'version': m['version'],
    'path': directory,
  }
  # we clean some people's mistakes :)
  date = m['date'].replace('00_00', '01_01')
  if m['hms']:
    output['authored_datetime'] = datetime.strptime(f"{date}_{m['hms']}", '%Y_%m_%d_%H_%M_%S')
  elif m['hm']:
    output['authored_datetime'] = datetime.strptime(f"{date}_{m['hm']}", '%Y_%m_%d_%H_%M')
  else:
    output['authored_datetime'] = datetime.strptime(date, '%Y_%m_%d')
  return output



# let's avoid crawling those
# TODO: avoid unreadable directories
forbiden_paths = re.compile('\.snapshot')

def ci_dirs(path, max_depth=1):
  """Yields dicts with info on CIS CI directories up to max_depth, depth first"""
  for p in path.iterdir():
    if not p.is_dir(): continue
    if forbiden_paths.match(p.name): continue
    ci_dir_info = parse_ci_dir(p)
    if ci_dir_info:
      yield ci_dir_info
    elif max_depth>0 and p.is_dir():
      yield from ci_dirs(p, max_depth-1)
     
    
      
sep = '([/ _]|$|^)'
# "continuous integration" is not really part of the project  name
ci_pattern = f'Continu?ous{sep}?(Integration)?'
# we also remove common variations
ci_variations = '|'.join([
  'CI',
  'res',
  'Results',
  'Benchm?arks?',
  'tmp',
  'MatlabLSF',
  'Share',
  'output',
  'First',
  'Test_?Case',
  'MyCDE',
  'Configurations',
  'tuning',
])
re_continuous_integration = re.compile(
  f'({sep}({ci_variations}){sep}|{ci_pattern})',
  re.IGNORECASE,
)
re_clean = re.compile('_$')
# print(re_continuous_integration)

def parse_project_path(path):
  """Returns (author, project)"""
  path_clean = re_continuous_integration.sub('', str(path))
  path_clean = path_clean.replace('//', '/')
  path_split = path_clean.split('/', maxsplit=1)
  if len(path_split)==1: return '<unknown>', path_split[0]
  author, project = path_split
  project = re_clean.sub('', project)
  if len(project)==0:
    author, project = '<unknown>', author
  return author, project


