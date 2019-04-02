# qatools
The QA tools give you CLI tools to help you organize your results and view them in the [visualization web application](http://dvs:5000/projects).

## Installation
```bash
pip install --upgrade git+http://gitlab-srv/common-infrastructure/qatools
# If you have SSL / certificates / trust errors:
#   --trusted-host pypi.python.org --trusted-host pypi.org --trusted-host files.pythonhosted.org
# If you have timeouts, not authorized, proxy errors, or "this is not a git repo error"
#   --proxy http://dlp2-wcg01:8080 # in case of proxy issues (TIMEOUT error) in case of SSL/proxy issues
# If you have permissions errors when installing.
#   --user # then make sure ~/.local/bin is in you PATH.
# If python3.6 is not the default python or you want to choose which python you choose
#   path/to/your/python3 -m pip [etc]


# If you want to develop on qatools
git clone  git@gitlab-srv:common-infrastructure/qatools
cd qatools
pip install --editable .
```

## Usage
Follow the [tutorial](http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial).


## CI
```bash
ssh ispq@ispq-vdi
bash
export GITLAB_RUNNER=1
export GITLAB_PROJECT=qatools
export GITLAB_TOKEN="xxxxxxxx"
```
