"""

```python
from qatools.ci_helpers import on_branch, run_tests

@on_branch('develop')
def hdr_tests():
  # --snip--
  pass

if __name__ == '__main__':
  run_tests()
```

"""
from functools import wraps
import fnmatch

from joblib import Parallel, delayed
import click


# We store all tests that we may want to execute
test_funcs = []

# To give helpful error messages, we store a few things
test_funcs_names = set()
skipped_test_nb = 0



def on_branch(branch):
  if not (isinstance(branch, list) or isinstance(branch, set) or isinstance(branch, tuple)):
    branch = [branch]

  def on_branch_decorator(func):
    global skipped_test_nb
    from qatools.config import commit_branch
    # commit_branch = 'abc' # for testing

    if func.__name__ in test_funcs_names:
      click.secho(f"ERROR: Redefinition of {func.__name__}", fg='red')
      exit(1)
    else:
      test_funcs_names.add(func.__name__)

    if any([fnmatch.fnmatch(commit_branch, b) for b in branch]):
      test_funcs.append(func)
    else:
      skipped_test_nb += 1


    @wraps(func)
    def func_wrapper(*args, **kwargs):
      print('Called')
      return func(*args, **kwargs)
    return func_wrapper
  return on_branch_decorator


def run_tests():
  if not test_funcs:
    click.secho("Warning: either you did not create tasks, or none were registered via `@on_branch`.", fg='yellow')
    return
  click.secho(f"Running {len(test_funcs)} tasks", fg='green')
  if skipped_test_nb:
    click.secho(f"{skipped_test_nb} skipped", dim=True)
  all_success = True

  def run_test(test):
    click.secho(test.__name__, bold=True)
    return_code = test()
    return return_code
      
  return_codes = Parallel(n_jobs=-1, verbose=50)(delayed(run_test)(t) for t in test_funcs)
  if any((return_code is None for return_code in return_codes)):
    click.secho(f"WARNING: Your test should return a return code (success==0)", fg='yellow', bold=True)   
  return all((not return_code for return_code in return_codes))


# import os
# import subprocess
# @on_branch("abc")
# def tests_basic():
#   return os.system("echo OK")

# @on_branch(["xyz", "abc"])
# def tests_multiple():
#   return os.system("echo OK")

# @on_branch(("xyz", "abc"))
# def tests_multiple_tuple():
#   return os.system("echo OK")

# @on_branch("ab*")
# def tests_wildcards():
#   return subprocess.call("echo OK", shell=True)

# @on_branch("r")
# def tests_redefinition():
#   return os.system("echo OK")
# @on_branch("r")
# def tests_redefinition():
#   system.call("echo OK")



if __name__ == '__main__':
  run_tests()
