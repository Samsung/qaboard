---
id: batches-running-on-multiple-inputs
title: Batches of inputs
sidebar_label: Batches of Inputs
---
:::important Reminder
Make sure you read [the section on input files](inputs)
:::

As we discussed, you can define batches of inputs in file(s) whose paths are given by `inputs.batches` in your [qaboard.yaml](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qaboard.yaml#L25) configuration.

```yaml title="qa/batches.yaml (default)" 
my-batch:
 inputs:
   - A.jpg
   - B.jpg
```

```bash
qa batch my-batch
#=> qa run --input A.jpg
#=> qa run --input B.jpg

qa batch --batch first-batch --batch second-batch
```

## Setting a custom database per batch
```yaml {2-4}
you-can-override-the-default-database:
  database:
    linux: /mnt/database
    windows: '\\\\storage\\database'
  inputs:
  - Images/Demo3/A.jpg
  - Images/Demo2
```

## Specifying test configurations
:::important Reminder
Make sure you read [the section on configurations](identifying-inputs-files)
:::

Let's look at examples from one of Samsung's projects to illustrate how configurations can be given. In short, each image is processed by a tool named "CDE". We need to feed it config files and CLI arguments.

```yaml {2-3}
using-a-custom-configuration:
  configs:
  - base
  inputs:
  - Bayer/A.dng
  - Bayer/B.dng
# => configs == ["base"]
# => the code would load base/config.cde
```

```yaml {2-4}
multiple-configs:
  configs:
    - base
    - low-light
  inputs:
  - Bayer/A.dng
  - Bayer/B.dng
#=> configs == ["base", "low-light"]
#=> we merge 2 CDE configs 
```

```yaml {2-8}
configs-can-be-complex-objects:
  configs:
    - base
    - low-light
    - cde:
      - "-w 9920"
      - "-h 2448"
      - "-it BAYER10"
  inputs:
  - Bayer/A.dng
  - Bayer/B.dng
# configs == ["base", "low-light", {"cde": ["-w 9920", "-h 2448", "-it BAYER10"]}]
# => Here we use the "cde" config parameter to pass CLI arguments to CDE.
```

```yaml {5,7-10}
each-input-can-have-its-own-configuration:
  configs:
    - base
  inputs:
  - Bayer/A.dng:
    #=> configs == ["base"]
  - Bayer/B.dng:
      - low-light
      - cde:
        - "-DD"
    #=> configs == ["base", "low-light", {"cde": ["-DD"]}]
```

## Matrix batches
You can use "matrix" batches to run on combinations of configurations (and platfornms):

```yaml {4-10}
multiple-configs:
  inputs:
  - a.raw
  matrix:
    configs:
      -
          - base
          - tuning
      -
          - base

#=> `qa batch multiple-configs` will run
#   with [base, tuning] and [tuning]
```

> Per-input extra configurations still work.
>
> The syntax was inspired from [DroneCI](https://0-8-0.docs.drone.io/matrix-builds/), [GithubActions](https://help.github.com/en/actions/reference/workflow-syntax-for-github-actions#jobsjob_idstrategy), [AzurePipelines](https://docs.microsoft.com/en-us/azure/devops/pipelines/yaml-schema?view=azure-devops&tabs=example%2Cparameter-schema#matrix).

### Interpolation
Matrix variables are interpolated using the `${matrix.variable}` syntax:

```yaml
my-batch-multiple-configs:
  inputs:
  - image.raw
  matrix:
    version: [1, 2]
  configs:
    - base-v${matrix.version}

# => will run with [base-v1] and [base-v2]
```

And elaborate complex testing strategies:

```yaml
my-batch-multiple-values:
  inputs:
  - image.raw
  matrix:
    threshold: [1, 2, 3, 4]
    mode: ["a", "b"]
  configs:
    - base
    - block.threshold: $matrix.threshold
    - block.mode: $matrix.mode

# => will start 8 runs run with
#     [base, block.threshold: 1, block.mode: a
#     [base, block.threshold: 1, block.mode: b
#     [base, block.threshold: 2, block.mode: a
#     etc
```


## Aliases for groups of batches
For convenience you can define aliases for batches you often run together. For instance you can do:

```yaml title="qa/batches.yaml"
aliases:
  two-batches:
  - first-batch
  - second-batch
```
```bash
qa batch two-batches
```

## YAML anchors and aliases
For convenience you can define YAML anchors for common configurations

```yaml {1-3,7}
.base: &base
  - base
  - partial

hdr:
  configs:
    - *base
    - hdr
  inputs:
    - A
    - B
    - C
#=> configs == ["base", "partial", "hdr"]
```

:::note
YAML "aliases" and "anchors" are standard YAML feature. [Read more here](https://confluence.atlassian.com/bitbucket/yaml-anchors-960154027.html).
:::

### Reusable configurations/inputs
Sometimes you want to mix and match reusabe definitions of configs and inputs. YAML anchors let you do it:

```yaml
.inputs_hdr: &inputs_hdr
  inputs:
    - A
    - B

.lots_of_inputs_hdr: &lots_inputs_hdr
  inputs:
    - A
    - B
    - C
    - D
    - E
    - F

.HDR: &HDR
  configs:
    - *base
    - hdr_base
    - hdr_motion

.HDR-disabled: &HDR-disabled
  configs:
    - *base

hdr:
  <<: *HDR
  <<: *inputs_hdr
no-hdr:
  <<: *HDR-disabled
  <<: *inputs_hdr
# qa --batch-label hdr    batch hdr
# qa --batch-label no-hdr batch no-hdr

# Maybe on nightly runs you want to run lots of inputs
lots-of-hdr-inputs:
  <<: *HDR
  <<: *lots_inputs_hdr
lots-of-no-hdr-inputs:
  <<: *HDR-disabled
  <<: *lots_inputs_hdr
```
