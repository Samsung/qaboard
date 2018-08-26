# Visualization of algorithmic SLAM results
Provides a web application to:
- Show, debug and compare SLAM results.
- Perform parameter tuning.

It does it by:
- Exposing an API to get updates about individual runs
- Keeping in sync with `git` projects on Gitlab.
- Storing the data in a database.

> As the developper of a stand-alone project, you should use [`qatools`](gitlab-srv/common-infrastructure/qatools)
> to send your results to `slamvizapp`


## Repository organization
- [slamvizapp](slamvizapp/) is the applications' backend:
  * It manages a database where results are stored...
  * and exposes it via a simple HTTP API.
- [slamvizapp](slamvizapp-webapp/) is the frontend, a web application.


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


## Continuous Integration
Gitlab manages:
- builds and tests
- the release to the [`production` enviromnent](http://dvs:5000/), via a manual job on [the `master` branch's pipelines](http://gitlab-srv/dvs/slamvizapp/pipelines)
- the release to the [`staging` enviromnent](http://dvs:9000/) (mirrors production) enviromnent automatically on each update of the `master` branch.
Those steps are described in [`.gitlab-ci.yml`](http://gitlab-srv/dvs/slamvizapp/blob/master/.gitlab-ci.yml). Details on our environments can be [found here](http://gitlab-srv/dvs/slamvizapp/environments).



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
