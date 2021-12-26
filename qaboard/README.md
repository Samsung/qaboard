# `qaboard` python package

## How does this work?
- The `qa` CLI executable is implemented by _qa.py_. We notably use the [`click`](https://click.palletsprojects.com/en/7.x/) package.
- _config.py_ is responsible for finding all the details about the current run: project configuration, git information, where to store results, whether we're it's running as part of some Continuous Integration...
- The different files each are responsible for specific parts of the application:
  * _api.py_ talks to the QA-Board server: creating new runs, etc.
  * _git.py_ makes calls to `git`
  * _iterators.py_ implements the logic to find/filter batch inputs, or iterate over tuning parameters...
  * _conventions.py_ decides on e.g. where to store results...
  * Some of the more complicated `qa` tasks have their own file: _optimize.py_ for the parameter optimizer, _check_bit_accuracy.py_...
- In the repository's top-level, `setup.py` provides:
  * the required glue to make the project installable
  * the list of third-party package requirements
  * the magic to make `qa` an available CLI executable

## Development
To make debugging easy, you'll want `qa` to use the code from your working directory:

```bash
# from the top-level of the repository
pip install --editable .
```
