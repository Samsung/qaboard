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

import click


# We store all tests that we may want to execute
test_funcs = []

# To give helpful error messages, we store a few things
test_funcs_names = set()
skipped_test_nb = 0



def on_branch(branch):
	if not isinstance(branch, list):
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
	for test in test_funcs:
		click.secho(test.__name__, bold=True)
		test()




# @on_branch("abc")
# def tests_basic():
# 	pass

# @on_branch(["xyz", "abc"])
# def tests_multiple():
# 	pass

# @on_branch("ab*")
# def tests_wildcards():
# 	pass

# @on_branch("r")
# def tests_redefinition():
# 	pass
# @on_branch("r")
# def tests_redefinition():
# 	pass



if __name__ == '__main__':
	run_tests()
