"""
python -m qaboard.integrations.wandb train.py --lr 1e-3
python -m qaboard.integrations.wandb -m my_package.train --lr 1e-3

Runs a script that logs with W&B, and logs its runs to QA-Board too, without changing it: see `mirror()`. The script
runs like `python train.py ...` would run it: `__main__`, its arguments, its folder first in sys.path, its exit code.
"""
import os
import runpy
import sys
from typing import List, Optional

USAGE = """usage: python -m qaboard.integrations.wandb script.py [args...]
       python -m qaboard.integrations.wandb -m module [args...]

Runs code that logs with Weights & Biases, and logs its runs to QA-Board too.
With wandb installed, the runs still go to W&B; without it, `import wandb` gives QA-Board's shim.
Docs: https://samsung.github.io/qaboard/docs/from-wandb"""


def main(argv: Optional[List[str]] = None) -> int:
  argv = list(sys.argv[1:] if argv is None else argv)
  if not argv or argv[0] in ('-h', '--help'):
    print(USAGE, file=sys.stderr if not argv else sys.stdout)
    return 2 if not argv else 0
  module: Optional[str] = None
  if argv[0] == '-m':
    if len(argv) < 2:
      print(USAGE, file=sys.stderr)
      return 2
    module, args = argv[1], argv[2:]
  else:
    script, args = argv[0], argv[1:]
    if not os.path.isfile(script):
      print(f"qaboard: can't open file {script!r}: no such file", file=sys.stderr)
      return 2

  from . import mirror
  from ._bridge import finish_all
  mirror()
  try:
    if module is not None:
      sys.argv = [module, *args]  # run_module sets argv[0] to the module's file, like `python -m`
      runpy.run_module(module, run_name='__main__', alter_sys=True)
    else:
      sys.argv = [script, *args]
      sys.path[0] = os.path.dirname(os.path.abspath(script))
      runpy.run_path(script, run_name='__main__')
  except SystemExit as e:
    code = e.code
    failed = code not in (None, 0)
    finish_all(exit_code=(code if isinstance(code, int) else 1) if failed else None)
    raise
  except BaseException as e:
    finish_all(error=e)
    raise
  finish_all()
  return 0


if __name__ == '__main__':
  sys.exit(main())
