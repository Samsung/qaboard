---
id: project-setup
sidebar_label: Project Setup
title: First steps with qatools
---

## Defining your algorithm's inputs
Algorithms turn inputs into outputs. **What are your algorithm's inputs?** They could be image files, folders containing images, whole databases for which you report aggregated results...

> For simplicity though, an input is a path. For clarity, we split this path into **$database** / **$test**

In [*qatools.yaml*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml#L27), **tell qatools how to recognize your inputs**: edit `inputs.database` and `inputs.glob`. Here is an example where all *jpg* files are possible inputs:

```yaml
inputs:
  database:
    linux: /net/f2/algo_archive/project_database
    windows: F:/project_database
  glob: '*.jpg'
```

To test everything works as intended, make sure this runs without errors:

``` 
qa run --input your/input.raw
```

:::tip
You can also define batches of tests. [Here are the docs](batches-running-on-multiple-inputs).
:::

## Wrapping your code
qatools will wrap your code with a nice CLI API:

```bash
qa run --input my/test
qa --configuration low-power run --input my/test
qa --configuration low-power:extra-low-power run --input my/test
```

To make it work, we need to tell qatools how to call your code. <span style="border-bottom: 1px dotted #000; text-decoration: none;" title="Change qatools.yaml `project.entrypoint`">By default</span>, it expects the entrypoint to be a python function called `run()` in [*qatools/main.py*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools/main.py#L30).

:::tip
Many users want to separate algorithm runs and postprocessing. To make this flow easier, you can optionnaly implement `postprocess()`. 
:::

The `run()` function receives as argument a [`context` object whose properties](#reference-useful-context-properties) tell us **how** you should run **what**, and **where** outputs are expected to be saved.

:::note
Access those properties via eg `context.obj["test_input"]`. This API is [ugly](https://click.palletsprojects.com/en/7.x/complex/), we're open to suggestions!
:::

**In many cases** your code will:
1. Find the binary where you implemented your algorithm (assuming it's already built). It can be at a different place on Windows or Linux. 
2. Send a command line to the shell, maybe with something like

```python
subprocess.call([
    f'{binary_path()}',              # you could even call my/other/python algo.py
    f'--input "{context.obj["absolute_input_path"]}"',
    f'--output "{context.obj["output_directory"]}"',
    ' '.join([f'--config config/{c}.json' for c in context.obj["configurations"]]),
])
```

> The sample code installed with `qa init` gives you this as a starting point.

## Outputs
Algorithms usually create two kinds of outputs: *qualitative* results and *quantitative* results.

### Qualitative results
This can be images, logs, pointclouds... Usually things that are not scalar  &mdash; **saved as files.**

- You are free to create whatever files you want, just save them in `context.obj["output_directory"].`
- To find out how to add visualizations in qatools's web application, [read the docs](visualizations).

### Quantitative results
Algorithms are usually evaluated using KPIs / Objective Figures of Merit / metrics. To make sure qatools's web UI displays them:

1. `run()` should return a dict of metrics:
```python
def run():
    # --snip--
    return {
        "loss": loss
    }
```

2. Describe your metrics in  <span style="border-bottom: 1px dotted #000; text-decoration: none;" title="To use different file, edit in qatools.yaml `outputs.metrics`">*qatools/metrics.yaml*</span>. Here is an example

```yaml
available_metrics:
  loss:
    key: loss
    label: Loss function
    short_label: Loss
    smaller_is_better: true
    target: 0.01
    # when displaying results in a UI, you often want to change units
    # scale: 100
    # suffix: '%'
```


## Reference
### Useful `context` properties
| **What**              |                                            |
|-----------------------|--------------------------------------------|
| `test_input`          | path of the test, relative to the database |
| `database`            | path to the database                       |
| `absolute_test_input` | $database / $test_input                    |

| **How**         |                                                                                |
|-----------------|--------------------------------------------------------------------------------|
| `configurations`  | array of strings or dicts. *You* decide how to interpret  it!                                                     |
| `tuning_filepath` | *(optional)* path to a json file that define values for specific algo parameters |
| `platform` | Usually the host (linux/windows), but can be used to send runs to remote hosts |

| **Where**           |                                            |
|---------------------|--------------------------------------------|
| `output_directory`  | where your code should save its outputs    |





