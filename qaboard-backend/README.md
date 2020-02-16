# QA-Board Backend
Exposes an HTTP API used to read/write all the metadata on QA-Board's runs.

> The python package implementing the API is named `slamvizapp`, let's find some time to rename it `qaboard_backend`... Likewise, the database is named `slamvizapp`...

## How to build
First get the code
```bash
cd
git clone git@gitlab-srv:common-infrastructure/qaboard.git
cd qaboard
```

Then build:

```bash
export DOCKER_IMAGE=qaboard
export CI_ENVIRONMENT_SLUG=staging
docker build --tag $DOCKER_IMAGE-$CI_ENVIRONMENT_SLUG .
```

As explained in the [Dockerfile](Dockerfile), you also have to build the frontend separately. [Follow the instructions](../qaboard-webapp/). 

## How to run the backend
As of now we expect users to use Gitlab...
- Set your Gitlab server name as environment variabled, named `QABOARD_GITLAB_SERVER` (defaults to *gitlab.com*).
- Your user must have an SSH keys setup to connect to your gitlab server.
- You must have set the *$GITLAB_ACCESS_TOKEN* environment variable ([get it here](http://gitlab-srv/profile/personal_access_tokens))

> **FIXME**: you also need to provide SSL keys in *deployment/ssl/...*.
> As-is, the nginx server tries to look for SSL keys and will fail. If you don't have such keys remove
> `ssl_certificate_key_*` settings from *deployment/nginx/nginx.conf/qaboard.conf*.
> 
> **TODO**: It really should handled by a reverse proxy, not by us...

To connect to a Jenkins server, you can optionnally define *JENKINS_USER_NAME*, *JENKINS_USER_TOKEN*, *JENKINS_USER_CRUMB*.

> In the future we plan to introduce a proper "secret" store, per-instance and per project.

Then you're almost all set:
```bash
# By (bad, fixme) default the container is run with "--restart always" in the background.
# For interactive debugging,
export CI_DEBUG=ON

# This mounts $HOME/qaboard where the container looks for its code,
# and enables easier developmen
export QABOARD_DEBUG_WITH_MOUNTS=TRUE

# Wraps `docker run`. Adapt the script to your needs...
./qaboard-backend/deployment/start-docker.sh
# => now serving http://localhost:[9000/9001]
# FYI, using `CI_ENVIRONMENT_SLUG=staging` changes port mapping slightly...
```

For development, you may want to restore a database backup. As a quick solution you can (DANGEROUS!) connect to the SIRC application server:
```bash
QABOARD_DB_HOST=qa
```

**Troubleshooting:**
- If you have issues like `too many levels of symbolic links`, try again until success...
- It's not sure the database is initialized correctly when starting from 0...

## Running the image servers
Refer to the instructions under [cantaloupe/](cantaloupe/). To support CDE images, your will also need [CDEImage](http://gitlab-srv/swi/CDEImage)  
