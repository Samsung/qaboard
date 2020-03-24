---
id: batches-running-on-multiple-inputs
title: Batches of inputs
sidebar_label: Batches of Inputs
---
:::important Reminder
Make sure you read [the section on input files](inputs)
:::

As we discussed, you can define batches of inputs in file(s) whose paths are given by `inputs.batches` in your [qaboard.yaml](https://github.com/Samsung/qaboard/blob/master/qatools/sample_project/qaboard.yaml#L25) configuration.

```yaml
# qa/batches.yaml (default)
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
  configurations:
  - base
  inputs:
  - Bayer/A.dng
  - Bayer/B.dng
# => configurations == ["base"]
# => the code would load base/config.cde
```

```yaml {2-4}
multiple-configurations:
  configurations:
    - base
    - low-light
  inputs:
  - Bayer/A.dng
  - Bayer/B.dng
#=> configurations == ["base", "low-light"]
#=> we merge 2 CDE configs 
```

```yaml {2-8}
configurations-can-be-complex-objects:
  configurations:
    - base
    - low-light
    - cde:
      - "-w 9920"
      - "-h 2448"
      - "-it BAYER10"
  inputs:
  - Bayer/A.dng
  - Bayer/B.dng
# configurations == ["base", "low-light", {"cde": ["-w 9920", "-h 2448", "-it BAYER10"]}]
# => Here we use the "cde" config parameter to pass CLI arguments to CDE.
```

```yaml {5,7-10}
each-input-can-have-its-own-configuration:
  configurations:
    - base
  inputs:
  - Bayer/A.dng:
    #=> configurations == ["base"]
  - Bayer/B.dng:
      - low-light
      - cde:
        - "-DD"
    #=> configurations == ["base", "low-light", {"cde": ["-DD"]}]
```

## Organizing your groups of inputs
### Group aliases
For convenience you can define aliases for groups you often run together. For instance you can do:

```yaml
# qa/batches.yaml
groups:
  two-batches:
  - first-batch
  - second-batch
```
```bash
qa batch two-batches
```

### Configuration aliases
For convenience you can define YAML aliases for common configurations

```yaml {1-3,7}
.base: &base
  - base
  - partial

hdr:
  configurations:
    - *base
    - hdr
  inputs:
    - A
    - B
    - C
#=> configurations == ["base", "partial", "hdr"]
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
  configurations:
    - *base
    - hdr_base
    - hdr_motion

.HDR-disabled: &HDR-disabled
  configurations:
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
