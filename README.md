# Visualization of SLAM results
- Provides a web dashboard to show and compare SLAM results.
- Keeps in sync with gitlab and listens for notifications when a SLAM run is completed. Keeps the data in a database other tools can connect to.

## How to run
Assuming you want through the [setup instructions](#setup), you should be able to: 
```bash
FLASK_APP=slamvizapp FLASK_DEBUG=1 flask run --host 0.0.0.0 --with-threads
```

To run the app as a linux service and use fancier tools (HTTP2, SSL, wsgi and reverse proxies...), read the [deployment instructions](deployment/README.md), but it's 100% optionnal.*

## Setup
## Application
- Install `python3.6`. The [annaconda distribution](https://www.continuum.io/downloads) is the easiest way.
- Install this application and its dependencies as a python package:

```bash
pip install --editable .                  # edits to the code will be seen
#           --proxy http://dlp-wcg01:8080 # from LSF/vdi
#            -k                           # to trust Samsung's SSL certificate

# If you want a clean python environment, consider
# pip install virtualenv; virtualenv venv; . venv/bin/activate 
```


## Database
You will need a database accessible. Since we work with `sqlalchemy` as ORM, we can pick almost any we like.
* The default configuration expects a `postgreSQL` database available on *localhost* ([download](https://www.postgresql.org/download)).
* You can change the database user, password, host... using environment variables like `SLAMVIZAPP_DB_USER`.
* To know more, read *database.py*.
* Common configuration issues:
  - setup user passwords with something like `$ sudo -postgres psql -U postgres`, `sql> \password`.
  - listen to remote hosts with `sudo nano /etc/postgresql/9.6/main/postgresql.conf`, `listen_addresses = '*'`.
  - allow connections from remote hosts by tweaking [`pg_hba.conf`](https://blog.bigbinary.com/2016/01/23/configure-postgresql-to-allow-remote-connection.html)

To initialize the database on the , run:

```
./slamvizapp_init_database
# --help
# --loop       Keep updating every minute.
# --drop-all   Drop all the tables before the import.
```


## Keeping in sync with `psp_swip` git repository
- Clone the `psp_swip` repository in the working directory or at a location specified in the `SLAMVIZAPP_DATA` environment variable.

```bash
cd $SLAMVIZAPP_DATA
git clone git@gitlab-srv:dvs/psp_swip.git
```

- Make sure the app receives notifications (aka webhooks) whenever someone pushes changes to [gitlab](http://gitlab-srv/dvs/psp_swip):
    1. In `psp_swip`'s project  *Settings*, in the [*Integrations*](http://gitlab-srv/dvs/psp_swip/settings/integrations) setup a webhook to `$YOUR_HOSTNAME/webhook/gitlab`.
    2. In your [user setting](http://gitlab-srv/profile/personal_access_tokens), get an API access tokens for your user and export as:

```bash
# to avoid a line like this in your shell history, you may want to
# write it in a file called ~/.secrets ()and source ~/.secrets
export GITLAB_ACCESS_TOKEN=XXXXXXXXXXX
```


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
We don't store all the data in a database (eg 6dof results, DVS recordings); we store them on the filesystem with this structure:
- Default base folder: `/home/arthurf/ci/commits/`
- Per commit output folder: `${GIT_AUTHORED_TIMESTAMPCOMMIT}__git__${CI_COMMIT_SHA:0:8}`
- Then....

```
1511696118__git__07de8585/
  lsf.log
  params.json
  app_params.json
  swip_slam_tests
  output/
        $PLATFORM_PREFIX                       # default='' for lsf
        $MODE_PREFIX                           # default='' for serial-stereo
         my/recording1/                        # from $database/my/recording1.bin
                       camera_poses_debug.csv  # 6dof and more...
                       metrics.json            # all the metrics, time offset vs ground-truth...
                       results.mp4             # rendering of the results
                       curves.jpg              # 6dof plots
```
