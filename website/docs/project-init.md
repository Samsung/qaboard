---
id: project-init
sidebar_label: Project Initial Setup
title: Adding QA-Board to your project
---

Go at the root of your project's git repository and run:

```bash
qa init
#=> 🎉🎉🎉

# If you get errors about not using a utf8 locale, you can likely: 
#   export LC_ALL=C.utf8 LANG=C.utf8
```

Along with previously existing files and directories, your root directory will now contain a structure similar to:

```
root-git-repository
├── qa
│  ├── main.py         # sample entrypoint that runs your code
│  ├── batches.yaml    # examples of how to run multiple tests
│  └── metrics.yaml    # examples of how to define KPIs
└── qaboard.yaml       # ⚙️ QA-Board configuration
```


## Storing results
QA-Board expect that all computers running `qa` can access a shared storage (read how to setup [`NFS`](https://www.digitalocean.com/community/tutorials/how-to-set-up-an-nfs-mount-on-ubuntu-18-04) or [`samba`](https://www.digitalocean.com/community/tutorials/how-to-set-up-a-samba-share-for-a-small-organization-on-ubuntu-16-04)...) to save and read results.

To get started quickly, you can create a *local* folder on the server where you'll launch QA-Board, and worry about sharing it later: 

```bash
mkdir -p /mnt/qabaord
chmod -R 777 /mnt/qabaord
```

:::note
We plan to also support using blob-stores like S3. If you can't easily setup your own shared storage or work in a cloud environment, contact.
:::

## [Optional] Gitlab Integration
If you integrate with Gitlab, you'll be able to:
- get direct links to your code
- see user avatars
- delete old results
- access commits by their tag or branch names
- wait for CI pipelines to end when checking if results changed vs the last version

:::note
In the past Gitlab was required, and we'll work on enabling those features even if you use other git servers.  
:::

### How to integrate with GitLab
1. Be one of the project's Maintainers.
2. Go to http://gitlab-srv/$YOUR_GROUP/PROJECT/settings/integrations.
3. Add an integration with:
  * __URL:__ `http://localhost:5151/webhook/gitlab`. Replace localhost with your hostname if you setup any DNS/SSL..
  * __Secret token:__ *(leave the field empty)*

> To test everything went well, Gitlab lets you "Test" your new hook. You should get a blue happy `200 OK` message  🔵🎉.
