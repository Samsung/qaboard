---
id: artifacts
sidebar_label: Artifacts
title: Artifacts
---
import useBaseUrl from '@docusaurus/useBaseUrl';

Artifacts are needed by QA-Board to start tuning experiments

## What are artifacts?
To run your code, you generally need:
- binaries compiled automatically during the continuous integration.
- wrapper scripts...
- depending on how you view things, trained networks or calibrated data.

> Defining those as artifacts makes it possible to upload them to QA-Board's storage, then start tuning experiments.


## Defining artifacts
Artifacts are defined with:

```yaml title="qaboard.yaml"
# Basic example
artifacts:
  binary:
    glob: build/binary
  configurations:
    globs:
    - configurations/*.json
    - "*.yaml"
```

:::tip
For convenience, *qaboard.yaml* and *qa/* are pre-defined as artifacts.
:::

In QA-Board, you can view each commit's artifacts in the "Configuration" tab.


<img alt="Artifacts" src={useBaseUrl('img/artifacts-tab.jpg')} />

## How to save artifacts?
After your build is done, call:

```bash
qa save-artifacts
```

Usually you can do it simply in your CI tool:

```yaml title="gitlab-ci.yml"
after_script:
  - qa save-artifacts
```