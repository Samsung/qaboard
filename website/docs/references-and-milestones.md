---
id: references-and-milestones
title: References & Milestones
sidebar_label: References & Milestones
---

when looking at results, it is important to *compare* them to a reference.  It could to a previous version, results from a benchmark

## Comparing versus a reference
In results pages, QA-Board always compares the commit you selected (labeled `new`) versus a reference (`ref`):

![new-vs-reference](/img/comparing-new-and-reference.png)

The reference is by default the latest commit from the project's reference branch:

```yaml
# qatools.yaml
project:
    reference_branch: master
```

To change the selected `new` or `ref` commit, you can edit the commit ID field in the navbar. Hovering it gives you a menu with other options:
![commit-select-menu.png](/img/commit-select-menu.png)

:::tip
Clicking on the branch name in the navbar will select the latest commit on the branch.
:::

## Project References
You can also list in *qatools.yaml* other versions as milestones.

```yaml {4-7}
# qatools.yaml
project:
    reference_branch: master
    milestones:
    - release/v1.0.0      # tag
    - feature/better-perf # branch
    - e45123a3565         # commit id
```

## Defining Milestones from QA-Board
Every user can save milestones with the “star” icon in each commit navbar:

![save-as-milestone](/img/save-as-milestone.png)

If needed, you can give them a name and leave notes:

![milestone-details](/img/milestone-details.png)

You'll now be able to select them in the commit ID hover menu.

:::tip
Milestones can be shared with everybody - or kept private.
:::