---
id: monorepo-subprojects
sidebar_label: Mono/Multi git repos
title: Monorepo/Multi-repo support
---

## Organizing monorepos with subprojects
- **How?** Each *qaboard.yaml* in your repo will define a different QA-Board "sub"-project. Each subproject will have its own data/runs.
- **Terminology**: if your repository url is `git@github.com:organization/algorithms`, by default the project name is will be `organization/algorithms`. It is a "_root_", at the top-level of your git repository. If you create a new `qaboard.yaml` under `algorithms/algorithm-a`, and call `qa` from `algorithm-a`, `qa` will consider that you work in a new project: `organization/algorithms/algorithm-a`. It is composed of `root_project/subproject` where `subproject` is `algorithm-a` - where the new `qaboard.yaml` is located relative to the root.
- **Working directory:** When calling `qa [command]`, `qa` will first change the working directory to the top-most directory of your git repo, where you have your root _qaboard.yaml_.
- **Relative paths** in _qaboard.yaml_ configuration files are always relative to the repository root.
- **Submodules**: If you work in a submodule that uses QA-Board, and the git repo above also uses QA-Board, it can be confusing for `qa` to know what to do... So add `root: true` to your submodule's _qaboard.yaml_
- `project.avatar_url` and `project.description` can be changed to display relevant information in the Web UI.
- **In your `project.entrypoint:run()`**: you can `from qaboard.config import project, project_root, subproject` if needed. 
- **Layering:** _project/sub/qaboard.yaml_ will inherit everything from _project/qaboard.yaml_, deep-merged. As a helper you can use the keyword `super` to add items to lists:

```yaml 
# project/qaboard.yaml
outputs:
    visualizations:
    - path: image.jpg

# project/subproject/qaboard.yaml
outputs:
    visualizations:
    - super
    - path: file.txt
#=> the subproject will have the 2 visualizations  
```

## Refactoring config files when working with multiple git repositories 
A _qaboard.yaml_ file can `include` another. In this case configurations will be deep-merged. Path will still be relative to the root of the project that includes the config file.

It has been useful for us when dealing with many repositories that all have almost the same configuration. For example, if you have a repositories called `project-a`/`project-b`..., and it's safe to assume they will always be checked-out under a parent repo, you can do:

```yaml title="projects/project-a/qaboard.yaml" 
# assuming projects/common contains shared files
include: ../common/qaboard.yaml

project:
  name: projects/project-a
  url: git@github.com:projects/project-a
```

To make it even easier to use the same config everywhere, you can use the python f-string syntax with the 2 variables `root_path` and `project_path` (which is `{root_path}/{subproject}`). It makes it possible to refactor the above as:

```yaml title="projects/project-a/qaboard.yaml"
include: ../common/qaboard.yaml

project:
  name: "projects/{project_path.name}"
  url: git@github.com:your-organization/{project_path.name}
```
