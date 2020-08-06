---
id: using-the-qa-cli
sidebar_label: QA CLI Tips
title: Tips for CLI usage
---
import useBaseUrl from '@docusaurus/useBaseUrl';

## CLI flags worth knowing
## `qa --help`
All commands have some help:

```bash
qa --help
qa batch --help
```

## `qa --share`
When you run `qa batch` or `qa run` on your terminal, results are saved locally under **output/**, and *they are not visible in QA-Board*. To make them visible:

:::tip
If you don't like this default, make `--share` the default via  

```bash
# .bashrc or other shell config
alias qa="qa --share"

# you can also use an environment variable
export QA_SHARE=true
```
:::


## `qa --dryrun`
`qa` commmands support a `--dryrun` mode, where they print actions they would take, but don't actually do anything. In particular it helps see quickly what inputs you defined in a batch:

```bash
qa --dryrun batch my-batch
# qa run --input image/A.jpg
# qa run --input image/B.jpg
```

:::note
For `qa --dryrun run`, you are expected to handle `if context.dryrun: ...` yourself in `run()`. The use-case is usually printing how you would call an executable, for debugging.
:::

## `qa --label my-label`
Everytime you `qa run`, it erases previous results. So if you want compare different versions by tweaking doing `qa run`, it won't work. Fortunately, `qa` lets you give a "label", or "experiment name" to runs. Results with different labels are stored separately:

```
qa --label without-optimizations batch validation-images
qa --label    with-optimizations batch validation-images
```

<img alt="select-batch" src={useBaseUrl('img/select-batch.png')} />

:::tip
To keep previous output files, use `qa batch/run --keep-previous` or `EXPORT QA_KEEP_PREVIOUS=true`. It can be useful if you are debugging long runs and implemented a caching mecanism. *(Experimental)*
:::

## `qa batch`
### Batch Runners
While `qa run` uses the local environment, `qa batch` will offload computation to a "runner" backend. Currently:
- On Windows we use [`joblib`](http://joblib.readthedocs.io/) for parallel computing. You can set the concurrency with `QATOOLS_BATCH_CONCURRENCY` and [other environment variables](https://joblib.readthedocs.io/en/latest/parallel.html) from `joblib`. `runners.local.concurrency` in *qaboard.yaml* also works...
- On linux we use SIRC's LSF cluster

You can also set the runner via `--runner=local`, and even set a default with `runners.default: local` in *qaboard.yaml*.

:::note Help needed for more runner!
We intent on supporting more task runners: `python-rq` or `celery`, maybe even a custom one with just list of hosts to `ssh` into... Ideally we'll implement a couple integrations, then write integration docs and rely on the community. Maybe we can piggyback on `joblib` if other project provide distributed backend...
:::

### Dealing with existing results
When you try to re-run already existing results, The behaviour of `qa batch` can be changed with the `--action-on-existing` flag:
- `--action-on-existing=run`: overwrite the old results (default).
- `postprocess`: only call the `postprocess()` function, not `run()+postprocess()` as usual. (Note: it's also provided by `qa postprocess`)
- `sync`: update the output file manifest and read metrics from *$output_dir/metrics.json*. (Note: it's also provided by `qa sync`)
- `skip`: do nothing

---

## Connecting to a custom QA-Board instance
Use `qa --offline` to ensure you don't connect to a QA-Board instance. It's useful if... you don't have one (?).
The default connection settings can be overriden by environment variables. For example:

```bash
export QABOARD_DB_PROTOCOL=http
export QABOARD_DB_HOST=qa
export QABOARD_DB_PORT=5000
```

