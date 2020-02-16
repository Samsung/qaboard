---
id: project-init
sidebar_label: Project Initial Setup
title: Adding QA-Board to your project
---

Go at the root of your project's git repository and run:

```bash
# Sorry we need a utf8 locale
# export LC_ALL=en_US.utf8 LANG=en_US.utf8            # bash users

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
└── qatools.yaml       # 👇 QA-Board configuration ⚙️ 
```

## Storing results
For now, we expect that all computers running `qa` can access a shared storage (`NFS`, `samba`...) at `/var/qaboard/data`. To create this directly locally, run: 

```bash
mkdir -p /var/qabaord/data
chmod -R 777 /var/qaboard/data
```

To change this location, or set it up for Windows:
```yaml
# qatools.yaml
ci_root:
  linux: /var/qaboard/data
  windows: '//shared_storage/var/qaboard/data'
```

## Gitlab Integration
Create a Gitlab integration to keep the QA-Board and `git` in sync.

1. Be one of the project's Masters / Maintainers.
2. Go to https://gitlab.com/$YOUR_GROUP/PROJECT/settings/integrations. (or an on-premises host...)
3. Add an integration with:
  * __URL:__ `http://$QABOARD_HOST/webhook/gitlab`
  * __Secret token:__ *(leave the field empty)*

> To test everything went well, Gitlab lets you "Test" your new hook. You should get a blue happy `200 OK` message  🔵🎉.

:::important To make sure you can view your runs...
Commit thoses changes and push!

*For now, the web interface can only show runs from commit that were pushed to Gitlab.* We plan on removing this restriction and even the need to setup an integration. We'll also support other git servers (e.g. GitHub).
:::