---
id: specifying-configurations
sidebar_label: Configurations
title: Specifying configurations
---

You will want to run code on the same inputs with different configuration. Depending on your field, it could be:
- enabling a debug/verbose mode
- using a debug/release build
- providing various hyperparameters
- forward CLI flags for an executable
- load registers values
- read configuration from files
- etc.

There is a huge variety of configuration formats and needs. Hence, QA-Board is not very opiniated. The `run(context)` function will provide a list of configurations in `context.configs`. Configurations defaults to `[]`, or to the value of `inputs.configs` in *qaboard.yaml*.

## Specifying configurations
You can specify configurations on the CLI:

```bash
qa --config low-power run --input my/test
#=> ctx.configs = ['low-power']
qa --config base:delta run --input my/test
#=> ctx.configs = ['base', 'delta']

qa --config base --config delta run --input my/test
#=> ctx.configs = ['base', 'delta']
```

Users often use batches to make it easier:

```yaml {5-7} title="qa/batches.yaml"
my-batch:
  inputs:
  - A.jpg
  configs:
  - base
  - delta

# $ qa batch my-batch
# => qa --config base:delta run A.jpg
# => qa --config base:delta run B.jpg
```

## Common meaning for configurations
QA-Board is not opiniated. Projects usually consider that each configuration in `ctx.configs` is meant to be merged with ones before:

```yaml
configs:
- base                     # load from a file, e.g. ./configs/{base}.yaml, kept in source control
- /abs/path/to/config.yaml # overwrite with info from an absolute path
- key: value               # give directly parameters...
- section:
    key2: value2
```

You are free to pick different conventions.

:::tip
Many project just want to use "parameters" and don't need an array of "delta/cascading/incremental" configs... To make it easier QA-Board also provides `context.params`, a merge of all the `dict`s in `context.configs`.
:::

### Use-case #1: Running Python code
If you don't have a lot of parameters you can do something like:
```python title="qa/main.py"
from pathlib import Path
import yaml

def run(context):
    return your_code(
        input=context.input_path,
        output=context.output_dir,
        parameters=context.params,
    )
```

But if you deal with long config files, consider using `str`s in `context.configs` to specify files to be loaded:

```python title="qa/main.py"
def run(context):
    parameters = {}
    for c in context.configs:
      if isinstance(c, str): # Load from a file.
         # Supports absolute paths and paths relative to "./configs"
         config_path = Path('configs') / c if not c.exists() else c
         with config_path.open() as f:
             new_parameters = yaml.load(f)
      if isinstance(c, dict):
          new_parameters = c
      parameters.update(new_parameters) 

    return my_custom_run(
        input=context.input_path,
        output=context.output_dir,
        parameters=parameters
    )
```

### Use-case #2: Running an executable
It could work as before with:

```python "qa/main.py"
import json

def run(context):
    config_path = context.output_dir / "config.json" 
    with config_path.open('w') as f:
        json.dump(context.params, f)

    # --snip--
    command = [
        'build/executable',
        "--input", str(context.input_path),
        "--output", str(context.output_dir),
        '--configuration', str(config_path),
    ]
```

## "Magic" configurations
- **Environment variables:**: if `context.params` has a key named `ENV` with e.g. `{"ENV": {"key": "value"}}`, then before the run `key=value` will be applied as environment variable.
