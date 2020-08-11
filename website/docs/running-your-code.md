---
id: running-your-code
sidebar_label: Running your code
title: Running your code
---
import useBaseUrl from '@docusaurus/useBaseUrl';

QA-Board works as a CLI wrapper for your code. As a default to get started, it runs commands you provide as extra arguments: 

```bash
qa run --input path/to/your/input.file 'echo "{input_path} => {output_dir}"'
#=> prints "/database/path/to/your/input.file  => output/dir"

qa --share run --input path/to/your/input.file 'echo "{input_path} => {output_dir}"'
#=> prints an URL to view logs in the web interface
```

<img alt="First results" src={useBaseUrl('img/first-outputs.png')} />

:::note
Results are saved under *output/*. `--share`'d results are saved in */mnt/qaboard*. To change it, edit `storage` in `qaboard.yaml`.
:::


## Wrapping your code
How does it work? When you `pip install` QA-Board with `pip`, you get the `qa` executable. `qa` opens *qaboard.yaml* and imports the python file specified by `project.entrypoint`. Then it runs your entrypoint's `run()` function with information about the current run: input, configuration, where outputs should be saved etc.

Take a look at the default `run()` in [*qa/main.py*](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qa/main.py). You should change it to run your code. In most cases that means finding and executing an executable file, or importing+running python code...

:::tip
Many users want to separate algorithm runs and postprocessing. To make this flow easier, you can optionnaly implement `postprocess()`. Then you will get `qa run` and `qa postprocess`.
:::

## What should your wrapper do?
The main assumption is that your code
- Write *"qualitative"* files in the `output_dir`
- Returns *"quantitative"* metrics/KPIs.

The `run()` function receives as argument a [`context` object whose properties](#reference-useful-context-properties) tell us **how** you should run **what**, and **where** outputs are expected to be saved.

:::important
Below are the most common ways users wrap their code. Identify what works for you and continue to the next page!
:::

---

### Use-case #1: Running Python code
```python title="qa/main.py"
from pathlib import  Path

def run(context):
  metrics = your_code(
      input=context.input_path,
      output=context.output_dir,
      # The next page will show you to supply configurations via context.params
      params={"hard-coded": "values"}, 
  )
  metrics['is_failed'] = False
  return metrics
```

### Use-case #2: Running an executable
`QA-Board` assumes you already built your code.     

```python title="qa/main.py"
import subprocess

def run(context):
    command = [
        'build/executable',
        "--input", str(context.input_path),
        "--output", str(context.output_dir),
        # if you call e.g. "qa run -i some_input --forwarded args", you can do:
        *context.forwarded_args,
    ]
    process = subprocess.run(
        command,
        capture_output=True,
    )
    print(process.stdout)
    print(process.stderr)
    return {"is_failed": process.returncode != 0}
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

```python title="qa/main.py"
import os
import shutil

def run(context):
    if context.type == 'benchmark':
        # Next page you will learn how you can provided configurations/parameters to the run.
        benchmark = context.params['benchmark']
        # Find the benchmark results...
        benchmark_outputs = context.database / benchmark context.input_path.parent / context.input_path.stem
        # To copy the result image only
        os.copy(str(benchmark_outputs / 'output.jpg'), str(context.output_dir])
        # To copy the whole directory
        shutil.copytree(
            str(benchmark_outputs),
            str(context.output_dir),
            dirs_exist_ok=True, # python>=3.8, otherwise just call `cp -R` to do it yourself...
        )
    # Otherwise run your code, that create *output.jpg*
```

To actually import the results, create a batch (more info later) for the benchmark. `qa batch import-standard-benchmark` with:

```yaml  title="qa/batches.yaml"
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

| **What**              |                                               |
|-----------------------|-----------------------------------------------|
| `database`            | path to the database                          |
| `rel_input_path`      | input relative to the database                |
| `input_path`          | $database / $rel_input_path                   |
| `type`                | input type                                    |
| `input_metadata`      | if relevant, input metadata (more info later) |

| **How**            |                                                                                          |
|--------------------|------------------------------------------------------------------------------------------|
| `configs`          | Many algorithms need some notion of "incremental/delta/cascading configs". *Array* of strings or dicts or whatever. *You* decide how to interpret it.                                                                     |
| `params`           | `dict` with all the above `configs` of type `dict` deep merged. It's often all you need!.|
| `platform`         | Usually the host (linux/windows), but can be overwritten as part of your custom logic    |
| `forwarded_args`   | Extra CLI flags. Usually used for debugging. Also available in `params`.                 |
| `configurations`   | (advanced): Array of strings or dicts, but without tuning extra parameters like `configs`.           |
| `extra_parameters` | (advanced): When doing tuning via QA-Board or using extra CLI forwarded arguments, a dict of `key:values`. |


| **Where**           |                                            |
|---------------------|--------------------------------------------|
| `output_dir`        | where your code should save its outputs    |

:::tip
You can use `context.obj` to store arbitrary data.
:::

## Accessing the QA-Board configuration
:::note Work in Progress
A full reference for `from qaboard.config import ...` will arrive in the docs!
:::

```python
from qaboard.config import project, config, ...
```

