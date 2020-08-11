---
id: metadata-integration-external-databases
sidebar_label: Metadata & External Databases
title: Using input metadata and integrating with external databases
---
## Metadata
Input metadata are useful to:
- **Filter** and **group** inputs
- Decide **what metrics to compute** on your outputs

> QA-Board will forward metadata to your `run(ctx)` function as `ctx.input_metadata`.

### Creating metadata
To enable metadata support in QA-Board, you have 2 options:

1. Fill the metadata as part of your `run`:

```python title="qa/main.py"
def run(context):
  context.input_metadata = {}
```

2. Implement in your project's entrypoint a function that returns metadata as a dict. Here is an example:

```python title="qa/main.py"
import yaml

def metadata(absolute_input_path, database, input_path):
  metadata_file = absolute_input_path.with_suffix('.metadata.yaml')
  if not metadata_file.exists():
    return {}
  with metadata_file.open() as f:
    return yaml.load(f, Loader=yaml.SafeLoader)
```

:::tip
If you define `metadata.label` it will be used in the UI instead of the input path.
:::

:::tip
QA-Board will compares runs with different input if they have the same `metadata.id`. A common use-case is comparing images from different sensors taken in the same conditions.
:::



### Using metadata to filter batches of inputs
```yaml title="qa/batches.yaml"
inputs-filtered-using-metadata:
  only: # only run tests matching all those conditions
    PD pattern: 4PD
    Model             # mulitple options are OK
      - 2T7
      - XXX
    Binning: '1:*'    # wildcards are supported
    Bad pixels: False # as well as Booleans, numbers…
    Distance: '>1'    # also >=, =,==, <, <=

  exclude: # don't run on tests matching all the filters below
    Location: Outdoor
```

```bash
qa batch inputs-filtered-using-metadata
# => run only on inputs with 4PD as PD pattern, etc.
```

## Integrating with external input databases
Inputs are not always existing files. In some cases you will want to use a "proper" database to organize them. If your inputs are the names of unit tests, you'll list them with something like `gtest_project --gtest_list_tests`.

To enable this with QA-Board, implement in your project's entrypoint a function that iterates over inputs given a query:

```python title="qa/main.py"
def iter_inputs(path, database, only, exclude, inputs_settings):
  # TODO: Maybe here connect to an SQL database
  #       and execute something like
  #       f"SELECT test, metadata from tests where path LIKE {path} and database={database}"
  # OPTIONALLY: return filtered inputs using only/exclude
  #             even if you don't do it, qa-board will always re-filter
  #             but doing it yourself in SQL can be much more efficient
  return ({"absolute_input_path": database / p.path, "metadata": p.metadata} for p in inputs)

# Note: path=None should match all inputs in the database
# Note: inputs_settings is a dict with information on how inputs should be found: file globs, use_parent, or anything else you put in qaboard.yaml's inputs.
```
