"""
Whether qa's output to a stream gets colors. Standard library only: `qa` imports it when it starts.

CI logs are read in web views that render ANSI colors: we keep them in CI even when the output isn't a terminal,
with a sane width (rich uses 80 columns off a terminal), but never live redraws. $NO_COLOR (https://no-color.org) wins.
"""
import os
from typing import IO, Mapping, Optional

# Set by CI services: CI by most (GitLab CI, GitHub Actions, CircleCI, Travis...), the others by Jenkins, Azure Pipelines...
CI_VARIABLES = ('CI', 'GITLAB_CI', 'GITHUB_ACTIONS', 'JENKINS_URL', 'BUILD_ID', 'TF_BUILD', 'BUILDKITE', 'TEAMCITY_VERSION', 'BITBUCKET_BUILD_NUMBER')
CI_WIDTH = 160


def in_ci(env: Optional[Mapping[str, str]] = None) -> bool:
  env = os.environ if env is None else env
  return any(env.get(name) for name in CI_VARIABLES)


def is_terminal(stream: Optional[IO]) -> bool:
  try:
    return bool(stream is not None and stream.isatty())
  except (AttributeError, ValueError):
    return False


def colors(stream: Optional[IO], env: Optional[Mapping[str, str]] = None) -> bool:
  """
  Whether to write ANSI colors to `stream`: on a terminal, or in CI. Like qaboard/ui.py: never with $NO_COLOR or
  QA_COLOR=never, always with QA_COLOR=always, $FORCE_COLOR or $CLICOLOR_FORCE (not 0/false)
  """
  env = os.environ if env is None else env
  qa_color = env.get('QA_COLOR', '').strip().lower()
  if env.get('NO_COLOR') or qa_color in ('0', 'false', 'no', 'never', 'off'):
    return False
  if qa_color in ('1', 'true', 'yes', 'always', 'on'):
    return True
  if any(env.get(name) and env[name].strip().lower() not in ('0', 'false', 'no', 'never', 'off') for name in ('FORCE_COLOR', 'CLICOLOR_FORCE')):
    return True
  return is_terminal(stream) or in_ci(env)


def width(stream: Optional[IO], env: Optional[Mapping[str, str]] = None) -> Optional[int]:
  """The width for rich: its own on a terminal (None), $COLUMNS, else CI_WIDTH in CI"""
  env = os.environ if env is None else env
  if is_terminal(stream):
    return None
  columns = env.get('COLUMNS', '')
  if columns.isdigit() and int(columns) > 0:
    return int(columns)
  return CI_WIDTH if in_ci(env) else None
