---
id: metadata-integration-external-databases
sidebar_label: Metadata & external databases
title: Using input metadata and integrating with external databases
---

## Metadata
Input metadata are useful to:
- **Filter** and **group** inputs
- Decide **what metrics to compute** on your outputs


To enable metadata support in qatools, implement in  your <span style="border-bottom: 1px dotted #000; text-decoration: none;" title="defined in *qatools.yaml* as `project.entrypoint`">project's entrypoint</span> a function that returns metadata as a dict. Here is an example:

```python
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

Qatools will forward metadata to your `run()` function as `ctx.obj['input_metadata']`.


### Using metadata to filter batches of inputs
```yaml
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
Instead of relying on walking on the filesystem, you can use an external database to organize your inputs. To enable this with qatools, implement in  your <span style="border-bottom: 1px dotted #000; text-decoration: none;" title="defined in *qatools.yaml* as `project.entrypoint`">project's entrypoint</span> a function that iterates over inputs given a query:

```python
def iter_inputs(path, database, only, exclude):
  # TODO: connect to an SQL database
  #       use sqlalchemy to execute something like
  #       f"SELECT test, metadata from tests where path LIKE {path} and database={database}"
  # OPTIONALLY: return filtered inputs using only/exclude
  #             even if you don't do it, qatools will always re-filter
  #             but doing it yourself in SQL can be much more efficient
  return ({"absolute_input_path": database / p.path, "metadata": p.metadata} for p in inputs)

# Note: path=None should match all inputs in the database
```

:::note
Currently, you still have to write a `metadata()` function for `run()` to receive the metadata or for qatools to use them in the UI.
:::
