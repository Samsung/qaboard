# Visualization of SLAM results
- Provides a web dashboard to show and compare SLAM results.
- Keeps in sync with gitlab and listens for notifications when a SLAM run is completed. Keeps the data in a database other tools can connect to.


## How to run (with Docker, recommended)
```bash
# We use a few persistent storage volumes
docker volume create slamvizapp
docker volume create slamvizapp-postgresql
docker volume create slamvizapp-postgresql-log
docker volume create slamvizapp-postgresql-lib

# This short script wraps `docker run`
# by default it will enable "--restart always", so adapt to your needs!
./start-docker.sh #  now serving http://dvs:5000
```


## Architecture overview
* `slamvizapp`: backend application composed of:
  - `__init__.py`: [Flask](https://flask.pocoo.org) application that handle all our HTTP needs.
  - `webhooks.py`: Listens for notification from gitlab or SLAM jobs.
  - `database.py`: Accesses our database through `[sqlalchemy](http://docs.sqlalchemy.org/en/latest/orm/tutorial.html)`, and connect to the git repository via `gitpython`.
  - `models/`: Provides a few simple classes to represent
    * DVS recordings
    * the version of the code at different commits
    * the parameters used
    * and the results obtained...
  - `/api.py`: exposes the data through a minimal API

  - `/templates/*`: HTML templates that describe how content is to be displayed.
  - `views.py`: [deprecated] Renders templates displaying our data.

* `slamvizapp-webapp`: web application that consumes this API to display results.
  - previously all the frontend was done server-side through html templates (`flask`+`jinja`)
  - it makes it easy to start developping, but after we reach a certain level of complexity, it's better to move to javascript tools...
  - built using [`react`](https://reactjs.org/), using the recommended [`create-react-app`](https://github.com/facebook/create-react-app) toolchain.
  - more details in the [app's README](slamvizapp-webapp/README.md).


## How to run (without Docker)
> The **Dockerfile** is the reference on how to install this application.

### Application setup
You need to install:
- `git`
- `python3.6`:
  * the [annaconda distribution](https://www.continuum.io/downloads) is the easiest way.
  * install this application and its dependencies as a python package:

```bash
pip install https://github.com/jfinkels/flask-restless/archive/1.0.0b1.zip
pip install --editable .                  # edits to the code will be seen
#           --proxy http://dlp-wcg01:8080 # from LSF/vdi
#            -k                           # to trust Samsung's SSL certificate

# If you want a clean python environment, consider
# pip install virtualenv; virtualenv venv; . venv/bin/activate 
```

### Database setup
You will need a database accessible:
* The default configuration expects a `postgreSQL` database available on *localhost* ([download](https://www.postgresql.org/download)). The *Dockerfile* provides setup instructions.
* Since we work with `sqlalchemy` as ORM, we can pick almost any database. If needed, you can change the database user, password, host... using environment variables like `SLAMVIZAPP_DB_USER`. To know more, read *database.py*.

To initialize the database run:

```bash
./slamvizapp_init_database
# --help
# --drop-all   Drop all the tables before the import.
# --loop       Keep looking for new results.
```

### Keeping in sync with `psp_swip` git repository
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

### Run the backend
```bash
FLASK_APP=slamvizapp FLASK_DEBUG=1 flask run --host 0.0.0.0 --with-threads
```
To run the app using fancier tools (HTTP2, SSL, wsgi and reverse proxies...), read the [deployment instructions](deployment/README.md), but it's *100% optionnal.* You'll also find info on how to run the app as a linux service.


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

As we add tuning possibilities, this section will be modified/extended.
