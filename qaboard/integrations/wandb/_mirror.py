"""
Mirroring the real `wandb` to QA-Board: every call still goes to W&B, and what it logs goes to QA-Board too.

We wrap, never replace, wandb's public surface: `wandb.init`, and the methods of the classes of the objects it returns
(the run's `log`, `finish`, `define_metric`, `log_artifact`, `save`..., its summary's `update`, its config's setters),
found on the objects themselves rather than by their module paths, which change between wandb versions. `wandb.log`
and the other module functions are the run's methods once `wandb.init()` ran, so they go through the wrappers too.
W&B's call runs first; when it raises, so does the wrapper, as without QA-Board. Ours never raises: what fails is said
once, and W&B's logging goes on.
"""
import functools
import inspect
import sys
import threading
from typing import Any, Callable, Dict, Optional, Tuple

from .._common import say
from ._bridge import Bridge, InitArgs, active, public, quiet, say_once, unsupported_call

# the methods of wandb's Run we mirror, and those we say QA-Board doesn't have
RUN_METHODS = ('log', 'finish', 'define_metric', 'log_artifact', 'log_model', 'save', '__exit__')
RUN_UNSUPPORTED = ('watch', 'alert', 'use_artifact', 'use_model', 'link_model', 'log_code', 'mark_preempting', 'restore')
CONFIG_METHODS = ('__setitem__', '__setattr__', 'update', 'setdefaults', 'update_locked')
SUMMARY_METHODS = ('update',)
MODULE_UNSUPPORTED = ('sweep', 'agent', 'controller')

# the bridge of each wandb run, and of its summary and config, by id(): wandb's objects needn't be hashable
_runs: Dict[int, Tuple[Any, Bridge]] = {}
_summaries: Dict[int, Tuple[Any, Bridge]] = {}
_configs: Dict[int, Tuple[Any, Bridge]] = {}
# inside one of wandb's calls: the calls it makes itself (init sets the config, log_model logs an artifact) aren't ours
_inside = threading.local()


def mirror(module: Any = None) -> Any:
  """
  Mirrors W&B runs to QA-Board, from now on: call it before `wandb.init()`. Returns the `wandb` module: the real one,
  or, when wandb isn't installed, QA-Board's shim, which `import wandb` then gives too.
  """
  from .. import wandb as shim
  if module is None:
    if sys.modules.get('wandb') is shim:
      return shim
    try:
      import wandb as module  # type: ignore[no-redef,import-not-found]
    except ImportError:
      module = None
    if module is None or getattr(module, '__file__', None) is None:
      # not installed. Without the package, the wandb/ folder where W&B keeps offline runs, in the current directory,
      # imports as an empty namespace package
      sys.modules['wandb'] = shim
      say_once('mirror:shim', "wandb isn't installed: `import wandb` gives QA-Board's shim, and runs are logged to QA-Board only")
      return shim
  if module is shim or getattr(module, '_qaboard_mirrored', False):
    return module
  init = getattr(module, 'init', None)
  if not callable(init):
    say(f"WARNING: not mirroring W&B to QA-Board: this wandb ({getattr(module, '__version__', '?')}) has no wandb.init()")
    return module
  module.init = _wrap_init(init, module)
  # before init: wandb points its module's functions (wandb.log...) to the methods of the run it creates
  run_class = getattr(module, 'Run', None) or getattr(getattr(getattr(module, 'sdk', None), 'wandb_run', None), 'Run', None)
  if isinstance(run_class, type):
    _patch(run_class, RUN_METHODS, _on_run)
    _patch(run_class, RUN_UNSUPPORTED, _on_unsupported)
  for name in MODULE_UNSUPPORTED:
    original = getattr(module, name, None)
    if callable(original):
      setattr(module, name, _wrap_unsupported(original, name))
  module._qaboard_mirrored = True
  if not quiet():
    say_once('mirror', f"mirroring W&B runs to QA-Board (wandb {getattr(module, '__version__', '?')})")
  return module


def _arguments(function: Callable, args: tuple, kwargs: dict, skip_self: bool = False) -> Dict[str, Any]:
  """A call's arguments by name, whatever this wandb version's order"""
  try:
    signature = inspect.signature(function)
    bound = signature.bind_partial(*((None,) if skip_self else ()), *args, **kwargs).arguments
    values = {k: v for k, v in bound.items() if signature.parameters[k].kind is not inspect.Parameter.VAR_KEYWORD}
    for k, v in bound.items():
      if signature.parameters[k].kind is inspect.Parameter.VAR_KEYWORD:
        values.update(v)
    if skip_self:
      values.pop(next(iter(signature.parameters)), None)
    return values
  except (TypeError, ValueError):
    return dict(kwargs)


def _call(original: Callable, *args: Any, **kwargs: Any) -> Tuple[Any, bool]:
  """wandb's call, and whether it is ours to mirror: not when wandb makes it from inside another"""
  outer = not getattr(_inside, 'depth', 0)
  _inside.depth = getattr(_inside, 'depth', 0) + 1
  try:
    return original(*args, **kwargs), outer
  finally:
    _inside.depth -= 1


def _wrap_init(original: Callable, module: Any) -> Callable:
  @functools.wraps(original)
  def init(*args: Any, **kwargs: Any) -> Any:
    run, outer = _call(original, *args, **kwargs)
    if outer:
      try:
        _attach(run, _arguments(original, args, kwargs))
        _repoint(module, run)
      except Exception as e:
        say_once('error:init', f"WARNING: not mirroring this W&B run to QA-Board: {type(e).__name__}: {e}")
    return run
  init._qaboard_original = original  # type: ignore[attr-defined]
  return init


def _wrap_unsupported(original: Callable, name: str) -> Callable:
  @functools.wraps(original)
  def wrapper(*args: Any, **kwargs: Any) -> Any:
    result, outer = _call(original, *args, **kwargs)
    if outer:
      unsupported_call(name)
    return result
  wrapper._qaboard_original = original  # type: ignore[attr-defined]
  return wrapper


def _config_of(run: Any) -> Dict[str, Any]:
  config = getattr(run, 'config', None)
  if config is None:
    return {}
  for method in ('as_dict', '_as_dict'):
    if callable(getattr(config, method, None)):
      return public(dict(getattr(config, method)()))
  return public(dict(config.items()))


def _attach(run: Any, arguments: Dict[str, Any]) -> None:
  if run is None or id(run) in _runs:
    return  # wandb gave the active run again ("return_previous")
  args = InitArgs(arguments)
  if getattr(run, 'disabled', False) is True:
    args.mode = 'disabled'
  elif getattr(run, 'offline', False) is True:
    args.mode = 'offline'
  if args.reinit != 'create_new':
    # wandb finished the previous runs, or will: so do we
    for bridge in active():
      if bridge.mirror:
        bridge.finish()
  bridge = Bridge(args, config=lambda: _config_of(run), mirror=True)
  _runs[id(run)] = (run, bridge)
  _patch(type(run), RUN_METHODS, _on_run)
  _patch(type(run), RUN_UNSUPPORTED, _on_unsupported)
  summary = getattr(run, 'summary', None)
  if summary is not None:
    _summaries[id(summary)] = (summary, bridge)
    _patch(type(summary), SUMMARY_METHODS, _on_summary)
  config = getattr(run, 'config', None)
  if config is not None:
    _configs[id(config)] = (config, bridge)
    _patch(type(config), CONFIG_METHODS, _on_config)


def _repoint(module: Any, run: Any) -> None:
  """wandb.log & co. are the run's methods, taken before we wrapped its class (another wandb version's): take them again"""
  for name in RUN_METHODS + RUN_UNSUPPORTED:
    current = getattr(module, name, None)
    if current is not None and getattr(current, '__self__', None) is run and getattr(getattr(current, '__func__', None), '_qaboard_original', None) is None:
      try:
        setattr(module, name, getattr(run, name))
      except (AttributeError, TypeError):
        pass


def _patch(cls: type, names: Tuple[str, ...], handler: Callable) -> None:
  for name in names:
    original = cls.__dict__.get(name) or getattr(cls, name, None)
    if not callable(original) or getattr(original, '_qaboard_original', None) is not None:
      continue
    try:
      setattr(cls, name, _wrap_method(original, name, handler))
    except (TypeError, AttributeError):
      pass


def _wrap_method(original: Callable, name: str, handler: Callable) -> Callable:
  @functools.wraps(original)
  def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
    result, outer = _call(original, self, *args, **kwargs)
    if outer:
      try:
        handler(self, name, original, args, kwargs)
      except Exception as e:
        say_once(f"error:{name}", f"WARNING: QA-Board didn't get wandb's {name}(): {type(e).__name__}: {e}. W&B did. Said once.")
    return result
  wrapper._qaboard_original = original  # type: ignore[attr-defined]
  return wrapper


def _bridge(registry: Dict[int, Tuple[Any, Bridge]], obj: Any) -> Optional[Bridge]:
  found = registry.get(id(obj))
  return found[1] if found is not None and found[0] is obj else None


def _on_run(run: Any, name: str, original: Callable, args: tuple, kwargs: dict) -> None:
  bridge = _bridge(_runs, run)
  if bridge is None:
    return
  values = _arguments(original, args, kwargs, skip_self=True)
  if name == 'log':
    data = values.get('data', args[0] if args else None)
    if isinstance(data, dict):
      bridge.log(data, step=values.get('step'), commit=values.get('commit'))
  elif name == 'finish':
    bridge.finish(exit_code=values.get('exit_code'))
  elif name == '__exit__':
    exc_type, exc = (list(args) + [None, None])[:2]
    failed = exc_type is not None and not (exc_type is SystemExit and not getattr(exc, 'code', None))
    bridge.finish(exit_code=1 if failed else None, error=exc if failed else None)
  elif name == 'define_metric':
    bridge.define_metric(values.get('name', args[0] if args else ''), step_metric=values.get('step_metric'),
                         summary=values.get('summary'), goal=values.get('goal'), hidden=values.get('hidden'))
  elif name in ('log_artifact', 'log_model'):
    artifact = values.get('artifact_or_path', values.get('path', args[0] if args else None))
    bridge.log_artifact(artifact, name=values.get('name'), aliases=values.get('aliases'), what=name)
  elif name == 'save':
    pattern = values.get('glob_str', args[0] if args else None)
    if pattern is not None:
      bridge.save(pattern, base_path=values.get('base_path'), policy=values.get('policy') or 'live')


def _on_unsupported(run: Any, name: str, original: Callable, args: tuple, kwargs: dict) -> None:
  if _bridge(_runs, run) is not None:
    unsupported_call(name)


def _on_summary(summary: Any, name: str, original: Callable, args: tuple, kwargs: dict) -> None:
  bridge = _bridge(_summaries, summary)
  values = args[0] if args else kwargs.get('d')
  if bridge is not None and isinstance(values, dict):
    bridge.summary_update(values)


def _on_config(config: Any, name: str, original: Callable, args: tuple, kwargs: dict) -> None:
  bridge = _bridge(_configs, config)
  if bridge is not None and not (name in ('__setattr__', '__setitem__') and args and str(args[0]).startswith('_')):
    bridge.config_changed()
