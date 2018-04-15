# Visualization of SLAM results
Provides a web application to:
- Show, debug and compare SLAM results.
- Perform parameter tuning.

It does it by:
- Exposing an API to get updates about individual SLAM runs
- Keeping in sync with `git` projects on Gitlab.
- Storing the data in a database.


## How to run (with Docker, recommended)
You need to set two environment variables:
- an access token from Gitlab ([get it here](http://gitlab-srv/profile/personal_access_tokens))
- the passphrase to `arthurf`'s key in *deployment/ssh/id_rsa* (or provide your own key and use your own user) 

Then you're all set:
```bash
# This short script wraps `docker run`. By default it will enable "--restart always"
# Adapt it to your needs. Some commands useful for debugging are commented-out
./start-docker.sh
# => now serving http://dvs:5000
```

## CI
Gitlab manages:
- builds and tests
- the release to the [`production` enviromnent](http://dvs:5000/), via a manual job on [the `master` branch's pipelines](http://gitlab-srv/dvs/slamvizapp/pipelines)
- the release to the [`staging` enviromnent](http://dvs:9000/) (mirrors production) enviromnent automatically on each update of the `master` branch.
Those steps are described in [`.gitlab-ci.yml`](http://gitlab-srv/dvs/slamvizapp/blob/master/.gitlab-ci.yml). Details on our environments can be [found here](http://gitlab-srv/dvs/slamvizapp/environments).


## Architecture overview
* `slamvizapp`: backend application composed of:
  - `__init__.py`: [Flask](https://flask.pocoo.org) application that handle all our HTTP needs.
  - `database.py`: Accesses our database through `[sqlalchemy](http://docs.sqlalchemy.org/en/latest/orm/tutorial.html)`, and connect to the git repository via `gitpython`.
  - `models/`: Provides a few simple classes to represent
    * DVS **Recordings**
    * versions of the code, eg **CiCommits**
    * **Batches** of related **SlamOutputs**
  - `/api.py` and `webhooks.py`: expose the data through a minimal API and listens for notification from gitlab or SLAM jobs.
  - `alembic`: schema and data migrations for our database via [`alembic`](http://alembic.zzzcomputing.com/en/latest/tutorial.html).
* `slamvizapp-webapp`: web application that consumes this API to display results.
  - previously all the frontend was done server-side through html templates (`flask`+`jinja`)
  - it makes it easy to start developping, but after we reach a certain level of complexity, it's better to move to javascript tools...
  - built using [`react`](https://reactjs.org/), using the recommended [`create-react-app`](https://github.com/facebook/create-react-app) toolchain (`ES6` etc).
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
pip install --editable .                   # edits to the code will be seen
#           --proxy http://dlp2-wcg01:8080 # from IT's "vdi" servers
#            -k                            # to trust Samsung's SSL certificate

# If you want a clean and dedicated python environment, consider using virtualenv/conda
# pip install virtualenv; virtualenv venv; . venv/bin/activate 
```

### Database setup
You will need a database accessible:
* The default configuration expects a `postgreSQL` database available on *localhost* ([download](https://www.postgresql.org/download)). The *Dockerfile* provides setup instructions.
* Since we work with `sqlalchemy` as ORM, we can pick almost any database. If needed, you can change the database user, password, host, type... using environment variables like `SLAMVIZAPP_DB_USER`. To know more, read *database.py*.

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
To run the app using fancier tools (HTTP2, SSL, wsgi and reverse proxies...), read the [deployment instructions](deployment/README.md), but it's *100% optionnal for development.* You'll also find info on how to run the app as a linux service.


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
  tuning/ .. not yet documented, refer to the code
```
