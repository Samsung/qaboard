---
id: bit-accuracy
sidebar_label: Bit Accuracy
title: Bit accuracy tests
---
import useBaseUrl from '@docusaurus/useBaseUrl';

QA-Board was started at Samsung, within a business unit focused on hardware digital design. Because of those root, QA-Board provides a number of ways to check that results are equal from commit to commit.

## "Soft" bit-accuracy checks from the UI
The web application lets you view and compare all files created by your algorithm's runs:

- Files are marked depending on their status (identical, different, added, removed...). Identical files are hidden by default.
- You can click on each file to open it with an appropriate file viewer:

<img alt="bit accuracy viewer" src={useBaseUrl('img/bit-accuracy-viewer.jpg')} />

:::note
The UI doesn't care about [*qaboard.yaml*](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qaboard.yaml#L93)'s `bit-accuracy.patterns` *(discussed later)*.
:::

### "Hard" `qa check-bit-accuracy` on the CLI
`qa check-bit-accuracy $batch` compares the results of `qa batch $batch` to:
- The latest results on `project.reference_branch` from [*qaboard.yaml*](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qaboard.yaml) (default: *master*).
- ...unlesss you're checking a merge made to that branch. In which case the commit's parents will act as references.
- You can ask to compare versus a specific git commit, branch or tag with `qa check-bit-accuracy --reference $git-ref`.

> If the commit you compare against has not finished its CI, `qa` will  wait.

:::note Custom Needs
You can opt-in to more complex behaviour in *[qaboard.yaml](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qaboard.yaml)* with `bit-accuracy.on_reference_failed_ci`, in case there are not results in the reference commit. Maybe the build failed, in which case you want to compare against the previous commit... If you're interested open an issue we'll add more details to the docs.
:::

If output files are different, `qa` prints a report and exists with a failure.

:::note
For specific use-case, there is also `qa check-bit-accuracy-manifest` which checks accuracy versus a manifest file stored in the database next to the input files. To generate those manifests, use `qa batch --save-manifests-in-database`.
:::

### What files are checked?
Files matching the patterns defined as `bit-accuracy.patterns` in [*qaboard.yaml*](https://github.com/Samsung/qaboard/blob/master/qaboard/sample_project/qaboard.yaml#L93) will be checked.

:::note
If you work with text files on both Linux and Windows, EOL can make things tricky... You can decide what files are plaintext or binary using `bit-accuracy.plaintext` *or* `bit-accuracy.binary`.
:::



## Sample CI for bit-accuracy checks
You often want to know when your algorithm's results change, *especially if another team is busy implementing them in hardware*!

Here is how you could get the CI to warn you with GitlabCI:

```yaml title="qaboard.yaml"
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
  - qa check-bit-accuracy --batch all
```
