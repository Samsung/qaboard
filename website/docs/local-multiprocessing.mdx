---
id: local-multiprocessing
title: Local Multiprocessing
sidebar_label: Local Multiprocessing
---

By default, if you don't configure an async task queue, QA-Board will use [`joblib`](https://joblib.readthedocs.io/en/latest/) and **local** multiprocessing to run your batches.

## Running batches locally
If you configured an another runner, you can always:

```bash
qa batch --runner=local my-batch
```

## Configuration
There is only 1 option: `concurrency`. You have multiple options to set it up:

- Per batch:

```yaml title="qa/batches.yaml"
my-batch:
  inputs:
  - image.jpg
  local:
    concurrency: -1 # 1 concurrent run per CPUs, default
```

- Globally:

```yaml title="qaboard.yaml"
runners:
  default: local  # default
  local:
    concurrency: 1 # serially
```

-	On the CLI:

```
qa batch --local-concurrency 1
```

-	via the `QA_BATCH_CONCURRENCY` environment variable

:::tip
Read [joblib's docs](https://joblib.readthedocs.io/en/latest/generated/joblib.Parallel.html)
:::
