---
id: inputs
sidebar_label: From Inputs to Outputs
title: From Inputs to Outputs
---

## What is a run?
QA-Board will run:
- your code on **inputs** with a given **configuration**
- and expect **outputs files** along with **metrics**.

Depending on your domain, those will be different. Here are some examples:


| Domain                 | Input            | Configuration         | Output                             | Metric                            |
|------------------------|------------------|-----------------------|------------------------------------|-----------------------------------|
| **Image processing**   | image            | feature flag & params | transformed image, debug data...   | SNR, sharpness, color accuracy... |
| **Cloud server choice**| integration test | instance type     |                                    | cost, throughput...               |
| **Machine learning**   | database/sample  | hyperparameters       | convergence plots / individual results| loss                           |
|**Optimization research**| problem         | model type, solver    | solution                           | cost, runtime...                  |
|**Software performance**| unit test        | feature flag, platform| `perf` recordings, benchmark histograms| runtime, memory, latency, IPC, throughput...|

## How QA-Board looks for inputs
To make things simple, QA-Board expects that your inputs are existing **paths**.

:::note
It is also possible to use external databases not just files. Or use a list of unit tests...  If you need it, [read this](metadata-integration-external-databases).
:::


Try to run:

```bash
qa run --input /dev/random
#=> it should invite you to run *your* code
```

:::tip
Relative paths will be searched relative to the "database". The default is `/` (or `C://` on Windows), and you can change it in *qaboard.yaml* (`inputs.database`).  
:::


## Batches of inputs
To run on batches of multiple inputs, use `qa batch my-batch`, where **my-batch** is defined in:

```yaml title="qa/batches.yaml (can be changed in qaboard.yaml via inputs.batches)"
my-batch:
 inputs:
   - images/A.jpg
   - images/B.jpg
```

```bash
qa batch my-batch
#=> qa run --input images/A.jpg
#=> qa run --input images/B.jpg
```

:::note
We'll cover [batches in more depth later](batches-running-on-multiple-inputs). By default, batches run in parallel locally, but you can easily setup an async task queue like [Celery](celery-integration) or [others](https://github.com/Samsung/qaboard/wiki/Adding-new-runners).
:::

## *(Optional)* Identifying inputs
You'll often want to do something like "run on all the images in a given folder". For that to work, you have to tell QA-Board how to identify those images as inputs.

In [*qaboard.yaml*](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qaboard.yaml) edit and `inputs.globs` with a [glob pattern](https://docs.python.org/3/library/glob.html). Here is an example where your inputs are *.jpg* images:

```yaml title="qaboard.yaml"
inputs:
  globs: '*.jpg'
```

When you do this, you no longer have to define an explicit list of input paths in your batches. You can instead use folders or even [globs/wildcards](https://docs.python.org/3/library/glob.html) (`*`, `**`...):

```yaml title="qa/batches.yaml"
my-batch:
 inputs:
   - images
```

:::tip
To run on all the inputs found under `$database / $PATH` you can simply use `qa batch $PATH`.
:::


You can give multiple patterns:

```yaml title="qaboard.yaml"
inputs:
  globs:
  - '*.jpg'
  - '*.bmp'
  - '*.dng'
```

A common use case is identifying folders containing a file patching a pattern, for instance movies given a sequence of frames, *frame_000.jpg*, *frame_001.jpg*... In this case you can use `use_parent_folder`:

```yaml {3} title="qaboard.yaml"
inputs:
  globs: frame_000.jpg
  use_parent_folder: true
```

## *(Advanced)* Handling multiple input types
Big projects sometimes need to distinguish different types of inputs, which will be processed with a different logic.

```yaml title="qaboard.yaml" {3-9}
inputs:
  types:
    default: image
    image:
      globs: '*.raw'
    movie:
      globs: frame_000.jpg
      use_parent_folder: true
      # you can override the defaults per-type
      database:
        linux: /mnt/movies
        windows: F://movies
```

You can choose what type each batch is: 

```yaml {7} title="qa/batches.yaml"
my-images:
  inputs:
  - my/image.jpg

my-batch:
  type: movie
  inputs:
  - folder/of/movies
  - other/movies
```

If needed, you can also specify the input type from the CLI:

```bash
qa batch my-imagess              # by default look for images
qa --type movie batch my-movies  # here we look for movies
```
