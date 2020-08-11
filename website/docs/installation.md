---
id: installation
title: Installing QA-Board's client
sidebar_label: Client Installation
---

You need to install QA-Board's CLI client: `qa`. It wraps and runs your code.

```bash
pip install --upgrade git+ssh://git@gitlab-srv/common-infrastructure/qaboard
# If you have SSL/certificates/trust errors, use --trusted-host pypi.python.org --trusted-host pypi.org --trusted-host files.pythonhosted.org
# If you have timeouts, not authorized, proxy errors, or "this is not a git repo error", use --proxy http://dlp2-wcg01:8080 # in case of proxy issues (TIMEOUT error) in case of SSL/proxy issues

# If you don't have pip / permissions, it means your python environment sucks.
# If you're not a python pro, simply install python with the anaconda distribution.
# https://www.anaconda.com/distribution/#download-section
```

To make sure the installation was successful, try printing a list of `qa`'s CLI commands:

```bash
qa --help

# If you get errors about not using a utf8 locale, you can likely: 
#   export LC_ALL=C.utf8 LANG=C.utf8
```
