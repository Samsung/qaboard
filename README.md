# Visualization of SLAM results
- Provides a web dashboard to show and compare SLAM results.
- Keeps in sync with gitlab and listens for notifications when a SLAM run is completed. Keeps the data in a database other tools can connect to.

## Setup
- Install `python3.6`. Using [annaconda](https://www.continuum.io/downloads) is the easiest way.
- Install the application:

```bash
# Installs the application and its dependencies as a python package
# with '--editable', change to the code will be seen upon re-import
pip install --editable .
# if you have issues with PATH or multiple pip versions,
#  create a dedicated python conda/virtualenv environment 
# With Samsung's firewall,
#  you may need to specify --proxy http://dlp-wcg01:8080
#  or ask pip to trust the certificates... whatever
```

- The application data will be stored in the working directory, or at a location read from the `SLAMVIZAPP_DATA` environment variable.

```bash
# Of course, pick a location you can write to!

# on linux with normal POSIX shells
export SLAMVIZAPP_DATA=/etc/slamvizapp
# on linux with tcshell
setenv SLAMVIZAPP_DATA /etc/slamvizapp
# on windows
set slamvizapp=XXXXXXXXXXX
```

- There, you need to clone the *psp_swip* repository:

```bash
cd $SLAMVIZAPP_DATA
git clone git@gitlab-srv:dvs/psp_swip.git
```

- To initialize the database, run the following script. *If needed*, tweak `config.py` to specify where to look for CI outputs, etc.

```
./init_database.py
```

- Finally, make sure the app receives notifications (aka webhooks) whenever someone pushes changes to [gitlab](http://gitlab-srv/dvs/psp_swip):
    1. In `psp_swip`'s project  *Settings*, in the [*Integrations*](http://gitlab-srv/dvs/psp_swip/settings/integrations) setup a webhook to `$YOUR_HOSTNAME/gitlab_webhook`.
    2. In your [user setting](http://gitlab-srv/profile/personal_access_tokens), get an API access tokens for your user.


## How to run
```bash
# to avoid a line like this in your shell history, you may want to
# write it in a file called ~/.secrets ()and source ~/.secrets
export GITLAB_ACCESS_TOKEN=XXXXXXXXXXX

export SLAMVIZAPP_DATA=/etc/slamvizapp

export FLASK_DEBUG=1
export FLASK_APP=slamvizapp
flask run --host 0.0.0.0 --with-threads
```

*If you want a more robust deployment, as a linux service, with HTTP2, SSL, wsgi and reverse proxies... Read below, but it's 100% optionnal.*

## Architecture overview
- `models/`:
  * Provides a few simple classes to represent DVS recordings, version of the code at different commits, the parameter used, and the results obtained.
  * Managed via [sqlalchemy](http://docs.sqlalchemy.org/en/latest/orm/tutorial.html)
- `views.py`: [Flask](https://flask.pocoo.org) HTTP application that renders templates and listens for notification from gitlab or SLAM jobs.
- `/templates/*`: HTML templates that describe how content is to be displayed.
  * Our rendering is mostly server-side.
  * `flask` uses `jinja2` templates. It's very easy but tends to be ugly and suffers from frequent scoping issues...
  * It is now very easy to write bundled `ES6` javascript apps via eg `React`/`webpack` etc,
  * **but** it introduces yet other technologies. Not everybody knows them at SIRC.
- `git_utils.py`: all the interactions with `git` - via `gitpython`.


## How should the SLAM results be saved?
The application expects SLAM results to be saved like so:
- Default base folder: `/home/arthurf/ci/commits/`
- Per commit output folder: `${GIT_AUTHORED_TIMESTAMPCOMMIT}__git__${CI_COMMIT_SHA:0:8}`
- Example:

```
1511696118__git__07de8585/
  lsf.log
  params.json
  app_params.json
  swip_slam_tests
  output/
         my/recording1/                        # from $database/my/recording1.bin
                       camera_poses_debug.csv  # 6dof and more...
                       curves.jpg              # 6dof plots
                       results.mp4             # rendering of the results
                       metrics.json            # all the metrics, time offset vs ground-truth...
                       # TODO: specify the platform via subfolders or suffixes *_$PLATFORM*

  # WORK IN PROGRESS
  tuning.json
    "batchfile": 
    "batch":
    "manual" : {
      radius: {explicit [0.1, 0.2]}
      radius: {from, to, step, number}
    }
    "automated" : {
      iterations: 300

    }
  tuning/hash(params)
  tuning.db
```

## TODO
- Use the database with a third-party BI tool to show performance over time, for specific movies, types of movies...
- Support for tuning
- VR rendering via webVR


## WIP: Serving via uwsgi-nginx
> You *may* want this for http2/ssl support.

```
sudo apt-get install nginx
pip install uwsgi
# TODO: commit the systemd file and nginx config...
# ... the server then works as a service
```
