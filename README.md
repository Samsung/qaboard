# Visualization of SLAM results
- Provides a web dashboard to show and compare SLAM results.
- Keeps in sync with gitlab and listens for notifications when a SLAM run is completed. Keeps the data in a database other tools can connect to.







http://docs.sqlalchemy.org/en/latest/orm/query.html
http://www.ergo.io/blog/sqlalchemy-relationships-from-beginner-to-advanced/
http://docs.sqlalchemy.org/en/latest/orm/mapped_sql_expr.html

## Setup
- You will need a database accessible. Since we work with `sqlalchemy` as ORM, we can pick almost anyone we like.
  * The default configuration expects a `postgreSQL` database available on *localhost* ([download](https://www.postgresql.org/download)).
  * You can change the database user, password, host... using environment variables like `SLAMVIZAPP_DB_USER`.
  * To know more, read *database.py*.
  * Common configuration issues:
    1. setup user passwords with something like `$ sudo -postgres psql -U postgres`, `sql> \password`.
    2. listen to remote hosts with `sudo nano /etc/postgresql/9.6/main/postgresql.conf`, `listen_addresses = '*'`.
    3. allow connections from remote hosts by tweaking [`pg_hba.conf`](https://blog.bigbinary.com/2016/01/23/configure-postgresql-to-allow-remote-connection.html)

- Install `python3.6`. The [annaconda distribution](https://www.continuum.io/downloads) is the easiest way.
- Install this application:

```bash
# Installs the application and its dependencies as a python package
# with '--editable', change to the code will be seen upon re-import
pip install --editable .
# if you have issues with PATH or multiple pip versions,
#  create a dedicated python conda/virtualenv environment
#  virtualenv venv
#  . venv/bin/activate
# With pip and the SIRC's firewall,
#  you may need to specify --proxy http://dlp-wcg01:8080
#  or ask pip to trust the certificates... whatever
```

- Clone the `psp_swip` repository in the working directory or at a location specified in `SLAMVIZAPP_DATA`.

```bash
# on linux with normal POSIX shells
export SLAMVIZAPP_DATA=/etc/slamvizapp
# on linux with tcshell
setenv SLAMVIZAPP_DATA /etc/slamvizapp
# on windows
set slamvizapp=XXXXXXXXXXX

cd $SLAMVIZAPP_DATA
git clone git@gitlab-srv:dvs/psp_swip.git
```

- To initialize the database, run the following script.

```
./slamvizapp_init_database
# --loop : keeps updating every minue
# --drop-all : drop all the tables before the import
```

- Make sure the app receives notifications (aka webhooks) whenever someone pushes changes to [gitlab](http://gitlab-srv/dvs/psp_swip):
    1. In `psp_swip`'s project  *Settings*, in the [*Integrations*](http://gitlab-srv/dvs/psp_swip/settings/integrations) setup a webhook to `$YOUR_HOSTNAME/webhook/gitlab`.
    2. In your [user setting](http://gitlab-srv/profile/personal_access_tokens), get an API access tokens for your user.

```bash
# to avoid a line like this in your shell history, you may want to
# write it in a file called ~/.secrets ()and source ~/.secrets
export GITLAB_ACCESS_TOKEN=XXXXXXXXXXX
```

## How to run
Assuming all the `SLAM_VIZAPP_DATA_*` environment variables are set, you should be able to: 
```bash
export FLASK_DEBUG=1
export FLASK_APP=slamvizapp
flask run --host 0.0.0.0 --with-threads
```

*If you want a more robust deployment, as a linux service, with HTTP2, SSL, wsgi and reverse proxies... read the [deployment instructions](slamvizapp/deployment/README.md), but it's 100% optionnal.*

## Architecture overview
- `__init__.py`: [Flask](https://flask.pocoo.org) application that handle all our HTTP needs.
- `views.py`: Renders templates displaying our data.
- `webhooks.py`: Listens for notification from gitlab or SLAM jobs.
- `database.py`: Accesses our database through `[sqlalchemy](http://docs.sqlalchemy.org/en/latest/orm/tutorial.html)`, and connect to the git repository via `gitpython`.
- `models/`: Provides a few simple classes to represent
  * DVS recordings
  * the version of the code at different commits
  * the parameters used
  * and the results obtained...
- `/templates/*`: HTML templates that describe how content is to be displayed.
  * Our rendering is mostly server-side.
  * `flask` uses `jinja2` templates. It's very easy but tends to be ugly and suffers from frequent scoping issues...
  * It is now very easy to write bundled `ES6` javascript apps via eg `React`/`webpack` etc,
  * **but** it introduces yet other technologies. Not everybody knows them at SIRC.
- `git_utils.py` and `utils.py`: small helpers.


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
- Use the database with a third-party BI tool to show performance over time, for specific movies, types of movies... https://github.com/apache/incubator-superset or metabase
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
