#!/usr/bin/env bash
# `docker run` wrapper
# TODO: define everything in a `docker-compose` file
set -ex
DOCKER_IMAGE=qaboard
: "${DOCKER_TAG:=$CI_ENVIRONMENT_SLUG}"
DOCKER_IMAGE=$DOCKER_IMAGE:$DOCKER_TAG

## uncomment when deploying debug server:
# DOCKER_IMAGE="qaboard-${DOCKER_TAG:=$CI_ENVIRONMENT_SLUG}" 
echo "===== $DOCKER_IMAGE ====="

DOCKER_ENV=""


DOCKER_VOLUMES=""
DOCKER_VOLUMES+=" --volume=/home:/home"
# optionnal mounts
# DOCKER_VOLUMES+=" --volume=src:dst"
# ...

#               frontend            debug api           database            https-frontend
PORTS____PROD="-p0.0.0.0:5001:5000 -p0.0.0.0:5002:5002 -p0.0.0.0:5432:5432 -p0.0.0.0:443:443"
PORTS_STAGING="-p0.0.0.0:9000:6000 -p0.0.0.0:6002:5002 -p0.0.0.0:6433:5432 -p0.0.0.0:6001:443"
PORTS_____DEV="-p0.0.0.0:9000:5000 -p0.0.0.0:9002:5002 -p0.0.0.0:9433:5432 -p0.0.0.0:9001:443"
# TODO: It really should be more transparent. At least for the API we should make it work with env.qa-server 
#       we could make magic with nginx and e.g. --volume=/tmp/qaboard/backend-$CI_ENVIRONMENT_SLUG.sock:/backend/socks/backend.sock

if [ -z ${CI_ENVIRONMENT_SLUG+x} ]; then
  echo "[Error] \$CI_ENVIRONMENT_SLUG is not defined."; exit
else
  if [ $CI_ENVIRONMENT_SLUG = "production" ]; then
      PORTS="$PORTS____PROD"
  else
    if [ $CI_ENVIRONMENT_SLUG = "staging" ]; then
      PORTS="$PORTS_STAGING"
    else
      # dev...
      PORTS="$PORTS_____DEV"
      # users can opt to connect to the prod/staging database with e.g.
      # DOCKER_ENV+=" --env QABOARD_DB_HOST=qa"    
      # DOCKER_ENV+=" --env QABOARD_DB_PORT=5432"
    fi
  fi
fi



if [ -z ${GITLAB_ACCESS_TOKEN+x} ]; then
  echo "[Error] \$GITLAB_ACCESS_TOKEN is not defined: create one at http://gitlab-srv/profile/personal_access_tokens"; exit
else
  DOCKER_ENV+=" --env GITLAB_ACCESS_TOKEN"
fi
if [ -z ${JENKINS_USER_NAME+x} ]; then
  echo "[WARNING] \$JENKINS_USER_NAME is not defined: create one at http://http://qa-docs/docs/triggering-third-party-tools";
else
  DOCKER_ENV+=" --env JENKINS_USER_NAME"
  DOCKER_ENV+=" --env JENKINS_USER_TOKEN"
  DOCKER_ENV+=" --env JENKINS_USER_CRUMB"
fi

# to actually run jobs we'd need also some kind of "cd {pwd}"
export QA_RUNNERS_LSF_BRIDGE='LC_ALL=en_US.utf8 LANG=en_US.utf8 ssh -q -tt -i /home/arthurf/.ssh/ispq.id_rsa ispq@ispq-vdi bsub_su {user} -I {bsub_command}'
# https://unix.stackexchange.com/questions/379181/escape-a-variable-for-use-as-content-of-another-script
DOCKER_ENV+=" --env QA_RUNNERS_LSF_BRIDGE"
# DOCKER_ENV+=" --env QA_RUNNERS_LSF_BRIDGE='${QA_RUNNERS_LSF_BRIDGE}'"

# We store there Git/Application data
DOCKER_VOLUMES+=" --volume=qaboard:/var/qaboard"
# And here the database data
DOCKER_VOLUMES+=" --volume=qaboard-postgresql-$CI_ENVIRONMENT_SLUG:/etc/postgresql"
DOCKER_VOLUMES+=" --volume=qaboard-postgresql-log-$CI_ENVIRONMENT_SLUG:/var/log/postgresql"
DOCKER_VOLUMES+=" --volume=qaboard-postgresql-lib-$CI_ENVIRONMENT_SLUG:/var/lib/postgresql"

HOME_DOCKER=/opt/dockermounts$HOME
# Custom configuration
# DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/.zshrc:/root/.zshrc"
# DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/.oh-my-zsh:/root/.oh-my-zsh"
# DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/.zsh_history:/root/.zsh_history"

if [ $CI_ENVIRONMENT_SLUG = "production" ]; then
  echo 'production !'
  DOCKER_VOLUMES+=" --volume=/opt/dockermounts/home/ispq/qaboard/webapp_builds:/qaboard/webapp/build"
else
  if [ -z ${QABOARD_DEBUG_WITH_MOUNTS+x} ]; then
      echo 'reading source from container'
  else
      # DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend/deployment/nginx/nginx.conf:/etc/nginx/nginx.conf"
      # DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend/deployment/nginx/conf.d:/etc/nginx/conf.d"
      DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend:/qaboard/backend"
      DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/qaboard:/qaboard/qaboard"
      # DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/anaconda3:/opt/anaconda3"
  fi
fi
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend/deployment/nginx/ssl/dvs:/etc/nginx/ssl/dvs"
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend/deployment/nginx/ssl/qa:/etc/nginx/ssl/qa"

if [ -z ${QABOARD_DB_HOST+x} ]; then
    echo "Using the container's database"
else
    DOCKER_ENV+=" --env QABOARD_DB_HOST"
fi

# ! we already copy the whole nginx config folder in the dockerfile... that's not great.
# DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend/deployment/init.sh:/qaboard/backend/deployment/init.sh"

# Networking:
# --publish-all -P
# --publish -p
# --ip
# --ip6

# Container lifecycle:
if [ -z ${CI_DEBUG+x} ]; then
  echo 'Always-on'
  POLICY="--restart always --detach"
else
  echo 'Interactive session'
  POLICY="--rm -it"
fi
# --rm: removed container on exit
# -i interactive
# -t pseudo tty
# -u=$USER:$UID
# -u=$UID
# -u=$UID
# --privileged=true
command="docker run --name qaboard-$CI_ENVIRONMENT_SLUG${CI_DEBUG} $POLICY $DOCKER_VOLUMES $DOCKER_ENV $PORTS $DOCKER_IMAGE ${@}"
echo $command
exec $command
