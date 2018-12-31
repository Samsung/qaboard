# Visualization of algorithmic SLAM results
Provides a web application to:
- Show, debug and compare algorithm results.
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
- [slamvizapp-webapp](slamvizapp-webapp/) is the frontend, a web application.
- [cantaloupe](cantaloupe/) setups a [Cantaloupe](https://medusa-project.github.io/cantaloupe/) IIF server, useful to stream large images to a web client.


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

# For a interactive debugging...
CI_DEBUG=ON CI_ENVIRONMENT_SLUG=staging ./deployment/start-docker.sh
```
