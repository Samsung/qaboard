---
id: monorepo-subprojects
sidebar_label: Monorepos
title: Monorepo and subproject support
---
Each *qaboard.yaml* in your repo will define a different QA-Board project.

## Subprojects
- When calling `qa [command]`, `qa` will change the working directory to the top-most directory of your git repo, where you have your root _qaboard.yaml_.
- If you work in a submodule that uses QA-Board, and the git repo above also uses QA-Board, it can be confusing for `qa` to know what to do... So add `root: true` to your submodule's _qaboard.yaml_
- Paths in _qaboard.yaml_ are always relative to the repository root.
- `project.avatar_url` and `project.description` can be changed to display relevant information in the Web UI.
- You can from `qaboard.config import ...` various variables telling you about the different subprojects. It's not documented yet, but we try to keep everything stable. 

## Layering QA-Board projects with inheritance
- _project/sub/qaboard.yaml_ will inherit everything from _project/qaboard.yaml_
- You can use the keyword `super` to add items to lists:

```yaml
# project/sub/qaboard.yaml
outputs:
    visualizations:
    - super
    - path: newfile.txt
```

## Refactoring _qaboard.yaml_ files 
A _qaboard.yaml_ file can `include` another, if it's at the top-level. Path are relative to the root QA-Board directory.