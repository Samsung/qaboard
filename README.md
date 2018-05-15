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
- *$GITLAB_ACCESS_TOKEN*: an access token from Gitlab ([get it here](http://gitlab-srv/profile/personal_access_tokens))
- *$SSH_PASSPHRASE*: the passphrase to `arthurf`'s key in *deployment/ssh/id_rsa* (or provide your own key and use your own user) 

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
  - built using [`react`](https://reactjs.org/), using the official [`create-react-app`](https://github.com/facebook/create-react-app) toolchain (`ES6`, `webpack`...).
  - more details in the [app's README](slamvizapp-webapp/README.md).

## How to run (without Docker)
> The **Dockerfile** is the reference on how to install this application.

### Sync with the `dvs/psp_swip` repository
- Clone the `psp_swip` repository at a location specified in the `SLAMVIZAPP_DATA` environment variable:

```bash
cd $SLAMVIZAPP_DATA
git clone git@gitlab-srv:dvs/psp_swip.git
```

### Application setup
You need:
- `git`
- `python3.6`: the [annaconda distribution](https://www.continuum.io/downloads) is the easiest way.

Now install this application and its dependencies as a regular python package:

```bash
pip install --editable .                   # edits to the code will be seen
#           --proxy http://dlp2-wcg01:8080 # from IT's "vdi" servers
#            -k                            # to trust Samsung's SSL certificate

# If you want a clean and dedicated python environment, consider using virtualenv/conda
# pip install virtualenv; virtualenv venv; . venv/bin/activate 
```

If the python dependencies change, make the Docker build faster with:
```bash
pip freeze requirements-freeze.txt
# TODO: use pipenv... https://docs.pipenv.org/
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

### Run the backend
```bash
FLASK_APP=slamvizapp FLASK_DEBUG=1 flask run --host 0.0.0.0 --with-threads
```

### Optionnal configuration
* To run the app using fancier tools (HTTP2, SSL, wsgi and reverse proxies...), read the [deployment instructions](deployment/README.md).
* Make sure the app receives notifications (aka webhooks) whenever someone pushes changes to [gitlab](http://gitlab-srv/dvs/psp_swip). In `psp_swip`'s [*integrations settings*](http://gitlab-srv/dvs/psp_swip/settings/integrations) setup a webhook to `$YOUR_HOSTNAME/webhook/gitlab`.


## How are the SLAM results saved?
We only store their *metrics* in the database. The rest (eg 6dof results, DVS recordings) is stored on the filesystem like so:
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
        $PLATFORM                              # default: lsf
        $CONFIGURATION                         # default: serial-stereo
         my/recording1/                        # eg $database/my/recording1.bin
                       camera_poses_debug.csv  # 6dof and more...
                       metrics.json            # all the metrics, time offset vs ground-truth...
                       results.mp4             # rendering of the results
                       curves.jpg              # 6dof plots
                       ...
  tuning/$BATCH_LABEL/$PLATFORM/$CONFIGURATION/hash(EXTRA_PARAMETERS)[:2]/hash(EXTRA_PARAMETERS)/my/recording/
```
