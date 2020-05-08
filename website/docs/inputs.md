---
id: inputs
sidebar_label: Inputs
title: Input files
---
Algorithms turn inputs into outputs. *What are your inputs?* They can be image files, folders containing images...

> For QA-Board, an input is a **path**, split into "**$database** / **$input**".

1. In *qaboard.yaml*, define your default database `inputs.database` (it defaults to `/` or `C://`)
2. Try to run:

```bash
qa run --input relatve/path/to/your/input.file 
#=> it should invite you to run *your* code
```

:::note
It is also possible to use external input databases not just files. If you need it, [read this](metadata-integration-external-databases).
:::

## Batches of inputs
To run on batches of multiple inputs, use `qa batch my-batch`, where **my-batch** is defined in:

```yaml
# qa/batches.yaml (can be changed in qaboard.yaml via inputs.batches)
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

## Identifying inputs (Recommended)
You'll often want to do something like "run on all the images in a given folder". For that to work, you have to tell QA-Board how to identify your images as inputs.

In [*qaboard.yaml*](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qaboard.yaml) edit and `inputs.globs` with a [glob pattern](https://docs.python.org/3/library/glob.html). Here is an example where your inputs are *.jpg* images:

```yaml
inputs:
  globs: '*.jpg'
```

When you do this, you no longer have to define an explicit list of input paths in your batches. You can instead use folders or even [globs/wildcards](https://docs.python.org/3/library/glob.html) (`*`, `**`...):

```yaml
# qa/batches.yaml
my-batch:
 inputs:
   - images
```

:::tip
To run on all the inputs found under `$database / $PATH` you can simply use `qa batch $PATH`.
:::


You can give multiple patterns:

```yaml
inputs:
  globs:
  - '*.jpg'
  - '*.bmp'
  - '*.dng'
```

A common use case is identifying folders containing a file patching a pattern, for instance movies given a sequence of frames, *frame_000.jpg*, *frame_001.jpg*... In this case you can use `use_parent_folder`:

```yaml {3}
inputs:
  globs: frame_000.jpg
  use_parent_folder: false
```

## Handling multiple input types (Advanced)
Big projects sometimes need to distinguish different types of inputs, which will be processed with a different logic.

```yaml {3-9}
# qaboard.yaml
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

```yaml {7}
# qa/batches.yaml
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
