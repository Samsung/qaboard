---
id: installation
title: Installing QA-Board's CLI
sidebar_label: Installation
---

To use QA-Board you need it `pip install` the `qatools` package. On both Linux and Windows:

```bash
pip install --upgrade git+ssh://git@gitlab-srv/common-infrastructure/qatools
# If you have SSL/certificates/trust errors, use --trusted-host pypi.python.org --trusted-host pypi.org --trusted-host files.pythonhosted.org
# If you have timeouts, not authorized, proxy errors, or "this is not a git repo error", use --proxy http://dlp2-wcg01:8080 # in case of proxy issues (TIMEOUT error) in case of SSL/proxy issues

# If you don't have pip / permissions, it means your python environment sucks.
# If you're not a python pro, simply install python with the anaconda distribution.
# https://www.anaconda.com/distribution/#download-section
```

To make sure the installation was successful, try printing a list of qatools' CLI commands:

```bash
qa --help
```
