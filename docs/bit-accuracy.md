---
id: bit-accuracy
sidebar_label: Bit Accuracy
title: Bit accuracy tests
---

## "Soft" bit-accuracy checks from the UI
The web application lets you view and compare all files created by your algorithm's runs:

- Files are marked depending on its status (identical, different, added, removed). Identical files are hidden by default.
- You can click on them to open qatools' viewer:

![bit accuracy viewer](https://qa/s/qatools/img/bit-accuracy-viewer.jpg)

:::note
The UI doesn't care about [*qatools.yaml*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml#L93)'s `bit-accuracy.patterns` *(discussed later)*.
:::

## Bit accuracy checks
You often want to know when your algorithm's results change, *especially if another team is busy implementing them in hardware*! **Your CI should warn you...**

Here is how you could implement this flow with GitlabCI:

```yaml
stages:
  - tests
  - bit-accuracy

tests-all:
  stage: tests
  script:
  - qa batch all

bit-accuracy-all:
  stage: bit-accuracy
  allowed_failure: true
  script:
  - qa check-bit-accuracy --group all
```

### What files are checked?
Bit accuray tests will check files matching glob/wildcard patterns defined in [*qatools.yaml*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml#L93)'s `bit-accuracy.patterns`

### What should we compare to?
By default, your results are compared against the **latest commit's from the `project.reference_branch`** in [*qatools.yaml*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml#L7). This said, if you're checking a merge on that branch, qatools will compare against the commit's parents. 

> If the commit you compare against has not finished its CI, qatools will  wait.

> You can opt-in to more complex behaviour in *[qatools.yaml](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml#L119)* with `bit-accuracy.on_reference_failed_ci`...

To compare against arbitrary branches, tags or commits, use `qa check-bit-accuracy --reference $git-ref`
