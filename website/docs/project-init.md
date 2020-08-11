---
id: project-init
sidebar_label: Project Setup
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
├── qaboard.yaml       # configuration
└── qa
   ├── main.py         # sample entrypoint that runs your code
   ├── batches.yaml    # examples of how to run multiple tests
   └── metrics.yaml    # examples of how to define KPIs
```


## *(Optional)* Gitlab Integration
If you integrate with Gitlab, you'll be able to:
- Update GitlabCI with your runs' statuses
- Get direct links to your code
- See users' avatars
- Delete old results
- Access commits by their tag or branch names
- Wait for CI pipelines to end when checking if results changed vs the last version

:::note
In the past Gitlab was required. We'll work on enabling those features for e.g. Github.  
:::

### How-to
1. Make sure you [started QA-Board with](/docs/deploy) a `GITLAB_HOST` and a `GITLAB_ACCESS_TOKEN` with `read_repository` scope.
2. Be one of the project's Maintainers.
3. Go to http://gitlab-srv/$YOUR_GROUP/PROJECT/settings/integrations.
4. Add an integration with:
  * __URL:__ `http://localhost:5151/webhook/gitlab`. Replace localhost with your hostname if you setup any DNS/SSL..
  * __Secret token:__ *(leave the field empty)*

> To test everything went well, Gitlab lets you "Test" your new hook. You should get a blue happy `200 OK` message  🔵🎉.
