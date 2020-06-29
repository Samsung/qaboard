---
id: installation
title: Installing QA-Board's CLI
sidebar_label: Installation
---

To use QA-Board you need to install its CLI client. It runs your code and syncs with a run-tracking server.

```bash
pip install --upgrade qaboard
```

To make sure the installation was successful, try printing a list of `qa`'s CLI commands:

```bash
qa --help

# If you get errors about not using a utf8 locale, you can likely: 
#   export LC_ALL=C.utf8 LANG=C.utf8
```
