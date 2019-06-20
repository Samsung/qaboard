---
id: project-init
sidebar_label: Enabling qatools
title: Adding qatools to your project
---

## Adding qatools to your project
Go at the root of your project's git repository and run:

```bash
# setenv LC_ALL en_US.utf8
# setenv LANG en_US.utf8

qa init
#=> 🎉🎉🎉
```

Along with previously existing files and directories, your root directory will now contain a structure similar to:

```
root-git-repository
├── qatools
│  ├── main.py         # sample entrypoint that runs a test
│  ├── batches.yaml    # examples of how to run multiple tests
│  └── metrics.yaml    # examples of how to define KPIs
└── qatools.yaml       # => the project configuration
```

> Feel free to take a look at the project configuration,[ *qatools.yaml*](http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools.yaml).

## Gitlab integration

4. Create a gitlab integration to keep the qatools and git in sync

- Be one of the project's Masters / Maintainers.
- Go to http://gitlab-srv/$YOUR_GROUP/PROJECT/settings/integrations.
- Add an integration with:
  * __URL:__ `http://qa:5000/webhook/gitlab`
  * __Secret token:__ *(leave the field empty)*

> To test everything went well, Gitlab lets you "Test" your new hook. You should get a blue happy `200 OK` message  🎉
