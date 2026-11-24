"""
For qaboard's own tests: forgets what `qa` and start_run() keep for the whole process.

The tests run `qa` and start runs in one process, in any order (.github/scripts/shuffled_tests.py). What a run keeps
in a module-level variable (the run's reporter, what was said once, a refusal...) would change how the next test's
run behaves. Each such variable has a comment pointing here: **add a new one to `reset_process_state()`**.

Left out on purpose:
- What modules read when they're imported (`qaboard.config`'s project, `qaboard.api`'s server and token): the tests
  that need another project or server reload those modules.
- Runs that are still active (`active_run._active`, the wandb/mlflow integrations' runs) and the hooks installed for
  them (`active_run._hooks_installed`, `_bridge._hooks`): forgetting them would hide a test that doesn't end its runs,
  and would install the hooks again.
- What is registered when modules are imported (`ci_helpers.test_funcs`), or keyed by a command id
  (`runners.celery.sent_task_ids`, `runners.dask_runner._processes`).
"""
import os
import sys


def _module(name: str):
  """The module if it was imported: importing qaboard.qa or qaboard.config reads the project from the cwd"""
  return sys.modules.get(name)


def reset_process_state() -> None:
  """Forgets what earlier `qa` commands and start_run() kept for the process: what a run in a fresh process sees"""
  qa = _module('qaboard.qa')
  if qa is not None:
    # what runs that didn't end left running
    for name, stop in (('_system_metrics', 'stop'), ('_reporter', 'close')):
      value = getattr(qa, name, None)
      if value is not None:
        try:
          getattr(value, stop)()
        except Exception:
          pass
    qa._system_metrics = None
    qa._local_changes = None
    qa._reporter = None
    qa._run_end_lost = False

  api = _module('qaboard.api')
  if api is not None:
    api.results_refused = None
    api._said_unreachable.clear()
    api.aggregated_metrics.cache_clear()

  auth = _module('qaboard.auth')
  if auth is not None:
    auth._warnings_shown.clear()
  # auth.first_time sets it for the runs `qa batch` starts
  os.environ.pop('QA_AUTH_WARNING_SHOWN', None)

  credentials = _module('qaboard.credentials')
  if credentials is not None:
    credentials._exchanged.clear()

  config = _module('qaboard.config')
  if config is not None:
    config._default_branch.clear()

  active_run = _module('qaboard.active_run')
  if active_run is not None:
    active_run._explained = False
    active_run._uncaught = None

  analytics = _module('qaboard.analytics')
  if analytics is not None:
    analytics._state.clear()

  metrics = _module('qaboard.metrics')
  if metrics is not None:
    metrics._declared.clear()

  bit_accuracy = _module('qaboard.bit_accuracy')
  if bit_accuracy is not None:
    bit_accuracy.runs_known_by_qaboard.cache_clear()

  git_hosts = _module('qaboard.git_hosts')
  if git_hosts is not None:
    git_hosts.git_host.cache_clear()

  utils = _module('qaboard.utils')
  if utils is not None:
    utils.entrypoint_module_path.cache_clear()

  for name in ('qaboard.integrations.mlflow.recorder', 'qaboard.integrations.wandb._bridge'):
    said = _module(name)
    if said is not None:
      said._said.clear()
  bridge = _module('qaboard.integrations.wandb._bridge')
  if bridge is not None:
    bridge._uncaught = None
