---
id: deleting-old-data
sidebar_label: Deleting Old Data
title: Deleting Old Outputs and Artifacts
---

QA-Board lets you erase old outputs after a period of time.

## What data will *not* be deleted
Outputs from commits that are either:
- Recent (more info below)
- On the `project.reference_branch` from *qaboard.yaml*.
- Are on a **commit/tag/branch** listed as a `project.milestones` in *qaboard.yaml*.
- Are a milestone defined from QA-Board's UI.

Files "Exported" from QA-Board's UI are never deleted. You can do it yourself if needed. **TODO:** track them at least!

:::caution
QA-Board will set as a commit's branch the first it was seen on. If you merge with fast-forward rebased branches, then this information will not be what you expect. 
:::

## Configuring garbage collection
Data can be erased after a period of time where the commit has no new outputs.

```yaml title="qaboard.yaml"
storage:
  garbage:
    after: 1month
```

`after:` supports human-readable values like *2weeks*, *1year*, *3months*...

:::note
**TODO** Right now we only clean data for repositories [that have an integration with Gitlab](/docs/project-init).
:::

## Recovering lost data?
Well, you won't be able to do that. What you should try to do is make everything **reproducable**.
- Define your whole *environment as code*. Make sure your commits contain 100% of what is needed for your code to run. Tools you can use include `docker+Dockerfile`, etc.
- Make it easy to re-trigger your CI, so that it's straightfoward to re-builds, re-run your tests, and uploads artifacts to QA-Board.
- If necessary, make it also very easy to run manually something like

```bash
git checkout $hexsha
make
qa save-artifacts
qa batch my-batch
```

## Deleting commit artifacts
**Artifacts** are not deleted by default, you have to ask for it:

```yaml {4,5} title="qaboard.yaml"
storage:
  garbage:
    after: 1month
    artifacts:
      delete: true
```

If you want to keep some artifacts (maybe "small" coverage reports defined as `coverage_report: ...` in *qaboard.yaml*'s artifacts)

```yaml {6-7}
storage:
  garbage:
    after: 1month
    artifacts:
      delete: true
      keep:
      - coverage_report
      # also supports relative artifacts paths, e.g.
      - build/my_binary
```

Notes:
- The settings that are used are those in the latest commit of the `reference_branch` defined in *qaboard.yaml* 
- If you change those settings, artifacts for already deleted commits don't get deleted.
- When a `qa run` uses a commit that was deleted, or if you upload manifests for a deleted commit, it is marked as undeleted.
