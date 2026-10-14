# Proposal: pipelines (DAGs) of batches

Status: proposal, not implemented. It used to be a docs page (`website/docs/dag-pipelines.mdx`); it moved here
because it describes a design, not a feature. Discussion: [issue #10](https://github.com/Samsung/qaboard/issues/10).
A "user-side" implementation exists in some projects; the plan is to upstream it into the core project.

## The problem
QA-Board lacks expressivity for a common use-case:
1. Run an algorithm on some images,
2. calibrate from those results,
3. validate the calibration on other images.

Likewise, it doesn't handle machine learning workflows (training, then validation) nicely.

**The goal is a solution that is simple, expressive, and enables caching.** Feedback from people who used flow
engines (e.g. DVC) is welcome.

## Workarounds used today
1. **Run `qa batch` several times**, each batch expecting the results of the previous one to be available.
   - (+) Rather easy to do.
   - (-) The logic is outside QA-Board: it can't easily be used for tuning from the web app.
2. **A "meta" run**, whose heavy `run()` function takes care of everything.
   - (+) Easy to do.
   - (-) Very custom, and not easy to use.
   - (-) Many tricky corners (running locally, filesystem issues on LSF) that should not be the engineer's concern.

## Proposal: built-in support with `needs:`
Extend the syntax used to define batches with a `needs:` keyword.

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
# ? if we depend on something, we could do without inputs, and provide None...
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
    - ${depends[calibration].output_directory}/calibration.yaml
```

```shell
$ qa batch my-evaluation-batch
#=> qa batch my-calibration-images
#=> qa batch my-calibration
#=> qa batch my-evaluation-batch
```

- (+) Simple for users (to be confirmed).
- (+) Caching for free.
- (?) Needs a clear API: how each job looks up the results of earlier jobs. Parameter tuning will likely need
  naming conventions too.
