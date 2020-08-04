---
id: dag-pipelines
title: Defining Pipelines / DAG
sidebar_label: Defining Pipelines / DAG
---

:::caution Work-In-Progress
Nothing here is implemented available, it's at the API design stage. [[Link-to-issue]](https://github.com/Samsung/qaboard/issues/10).
:::

Currently QA-Board lacks expressivity for the common use-case of:
1. Run an algo on some images
2. Calibration
3. Validation

Likewise, it can’t handle nicely machine learning workflows (training/validation).


Below are two workarounds people have used until now, and a proposition for built-in support in QA-Board.

> Can you send me feedback / alternative ideas, or share to relevant people? Especially if you have experience with various flow engines, e.g. DVC. Thanks!
>
> **The goal is a solution that is simple, expressive, and enables caching.**

1. Run qa batch multiple times, with each run expecting that results of the previous run are available _(as done with @rivka, @TF)_.
  * **(+)** Rather easy to do
  * **(-)** The logic is outside QA-Board – it can’t easily be used for tuning from the web UI 
2. Create a "meta" run, with a heavy run() function that itself takes care of everything  _(as done with @eliav)_
  * **(+)** Easy to do
  * **(-)** But very custom and not easy to use
  * **(-)** There many tricky corners (running locally, filesystem issues on LSF) that should not be the  engineer’s concern.
3. "Built-in support" by QA-Board.
One possible way we could do it is by extending the syntax used to defined batches with a `needs:` keyword:

Simple example:
```yaml
batch1:
  inputs:
  - A.jpg
  - B.jpg
  configurations:
  - base

batch2:
  needs: batch1
  type: script
  configurations:
  - python my_script.py {o.output_dir for o in depends["batch1"]}

# ? there is not really an "input" for a script, especially if it uses "depends"
# ? if we depend on something I guess we could do without input, provide None...
```


"Real-world" example:

```yaml
my-calibration-images:
    configurations:
    - base
    inputs:
    - DL50.raw
    - DL55.raw
    - DL65.raw
    - DL75.raw

my-calibration:
    needs:
      calibration_images: my-calibration-images
    type: script
    configurations:
    - python calibration.py ${o.output_directory for o in depends[calibration_images]}

my-evaluation-batch:
    needs:
      calibration: my-calibration
    inputs:
    - test_image_1.raw
    - test_image_2.raw
    - test_image_3.raw
    configurations:
    - base
    - ${depends[calibration].output_directory}/calibration.cde
```

```shell
$ qa batch my-evaluation-batch
#=> qa batch my-calibration-images
#=> qa batch my-calibration
#=> qa batch my-evaluation-batch
```

- **(+)** simple for users (I think so?)
- **(+)** caching for free
- **(?)** need to define a clear API: how each job can lookup results of earlier jobs… And likely we will need naming-conventions for parameter tuning…
