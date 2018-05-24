#!/usr/bin/env bash
# `docker run` wrapper
# TODO: define everything in a `docker-compose` file
set -ex
DOCKER_IMAGE=gitlab-srv.transchip.com:4567/dvs/slamvizapp

DOCKER_ENV=""

DOCKER_VOLUMES=""
DOCKER_VOLUMES+=" --volume=/opt/dockermounts/home:/home"
HOME_DOCKER=/opt/dockermounts$HOME
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/dvs/slamvizapp/deployment/ssh/id_rsa:/root/.ssh/id_rsa" # helps avoid mount errors...
DOCKER_VOLUMES+=" --volume=/stage:/stage"
DOCKER_VOLUMES+=" --volume=/opt/dockermounts/raid:/raid"
DOCKER_VOLUMES+=" --volume=/stage/algo_data:/stage/algo_data"
DOCKER_VOLUMES+=" --volume=/net/f2/algo_archive/DVS_SLAM_Database:/net/f2/algo_archive/DVS_SLAM_Database"
DOCKER_VOLUMES+=" --volume=/net/f2/algo_archive/PTAM_Results:/net/f2/algo_archive/PTAM_Results"
# DOCKER_VOLUMES+=" --volume=/raid:/raid"
# DOCKER_VOLUMES+=" --volume=/net/f2:/net/f2"
# --volume=/home/arthurf/ci/dvs:/home/arthurf/ci/dvs


if [ -z ${CI_ENVIRONMENT_SLUG+x} ]; then
  echo "[Error] \$CI_ENVIRONMENT_SLUG is not defined."; exit
else
	DOCKER_IMAGE=$DOCKER_IMAGE:$CI_ENVIRONMENT_SLUG
	if [ $CI_ENVIRONMENT_SLUG = "production" ]; then
		#                 frontend               debug            database     https-frontend
		PORTS="-p0.0.0.0:5000:5000 -p0.0.0.0:5002:5002 -p0.0.0.0:5432:5432 -p0.0.0.0:5001:443"
	else
		if [ $CI_ENVIRONMENT_SLUG = "staging" ]; then
		  PORTS="-p0.0.0.0:9000:5000 -p0.0.0.0:9002:5002 -p0.0.0.0:9001:443"
  		  # DOCKER_ENV+=" --env SLAM_DB_PORT=9000"		
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



if [ -z ${SSH_PASSPHRASE+x} ]; then
  echo "[Error] \$SSH_PASSPHRASE is not defined : the app won't be able to use git"; exit
else
  DOCKER_ENV="--env SSH_PASSPHRASE=${SSH_PASSPHRASE}"
fi

if [ -z ${GITLAB_ACCESS_TOKEN+x} ]; then
  echo "[Error] \$GITLAB_ACCESS_TOKEN is not defined: create one at http://gitlab-srv/profile/personal_access_tokens"; exit
else
  DOCKER_ENV="--env GITLAB_ACCESS_TOKEN=${GITLAB_ACCESS_TOKEN}"
fi


# Git clone configuration
DOCKER_VOLUMES+=" --volume=slamvizapp:/var/slamvizapp"
# Database configuration
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-$CI_ENVIRONMENT_SLUG:/etc/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-log-$CI_ENVIRONMENT_SLUG:/var/log/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-lib-$CI_ENVIRONMENT_SLUG:/var/lib/postgresql"

# Custom configuration
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/.zshrc:/root/.zshrc"
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/.oh-my-zsh:/root/.oh-my-zsh"
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/.zsh_history:/root/.zsh_history"
if [ -z ${SLAMVIZAPP_DEBUG_WITH_MOUNTS+x} ]; then
    echo 'reading source from container'
else
    DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/dvs/slamvizapp/slamvizapp:/slamvizapp/slamvizapp"
fi

# ! we already copy the whole nginx config folder in the dockerfile... that's not great.
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/dvs/slamvizapp/deployment/nginx/ssl/dvs:/etc/nginx/ssl/dvs"
# DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/dvs/slamvizapp/deployment/init.sh:/slamvizapp/deployment/init.sh"

# Networking:
# --publish-all -P
# --publish -p
# --ip
# --ip6

# Container lifecycle:
POLICY="--restart always --detach"
# POLICY="--rm -it"
# --rm: removed container on exit
# -i interactive
# -t pseudo tty

command="docker run --name slamvizapp-$CI_ENVIRONMENT_SLUG$$CI_DEBUG $POLICY $DOCKER_VOLUMES $DOCKER_ENV $PORTS $DOCKER_IMAGE ${@}"
echo $command
exec $command
