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

There is a huge variety of configuration formats and needs. Hence, QA-Board is not very opiniated. The `run()` function will provide a **list of configurations**, which are are free to interpret however you please.

:::tip
Access configurations using `context.obj['configurations']`. It defaults to `[]`, or the value of `inputs.configurations` in *qaboard.yaml*.
:::

## Specifying configurations
You can specify configurations on the CLI:

```bash
qa --configuration low-power run --input my/test
#=> ctx.obj['configuration'] = ['low-power']
qa --configuration base:delta run --input my/test
#=> ctx.obj['configuration'] = ['base', 'delta']

# Note: The ":"-separated syntax will be replaced by just giving multiple --configuration flags.
#       Users usually run batches, and rarely write `qa run` commands by hand.
```

If you use batches:

```yaml {5-7} title="qa/batches.yaml"
my-batch:
  inputs:
  - A.jpg
  configurations:
  - base
  - delta

# $ qa batch my-batch
# => qa --configuration base:delta run A.jpg
# => qa --configuration base:delta run B.jpg
```

## Common meaning for configurations
While QA-Board is not opiniated, projects usually consider that each configuration in `ctx.obj["configurations"]` is meant to be merged with ones before. Using "delta"/"cascading"/"partial" configurations is easy to work with.
standardize on setups like:

```yaml
# ctx.obj['configuration'] as YAML:
configurations:
- base                     # load from a file, e.g. ./configs/{base}.yaml, kept in source control
- /abs/path/to/config.yaml # read from absolute paths for convenience
- key: value               # give directly parameters...
- section:                 # don't be shy to structure parameters!
    key2: value2
```

You are free to pick different conventions.

:::note API Design
Today the API provides tuning parameters via `extra_parameters`, as a dict... In the future we may simply append it to ctx.obj['configurations'], to let users transparently do tuning. 
:::

### Use-case #1: Running Python code
```python title="qa/main.py"
from pathlib import Path
import yaml

def run():
    parameters = {}
    for c in context.obj["configurations"]:
      if isinstance(c, str): # Load from a file.
         # Supports absolute paths for free
         config_path = Path('configurations') / c if not c.exists() else c
         with config_path.open() as f:
             new_parameters = yaml.load(f)
      if isinstance(c, dict):
          new_parameters = c 
    # Maybe you will prefer deep-merges
    parameters.update(new_parameters)
    if context.obj["extra_parameters"]:
        parameters.update(context.obj["extra_parameters"])

    return my_custom_run(
        input=context.obj["absolute_input_path"],
        output=context.obj["output_directory"],
        parameters=parameters
    )
```

### Use-case #2: Running an executable
It could work as before with
```python "qa/main.py"
    # --snip--
    config_path = context.obj["output_directory"] / "config.yaml" 
    with config_path.open('w') as f:
        yaml.dump(parameters, f)

    # --snip--
    command = [
        # ...
        '--configuration', str(config_path),
        # ...
    ]
```

You could also parse the dicts to add CLI parameters... Whatever works for you!
