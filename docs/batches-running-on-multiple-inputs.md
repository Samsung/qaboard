---
id: batches-running-on-multiple-inputs
title: Running on batches of inputs
sidebar_label: Input Batches
---

::: tip
Are you using the old `XLS+json` way of defining batches? ? There is a [conversion script](http://gitlab-srv/CDE-Users/HW_ALG/blob/develop/tools/convert_tests_xls_to_yaml.py) to help you migrate!
:::

## How do I run multiple inputs at once?
If you defined a batch of inputs called *my-batch*, you run on all its inputs with:
```bash
qa batch my-batch
qa batch --batch my-first-batch --batch my-second-batch
qa batch --help
```

## Where are those batches defined?
You can define batch of inputs in file(s) whose paths are given by  `inputs.batches` in your [qatools.yaml](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml#L25) configuration.

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
```

::: note
Path are relative to *qatools.yaml*'s' `inputs.database`
:::

::: tip
You can also use wildcards/globs.

To run on all the inputs found under `$database / $PATH` you can also use `qa batch $PATH`.
:::

## How do I tell what inputs I want to run?
```yaml
basic-list-of-inputs:
  inputs:
  - DualGen3_WideAngle_IMU_BL10cm_mark25/Demo2
  - DualGen3_WideAngle_IMU_BL15cm/Demo_set/Scene_5-1/Scene_5-1.bin


you-can-override-the-default-database:
  database:
    linux: /net/f2/algo_archive/DVS_SLAM_Database
    windows: '\\\\netapp\\algo_archive\\DVS_SLAM_Database'
  inputs:
  - DualGen3_WideAngle_IMU_BL10cm_mark25/Demo2
  - DualGen3_WideAngle_IMU_BL15cm/Demo_set/Scene_5-1/Scene_5-1.bin
```

::: note
Some project need to work with multiple types of inputs. You can define their properties in *qatools.yaml*'s` inputs.types.$myType`. Then:
```yaml
my-movies
  type: movie
  inputs:
  - video_1.mp4
  - video_2.mp4
```
:::

## How do I specify my inputs' configurations?
:::note reminder
In the `run(context)` function, the current configuration is `context.obj['configurations']`. It defaults to an empty list (`[]`), unless you specify otherwise as a default `inputs.configurations`in *qatools.yaml*.
:::

While `qatools` gives you freedom to interpret configurations however you want, projects usually standardize on setups like:

```yaml
configurations:                 # each configuration is a partial config, merged with the earlier ones
- base                          #   load from ./configurations/{base}.yaml
- /absolute/path/to/config.yaml #   read from absolute paths for convenience
- key: value                    #   give directly parameters...
```


Let's look at examples from the `HW_ALG` project:

```yaml
using-a-custom-configuration:
  configurations:
  - workspace/base
  inputs:
  - Bayer/MCC_700lux_BPCNRoff_00.dng
  - Bayer/MCC_700lux_BPCNRoff_01.dng
# => configurations == ["base"]
# => the code would load workspace/base/config.cde


multiple-configurations:
  configurations:
    - base
    - low-light
  inputs:
  - Bayer/MCC_700lux_BPCNRoff_00.dng
  - Bayer/MCC_700lux_BPCNRoff_01.dng
#=> configurations == ["base", "low-light"]
#=> we merge 2 CDE configs 


configurations-can-be-complex-objects:
  configurations:
    - base
    - low-light
    - cde:
      - "-w 9920"
      - "-h 2448"
      - "-it BAYER10"
  inputs:
  - Bayer/MCC_700lux_BPCNRoff_00.dng
  - Bayer/MCC_700lux_BPCNRoff_01.dng
# configurations == ["base", "low-light", {"cde": ["-w 9920", "-h 2448", "-it BAYER10"]}]
# => Here we use the "cde" config parameter to pass CLI arguments to CDE.


each-input-can-have-its-own-configuration:
  configurations:
    - base
  inputs:
  - Bayer/MCC_700lux_BPCNRoff_00.dng:
    #=> configurations == ["base"]
  - Bayer/MCC_700lux_BPCNRoff_01.dng:
      - low-light
      - cde:
        - "-DD"
    #=> configurations == ["base", "low-light", {"cde": ["-DD"]}]
```



## Organizing your groups of inputs

### Groups of groups
For convenience you can define aliases for groups you often run together:
groups. If you want to run both `my-first-batch` and `my-second-batch` when you run `qa batch ci`:

```yaml
groups:
  ci:
  - my-first-batch
  - my-second-batch
```

### Configuration aliases
For convenience you can define aliases for common configurations

```yaml
.base: &base
  - base
  - partial
  - subchain

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

#### Reusable configurations/inputs
Sometimes you want to mix and match reusabe definitions of configs and inputs. YAML anchors let you do it:

```yaml
# You want to reuse those lists of inputs across all HDR inputs
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




## LSF cluster integration
At SIRC we're fortunate to have a big cluster with ~100 servers. qatools uses its task management tool (LSF) to submit batch jobs.

> To run jobs locally on Linux, you can either define in *qatools.yaml* `runners.default: local` or use `qa batch --runner local`. On Windows jobs are always local. The number of concurrent local jobs is `runners.local.concurrency`. 

You can change in your project's [*qatools.yaml*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml#L107) the default LSF configuration:

```yaml
runners:
  # In doubt, ask advice from your manager / CAD / bqueues.
  lsf:
    user: arthurf
    queue: alg_q
    # qatools uses a fast queue to launch jobs that create subsequent LSF jobs
    # It helps get faster feeback about which outputs are pending
    fast_queue: alg_fast_q
    # threads: 0        # ask for eg 8 max threads when sending jobs to LSF (0=default)
    # memory: 0         # ask for eg 8000M memory when sending jobs to LSF (0=default)
```

:::warning
qatools doesn't use LSF's job arrays. If your algorithm takes very little time to run, maybe using them would be better. Contact [Arthur Flam](mailto:arthur.flam@samsung.com). 
:::

You can tweak the LSF configuration at the group level:

```yaml
# batches.yaml
you-can-also-give-an-LSF-configuration:
  lsf:
    memory: 1000
    threads: 1000
  configurations:
    - base
  inputs:
  - Bayer/MCC_700lux_BPCNRoff_00.dng
  - Bayer/MCC_700lux_BPCNRoff_01.dng


you-can-also-give-an-LSF-configuration-per-input:
  lsf:
    memory: 1000
  configuration:
    - base
  inputs:
    DualGen3_WideAngle_IMU_BL10cm_mark25/Demo2:
    DualGen3_WideAngle_IMU_BL15cm/Demo_set/Scene_5-1/Scene_5-1.bin:
      lsf:
        memory: 200
```

You can also use CLI options to override the defaults:

```bash
qa batch --help
# --snip--
  --lsf-threads INTEGER           restrict number of lsf threads to use. 0=no restriction
  --lsf-memory INTEGER            restrict memory (MB) to use. 0=no restriction
  --lsf-resources TEXT            LSF resources restrictions (-R)
  --lsf-sequential / --lsf-parallel
```