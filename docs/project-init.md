---
id: project-init
sidebar_label: Project Initial Setup
title: Adding QA-Board to your project
---

Go at the root of your project's git repository and run:

```bash
# Sorry we need a utf8 locale
# export LC_ALL=en_US.utf8 LANG=en_US.utf8            # bash users
# setenv LC_ALL en_US.utf8 ; setenv LANG en_US.utf8   # csh  users

qa init
#=> 🎉🎉🎉
```

Along with previously existing files and directories, your root directory will now contain a structure similar to:

```
root-git-repository
├── qa
│  ├── main.py         # sample entrypoint that runs your code
│  ├── batches.yaml    # examples of how to run multiple tests
│  └── metrics.yaml    # examples of how to define KPIs
└── qatools.yaml       # => the project configuration
```

> Feel free to take a look at the project configuration,[ *qatools.yaml*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml).

## Gitlab integration
Create a Gitlab integration to keep the QA-Board and `git` in sync.

1. Be one of the project's Masters / Maintainers.
2. Go to http://gitlab-srv/$YOUR_GROUP/PROJECT/settings/integrations.
3. Add an integration with:
  * __URL:__ `http://qa:5000/webhook/gitlab`
  * __Secret token:__ *(leave the field empty)*

> To test everything went well, Gitlab lets you "Test" your new hook. You should get a blue happy `200 OK` message  🎉

:::important To make sure you can view your runs...
Commit thoses changes and push!

*For now, the web interface can only show runs from commit that were pushed to Gitlab.* We plan on remove this restriction, and supporting other git servers (e.g. GitHub).
:::