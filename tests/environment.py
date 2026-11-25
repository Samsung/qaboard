"""
The environment of `qa` as people run it on their laptops, without the CI that runs the tests: tests that need a CI
set its variables. Leftover CI variables change what `qa` does: GITLAB_CI colors stderr (qaboard/terminal.py) and
makes GitLab the run's CI provider (qaboard/config.py), and FORCE_COLOR/NO_COLOR decide the colors.
"""
import os
from collections.abc import Iterable, Mapping

from qaboard.config import ci_env_variables, ci_providers
from qaboard.terminal import CI_VARIABLES

CI_AND_COLORS = frozenset({*ci_env_variables, *CI_VARIABLES, *(name for _, name in ci_providers),
                           'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE', 'QA_COLOR'})


def outside_ci(prefixes: Iterable[str] = ('QA', 'CI_', 'GITHUB_'), keep: Iterable[str] = (),
               environ: Mapping[str, str] | None = None) -> dict[str, str]:
  """A copy of the environment without the CI's variables, the color settings, and the variables with these prefixes"""
  environ = os.environ if environ is None else environ
  prefixes, keep = tuple(prefixes), set(keep)
  return {k: v for k, v in environ.items() if k in keep or not (k in CI_AND_COLORS or (prefixes and k.startswith(prefixes)))}
