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

## Connecting to a custom QA-Board server
By default `qa` tries to use a QA-Board server running locally (it assumes you used the default config).

If you connect to a remote QA-Board server, you'll need to set those environment variables:

```bash
export QABOARD_HOST=my-server:5151
export QABOARD_PROTOCOL=http
```
