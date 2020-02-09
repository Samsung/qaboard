# QA-Board Backend
Exposes an HTTP API used to read/write all the metadata on QA-Board's runs.

## How to build
First get the code
```bash
cd
git clone git@gitlab-srv:common-infrastructure/qatools.git qaboard
cd qaboard/qaboard-backend
```

Then build with `docker>=18.06`:

```bash
# since we need to access private repositories
export DOCKER_BUILDKIT=1
eval `ssh-agent`
ssh-add ~/.ssh/id_rsa

export DOCKER_IMAGE=qaboard
export CI_ENVIRONMENT_SLUG=staging
docker build --ssh default --tag $DOCKER_IMAGE-$CI_ENVIRONMENT_SLUG .
```

As explained in the [Dockerfile](Dockerfile), you also have to build the frontend separately. [Follow the instructions](slamvizapp-webapp/). 

## How to run the backend
You must set a few environment variable:
- *$GITLAB_ACCESS_TOKEN*: [get it here](http://gitlab-srv/profile/personal_access_tokens)
- *$SSH_PASSPHRASE*: the passphrase a SIRC user key in in *deployment/ssh/id_rsa*. In the future we'll configure SSH agent forwarding from the host to make this simpler...

> **FIXME**: you also need to provide SSL keys in *deployment/ssl/...*.
> As-is, the nginx server tries to look for SSL keys and will fail. If you don't have such keys remove
> `ssl_certificate_key_*` settings from *deployment/nginx/sites-available/slamvizapp*.
> 
> **TODO**: It really should handled by a reverse proxy, not by us...

To connect to a Jenkins server, you can optionnally define *JENKINS_USER_NAME*, *JENKINS_USER_TOKEN*, *JENKINS_USER_CRUMB*.

> In the future we plan to introduce a proper "secret" store, per-instance and per project.

Then you're almost all set:
```bash
# By (bad, fixme) default the container is run with "--restart always" in the background.
# For interactive debugging,
export CI_DEBUG=ON

# This mounts $HOME/dvs/slamvizapp where the container looks for its code,
# and enables easier developmen
export QABOARD_DEBUG_WITH_MOUNTS=TRUE

# Wraps `docker run`. Adapt the script to your needs...
./deployment/start-docker.sh
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
