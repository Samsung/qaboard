# Visualization of SLAM results
Debug SLAM results faster.

## Setup
- Install `python3.6` with [annaconda](https://www.continuum.io/downloads).
- The only package dependency is `gitpython`; if you don't have it:

```bash
conda install gitpython # use -k if behind Samsung's firewall..
# pip install gitpython
```

- You need to make a copy of the repository, it is used as the database of commit information:

```bash
# git clone git@gitlab-srv:dvs/psp_swip.git
```

- To make sure the app is synced with gitlab, go to gitlab:
    1. Setup a webhook to `$YOUR_HOSTNAME/gitlab_webhook`
    2. Get tokens for your user


- *If needed*, tweak `config.py` to specify where to look for CI outputs, etc.

Tuning: Install [https://nodejs.org/en/download/package-manager/#debian-and-ubuntu-based-linux-distributions](install nodejs)

```
sudo apt-get install nodejs npm
```

## How to run
```bash
# you may want to source ~/.secrets 
export GITLAB_ACCESS_TOKEN=XXXXXXXXXXX 
export FLASK_DEBUG=1    
export FLASK_APP=server.py
flask run server.py --host 0.0.0.0 --with-threads
```

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

## Architecture overview
- Commits are described as **CiCommit** (in `models.py`). **CiCommit.gitcommit** is **Commit** from `gitpython`. 
They have a memgitpython.Commmit


- `server.py`: [Flask](https://flask.pocoo.org) HTTP application that displays SLAM results
- `models.py`: provides *CiCommit*, a class that describes commits and their results. 
- `git_utils.py`: all the interactions with git -- via `gitpython`.
- `/templates/*`: HTML templates that describe how content is to be displayed.
  * Our rendering is mostly **server-side**.
  * It is now very easy to write bundled `ES6` javascript apps via eg `React`/`webpack` etc,
  * **but** it introduces yet other technologies. Not everybody knows them at SIRC.
- `static/*`: assets (CSS...)


## Serving via uwsgi-nginx
You *may* want this for http2/ssl support.
```
sudo apt-get install nginx
pip install uwsgi
# TODO: commit the systemd file and nginx config...
# ... the server then works as a service
```

## TODO
- Show performance over time, both the commits and specific movies.
- VR rendering via webVR
