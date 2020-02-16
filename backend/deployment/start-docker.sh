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

if [ -z ${CI_ENVIRONMENT_SLUG+x} ]; then
  echo "[Error] \$CI_ENVIRONMENT_SLUG is not defined."; exit
else
	if [ $CI_ENVIRONMENT_SLUG = "production" ]; then
		#                 frontend           debug api            database     https-frontend
		PORTS="-p0.0.0.0:5001:5000 -p0.0.0.0:5002:5002 -p0.0.0.0:5432:5432 -p0.0.0.0:443:443"
	else
		if [ $CI_ENVIRONMENT_SLUG = "staging" ]; then
      #                 frontend           debug api            database     https-frontend
		  PORTS="-p0.0.0.0:9000:5000 -p0.0.0.0:9002:5002 -p0.0.0.0:9433:5432 -p0.0.0.0:9001:443"
      # DOCKER_ENV+=" --env QABOARD_DB_HOST=dvs"    
      # DOCKER_ENV+=" --env QABOARD_DB_PORT=5432"    
		else
            PORTS="-p0.0.0.0:10000:5000 -p0.0.0.0:10002:5002 -p0.0.0.0:10001:443"
 			# PORTS=""
			# or we could yse a dummy port and change the host's nginx config to point to the correct port..
			# DOCKER_VOLUMES+=" --volume=slamvizapp:/var/slamvizapp"
			# this would replace using port 5000, but we need to update some nginx configurations before it works... 
			# --volume=/tmp/slamvizapp/slamvizapp-$CI_ENVIRONMENT_SLUG.sock:/slamvizapp/socks/slamvizapp.sock
  	fi
	fi
fi



if [ -z ${GITLAB_ACCESS_TOKEN+x} ]; then
  echo "[Error] \$GITLAB_ACCESS_TOKEN is not defined: create one at http://gitlab-srv/profile/personal_access_tokens"; exit
else
  DOCKER_ENV+=" --env GITLAB_ACCESS_TOKEN=${GITLAB_ACCESS_TOKEN}"
fi
if [ -z ${JENKINS_USER_NAME+x} ]; then
  echo "[WARNING] \$JENKINS_USER_NAME is not defined: create one at http://http://qa-docs/docs/triggering-third-party-tools";
else
  DOCKER_ENV+=" --env JENKINS_USER_NAME=${JENKINS_USER_NAME}"
  DOCKER_ENV+=" --env JENKINS_USER_TOKEN=${JENKINS_USER_TOKEN}"
  DOCKER_ENV+=" --env JENKINS_USER_CRUMB=${JENKINS_USER_CRUMB}"
fi


# Git clone configuration
DOCKER_VOLUMES+=" --volume=slamvizapp:/var/qaboard"
# Database configuration
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-$CI_ENVIRONMENT_SLUG:/etc/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-log-$CI_ENVIRONMENT_SLUG:/var/log/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-lib-$CI_ENVIRONMENT_SLUG:/var/lib/postgresql"

HOME_DOCKER=/opt/dockermounts$HOME
# Custom configuration
# DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/.zshrc:/root/.zshrc"
# DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/.oh-my-zsh:/root/.oh-my-zsh"
# DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/.zsh_history:/root/.zsh_history"

if [ $CI_ENVIRONMENT_SLUG = "production" ]; then
  echo 'production !'
  DOCKER_VOLUMES+=" --volume=/opt/dockermounts/home/ispq/qaboard/webapp_builds:/qaboard/qaboard-webapp/build"
else
  if [ -z ${QABOARD_DEBUG_WITH_MOUNTS+x} ]; then
      echo 'reading source from container'
  else
      # DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend/deployment/nginx/nginx.conf:/etc/nginx/nginx.conf"
      # DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend/deployment/nginx/conf.d:/etc/nginx/conf.d"
      DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend:/qaboard/backend"
      # DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/anaconda3:/opt/anaconda3"
  fi
fi
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend/deployment/nginx/ssl/dvs:/etc/nginx/ssl/dvs"
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/qaboard/backend/deployment/nginx/ssl/qa:/etc/nginx/ssl/qa"

if [ -z ${QABOARD_DB_HOST+x} ]; then
    echo 'Using container database'
else
    DOCKER_ENV+=" --env QABOARD_DB_HOST=qa"
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
