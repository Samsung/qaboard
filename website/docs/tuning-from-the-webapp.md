---
id: tuning-from-the-webapp
sidebar_label: Tuning from QA-Board
title: Enabling tuning and extra runs from QA-Board
---
import useBaseUrl from '@docusaurus/useBaseUrl';


## How to do tuning or trigger extra runs from QA-Board
When doing QA or during development, you often want to run the code/configs from a given commit on new tests. QA-Board lets you define and runs batches of tests with extra tuning parameters:

<img alt="Tuning from the UI" src={useBaseUrl('img/tuning-from-the-ui.jpg')} />

## Enabling tuning from QA-Board

### Handling tuning parameters
You entrypint's `run()` function should do something with `context.obj['extra_parameters']`. It's a regular python `dict` with `{"tuning_key": value}`. Ideally, just treat as you would do for an element in `context.obj['configurations']`.

:::note
We'll likely improve the API: in the future we'll provide `context.obj['configurations']` with the "tuning on top", and `context.obj['parameters']` with all the key-value items in all the configurations, deep-merged.
:::

### Build Artifacts
1. **Define artifacts:** you must define the "artifacts" needed to run your software. Besides the source, you might need compiled binaries, configurations, trained networks, etc. Artifacts are defined in [qaboard.yaml](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qaboard.yaml#L85):

```yaml title="qaboard.yaml"
artifacts:
  binary:
    glob: 'build/sample_project'
  configurations:
    glob: configurations/*.json
```

> For convenience, *.qaboard.yaml* and *qa/* are saved automatically.
>
> The artifacts are shown in the UI under the commit's "Configuration" tab

2. **Save the artifacts** when your build/training is done. In your CI, you will want to execute:

```bash
qa save-artifacts
```

### Task runner
You need to configure a task runner, that will execute tuning runs asynchronously. We recommend getting started with Celery. All the details are on the [next page](celery-integration)!
