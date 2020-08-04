---
id: where-is-the-data
sidebar_label: Where is the data?
title: Where is the data saved?
---

When output files are saved at a centralized location, we can display them from the web application or easily access them from scripts.

## Where is the data saved?
- **Metadata** on outputs, commits, etc is managed by the QA-Board server with postgresql.
- **Local runs**'s output files  are saved in the *local* current directory under `output/`.
- **Shared runs**'s output files (`qa --share`) are saved at a centralized location managed by QA-Board.
- **Artifacts** are saved at a centralized location. It makes it possible to start tuning experiments from QA-Board.

QA-Board saves the data under:

```yaml title="qaboard.yaml"
storage: /mnt/qaboard/
```

:::tip
In most cases that's all you need, so you can skip to the next page!
:::

### Split storage for output and artifacts
In some cases you want to separate the storage of outputs and artifacts (maybe to comply with quota policies...):
```yaml
storage:
  outputs: /mnt/qaboard/outputs
  artifacts: /mnt/qaboard/artifacts
```

:::note
To access non-default storage locations from QA-Board, make sure they are mounted. Refer to [the server bringup docs](/deploy#create-a-directory-to-store-results)
:::

### Dealing with different mount names on Windows
```yaml
storage:
  linux: /mnt/qaboard
  windows: //shared/qaboard
```

### Using variables in storage locations
You can use `project`, `subproject` `{user}`, and their attributes. For instance:

```yaml
storage:
  artifacts: /mnt/{subproject.parts[0]}/artifacts
  outputs:
    linux: /mnt/{subproject.name}/outputs/{user}
    windows: //shared/{subproject.name}/outputs/{user}
```


:::note
Avoid using `{user}` for the artifacts location: you want some stability for this!
Even if you use `{user}` for outputs, if you ran a first tuning as a user then with a second as another, you'll lose easy access to files related to the 1st tuning.... It's usually not really a big deal as we're just talking about the STDOUT of `qa batch`...

**TODO:** Maybe `{user}` should evaluate to the current user name for outputs and to the committer name for artifacts. 
:::

## Storage locations
In *qaboard.config.py* the location where things are stored is defined via:
- `artifacts_root`: `/mnt/qaboard`
- `artifacts_project`: `/mnt/qaboard/your/project`
- `artifacts_commit_root`: `/mnt/qaboard/your/project/commits/$hash/subproject`
- `artifacts_commit`: `/mnt/qaboard/your/project/commits/$hash`
- `artifacts_branch`: `/mnt/qaboard/your/project/branches/branch-slug`

Similarly, there are also: `outputs_root`, `outputs_project`, `outputs_commit`, `outputs_commit_root`.

:::tip
In your CI, you can save e.g. coverage reports at `$(qa get artifacts_branch)`, and make them easily [accessible as links](https://samsung.github.io/qaboard/docs/triggering-third-party-tools) with `href: /s/mnt/qaboardyour/project/branches/{commit.branch_slug}/coverage`.

**TODO:** We could simplify that API a tiny bit with e.g. `href: "{branch.artifacts}/coverage"`...
:::

## TODO: Support for usual blob storage like S3
We can get hints from connex projects facing the same needs:
- [in MLflow](https://github.com/mlflow/mlflow/tree/dcda3767d4119713cbf8d33ef5ab31655183cb48/mlflow/store/artifact)
- [in DVC](https://github.com/iterative/dvc/tree/master/dvc/tree), [docs](https://dvc.org/doc/command-reference/remote), [deps](https://github.com/iterative/dvc/blob/master/setup.py#L87)
