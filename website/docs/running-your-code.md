---
id: running-your-code
sidebar_label: Running your code
title: Running your code
---
import useBaseUrl from '@docusaurus/useBaseUrl';

QA-Board works as a CLI wrapper for your code. As a default to get started, it runs commands you provide as extra arguments: 

```bash
qa run --input path/to/your/input.file 'echo "{absolute_input_path} => {output_directory}"'
#=> runs this echo command with useful info

qa --share run --input path/to/your/input.file 'echo "{absolute_input_path} => {output_directory}"'
#=> View logs in the web interface! It should print the URL
```

<img alt="First results" src={useBaseUrl('img/first-outputs.png')} />

## Wrapping your code
How does it work? When you `pip install` QA-Board with `pip`, you get the `qa` executable. `qa` opens *qaboard.yaml* and imports the python file specified by `project.entrypoint`. Then it runs your entrypoint's `run()` function with information about the current run: input, configuration, where outputs should be saved etc.

Take a look at the default `run()` in [*qatools/main.py*](https://github.com/Samsung/qaboard/blob/master/qatools/sample_project/qa/main.py). You should change it to run your code. In most cases that means finding and executing an exectuable file, or importing+running python code...

:::tip
Many users want to separate algorithm runs and postprocessing. To make this flow easier, you can optionnaly implement `postprocess()`. Then you will get `qa run` and `qa postprocess`.
:::

## What should your wrapper do?
The main assumption is that your code
- Write *"qualitative"* files in the `output_directory`
- Returns *"quantitative"* metrics/KPIs.

The `run()` function receives as argument a [`context` object whose properties](#reference-useful-context-properties) tell us **how** you should run **what**, and **where** outputs are expected to be saved.

:::important
Below are the most common ways users wrap their code. Identify what works for you and continue to the next page!
:::

---

### Use-case #1: Running Python code
```python
def run(context):
  # Assuming your code is at *src/my_code.py* while the entrypoint is at *qa/main.py*
  sys.path.append(str(Path(__file__).parent.parent))
  from src.my_code import MyRun
  # Note: you could also pip install your code as a package...

  # People commonly wrap their code within Classes/functions
  metrics = MyRun(
      input=context.obj['absolute_input_path'],
      output=context.obj['output_directory'],
      # The next page will show you to supply configurations
      params={"hard-coded": "values"}, 
  ).run()
  metrics['is_failed'] = False # True if your code raises an exception
  return metrics
```

### Use-case #2: Running an executable
`QA-Board` assumes you already built your code.     

```python
import os
import sys
from pathlib import Path

def binary_path():
    """Find and return the path of the executable. It's often different on Windows/Linux..."""
    if os.environ.get('PROJECT_BINARY'): # Overwrite location via ENV variables
        return Path(os.environ['PROJECT_BINARY'])
    if sys.platform == 'win32':
        return Path("build/x64/my_binary.exe")
    else:  # Easy support for build types: Release/Debug/Coverage/ASAN...
        return Path(f"build/{os.environ.get('PROJECT_BUILD_TYPE')}/my_binary")

def run():
    command = [
        f'{binary_path()}',
        "--input", str(context.obj["absolute_input_path"]),
        "--output", str(context.obj["output_directory"]),
        *context.obj["output_directory"]
    ]
    process = subprocess.run(
        command,
        check=True,          # raise exception on exit code != 0
        capture_output=True, # >=python3.7
    )
    # Note: If you want live interleaved STDOUT/STDERR, (like sample entrypoint from `qa init`),
    # it get a bit more complicated: https://docs.python.org/3/library/subprocess.html
    print(process.stdout)
    print(process.stderr)
    return {"is_failed": False}
```

:::tip
Instead of returning metrics, if you don't want to touch too much python, you can simply write them as JSON in *$output_directory/metrics.json*.
:::

### Use-case #3: Importing existing results (Advanced)
It's is sometimes needed to easily compare results versus reference implementations or benchmarks. Let's say the benchmark results can be found alongside images in your database like so:

```log
database
├── images
│  ├── A.jpg
│  └── B.jpg
└── standard-benchmark
   └── images
      ├── A
      │  └── output.jpg
      └── B
         └── output.jpg
```

```python
def run(context):
    if context.obj["input_type"] == 'benchmark':
        import shutil
        # Next page you will learn how you can provided configurations/parameters to the run.
        benchmark = context.obj['configurations'][0]['benchmark']
        # Find the benchmark results...
        benchmark_outputs = context.obj['database'] / benchmark context.obj['input_path'].parent / context.obj['input_path'].stem
        # To copy the result image only
        os.copy(str(benchmark_outputs / 'output.jpg'), str(context.obj['output_directory'])
        # To copy the whole directory
        shutil.copytree(
            str(benchmark_outputs),
            str(context.obj['output_directory'],
            dirs_exist_ok=True, # python>=3.8, otherwise just call `cp -R` to do it yourself...
        )
    # Otherwise run your code, that create *output.jpg*
```

To actually import the results, create a batch (more info later) for the benchmark. `qa batch import-standard-benchmark` with:

```yaml
# qa/batches.yaml
import-standard-benchmark:
  type: benchmark
  configurations:
  - benchmark: standard-benchmark
  inputs:
  - images
```

> Now you can make comparaisons!

:::tip
From the QA-Board web application, you can set the benchark as a "milestone", to compare your results to it in a click.
:::


## Useful `context` properties (Reference)
:::note
Yes, the API is ugly, it will change before the open-source release and we're open to suggestions!
:::

| **What**              |                                               |
|-----------------------|-----------------------------------------------|
| `absolute_input_path` | $database / $input_path                       |
| `database`            | path to the database                          |
| `input_path`          | path of the test, relative to the database    |
| `input_type`          | input type                                    |
| `input_metadata`      | if relevant, input metadata (more info later) |

| **How**            |                                                                                          |
|--------------------|------------------------------------------------------------------------------------------|
| `configurations`   | array of strings or dicts. *You* decide how to interpret  it!                            |
| `extra_parameters` | When doing tuning, a dict of `key:values` that should override specific algo parameters. |
| `platform`         | Usually the host (linux/windows), but can be overwritten as part of your custom logic    |
| `forwarded_args`   | Extra CLI flags provided to qa. Usually used for debugging.                              |

| **Where**           |                                            |
|---------------------|--------------------------------------------|
| `output_directory`  | where your code should save its outputs    |

## Accessing the QA-Board configuration from the entrypoint (Reference)
```python
from qaboard.config import config
config['project']['name']
#
# etc
```

:::note Work in Progress
A full reference for `from qaboard.config import ...` will arrive in the docs!
:::