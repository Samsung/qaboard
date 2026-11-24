"""
Whether qa's output to a stream gets colors. Standard library only: `qa` imports it when it starts.

CI logs are read in web views that render ANSI colors: we keep them in CI even when the output isn't a terminal,
with a sane width (rich uses 80 columns off a terminal), but never live redraws. $NO_COLOR (https://no-color.org) wins.
"""
import os
from typing import IO, Mapping, Optional

# Set by CI services: CI by most (GitLab CI, GitHub Actions, CircleCI, Travis...), the others by Jenkins, Azure Pipelines...
CI_VARIABLES = ('CI', 'GITLAB_CI', 'GITHUB_ACTIONS', 'JENKINS_URL', 'TF_BUILD', 'BUILDKITE', 'TEAMCITY_VERSION', 'BITBUCKET_BUILD_NUMBER')
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
  """Whether to write ANSI colors to `stream`: on a terminal, or in CI. Not with $NO_COLOR"""
  env = os.environ if env is None else env
  if 'NO_COLOR' in env and env['NO_COLOR'] != '':
    return False
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
