---
id: project-init
sidebar_label: Project Initial Setup
title: Adding QA-Board to your project
---

Go at the root of your project's git repository and run:

```bash
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
└── qaboard.yaml       # configuration file ⚙️
```

## *(Optional)* Gitlab Integration
If you integrate with Gitlab, you'll be able to:
- Get direct links to your code
- See user avatars
- Delete old results
- Access commits by their tag or branch names
- Wait for CI pipelines to end when checking if results changed vs the last version

:::note
In the past Gitlab was required. We'll work on enabling those features even if you use other git servers.  
:::

### How-to
1. Be one of the project's Maintainers.
2. Go to http://gitlab-srv/$YOUR_GROUP/PROJECT/settings/integrations.
3. Add an integration with:
  * __URL:__ `http://qa:5000/webhook/gitlab`
  * __Secret token:__ *(leave the field empty)*

> To test everything went well, Gitlab lets you "Test" your new hook. You should get a blue happy `200 OK` message  🔵🎉.
