---
id: installation
title: Installing QA-Board's client
sidebar_label: Client Installation
---

You need to install QA-Board's CLI client: `qa`. It wraps and runs your code.

```bash
pip install --upgrade qaboard
```

To make sure the installation was successful, try printing a list of `qa`'s CLI commands:

```bash
qa --help

# If you get errors about not using a utf8 locale, you can likely: 
#   export LC_ALL=C.utf8 LANG=C.utf8
```
