---
id: lsf-integration
title: LSF Integration
sidebar_label: LSF Integration
---

QA-Board can use the LSF job management system to submit batch jobs.

:::important Reminder
If you don't want to use LSF, [read here how to make `qa batch` use a different backend](using-the-qa-cli#batch-runners).
:::

:::tip
LSF jobs with have your project name as LSF project (`-P`).
:::

## LSF project options
You can change the default LSF configuration with:

```yaml title="qaboard.yaml"
runners:
  # In doubt, ask advice from your manager / CAD / bqueues.
  lsf:
    queue: your_queue
    # max_threads: 8              # ask for eg 8 max threads when sending jobs to LSF (0=default)
    # max_memory: 8000            # ask for eg 8000M memory when sending jobs to LSF (0=default)
    # queue: my_queue
    # resources: RESOURCE_STRING
    # options: "-W 24:00"         # Specifiy freely other LSF options that bsub accepts
                                  # Will be added after all other CLI flags.
```

:::warning
`qa` doesn't use LSF's job arrays. If your algorithm takes very little time to run, maybe using them would be better. Create an issue or contact [Arthur Flam](mailto:arthur.flam@samsung.com). 
:::

## LSF options per batch

```yaml {3-5} title="qa/batches.yaml"
you-can-give-an-LSF-configuration:
  lsf:
    max_memory: 10000
    max_threads: 4
  configurations:
    - base
  inputs:
  - images/A.jpg
  - images/B.jpg
```

```yaml {2-3,8-10}
you-can-give-an-LSF-configuration-per-input:
  lsf:
    max_memory: 1000
  configuration:
    - base
  inputs:
    images/A.jpg:
    images/B.jpg:
      lsf:
        max_memory: 200
```

## LSF options on the CLI
You can use CLI options to override the defaults:

```bash
qa batch --help
# --snip--
  --lsf-threads INTEGER        restrict number of lsf threads to use. 0=no
                               restriction
  --lsf-max-memory INTEGER     restrict memory (MB) to use. 0=no restriction
  --lsf-queue TEXT             LSF queue (-q)
  --lsf-fast-queue TEXT        Fast LSF queue, for interactive jobs
  --lsf-resources TEXT         LSF resources restrictions (-R)
  --lsf-priority INTEGER       LSF priority (-sp)
  --lsf-options TEXT           Other LSF options (as 1 string, like '-W
                               24:00') that bsub can understand. Will be added
                               after all other CLI flags.
  --lsf-sequential / --lsf-parallel
```

## Connecting to LSF via a "bridge" host
It's needed for the server, that runs in a container, and sometimes to send LSF jobs from windows. There are two options:

1. Via environment variables:
```bash
export QA_RUNNERS_LSF_BRIDGE='ssh my_host_with_lsf_access {bsub_command}'
export QA_RUNNERS_LSF_BRIDGE='ssh my_host_with_lsf_access su {user} {bsub_command}'
```

1. Via project configuraton:
```yaml {5} title="qaboard.yaml"
runners:
  lsf:
    # --snip--
    bridge: 'ssh bridge_host'
```

:::tip
When using bridges, `qa` will explicitely ask LSF to run in your current working directory, so no need to play games with `ssh 'cd {cwd} && {bsub_command}'`...
:::
