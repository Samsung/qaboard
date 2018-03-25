#!/usr/bin/env bash
# `docker run` wrapper
# TODO: define everything in a `docker-compose` file
set -ex
DOCKER_IMAGE=gitlab-srv.transchip.com:4567/dvs/slamvizapp


DOCKER_VOLUMES=""
DOCKER_VOLUMES+=" --volume=/opt/dockermounts/home:/home"
HOME_DOCKER=/opt/dockermounts$HOME
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/dvs/slamvizapp/deployment/ssh/id_rsa:/root/.ssh/id_rsa" # helps avoid mount errors...
DOCKER_VOLUMES+=" --volume=/stage:/stage"
DOCKER_VOLUMES+=" --volume=/opt/dockermounts/raid:/raid"
DOCKER_VOLUMES+=" --volume=/net/f2/algo_archive/PTAM_Results:/net/f2/algo_archive/PTAM_Results"
# DOCKER_VOLUMES+=" --volume=/raid:/raid"
# DOCKER_VOLUMES+=" --volume=/net/f2:/net/f2"
# --volume=/home/arthurf/ci/dvs:/home/arthurf/ci/dvs


if [ -z ${CI_ENVIRONMENT+x} ]; then
  echo "[Error] \$CI_ENVIRONMENT is not defined."; exit
else
	if [ $CI_ENVIRONMENT = "production" ]; then
		#                 frontend               debug            database     https-frontend
		PORTS="-p0.0.0.0:5000:5000 -p0.0.0.0:5002:5002 -p0.0.0.0:5432:5432 -p0.0.0.0:5001:443"
	else
		if [ $CI_ENVIRONMENT = "staging" ]; then
		  PORTS="-p0.0.0.0:6000:5000 -p0.0.0.0:6002:5002 -p0.0.0.0:6001:443"			
		else
			PORTS=""
			DOCKER_IMAGE=$DOCKER_IMAGE:$CI_ENVIRONMENT
			DOCKER_VOLUMES+=" --volume=slamvizapp:/var/slamvizapp"
			# this would replace using port 5000, but we need to update some nginx configurations before it works... 
			# --volume=/tmp/slamvizapp/slamvizapp-$CI_ENVIRONMENT.sock:/slamvizapp/socks/slamvizapp.sock
  	fi
	fi
fi


if [ -z ${SSH_PASSPHRASE+x} ]; then
  echo "[Error] \$SSH_PASSPHRASE is not defined : the app won't be able to use git"; exit
else
  DOCKER_SSH_PASSPHRASE="--env SSH_PASSPHRASE=${SSH_PASSPHRASE}"
fi

if [ -z ${GITHUB_ACCESS_TOKEN+x} ]; then
  echo "[Error] \$GITLAB_ACCESS_TOKEN is not defined: create one at http://gitlab-srv/profile/personal_access_tokens"; exit
else
  DOCKER_GITLAB_ACCESS_TOKEN="--env GITLAB_ACCESS_TOKEN=${GITLAB_ACCESS_TOKEN}"
fi


# Git clone configuration
DOCKER_VOLUMES+=" --volume=slamvizapp:/var/slamvizapp"
# Database configuration
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-$CI_ENVIRONMENT:/etc/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-log-$CI_ENVIRONMENT:/var/log/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-lib-$CI_ENVIRONMENT:/var/lib/postgresql"

# Custom configuration
# DOCKER_VOLUMES+=" --volume=$HOME/.zshrc:/root/.zshrc"
# DOCKER_VOLUMES+=" --volume=$HOME/.oh-my-zsh:/root/.oh-my-zsh"
# DOCKER_VOLUMES+=" --volume=$HOME/.zsh_history:/root/.zsh_history"
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

command="docker run --name slamvizapp-$CI_ENVIRONMENT $POLICY $DOCKER_VOLUMES $DOCKER_SSH_PASSPHRASE $DOCKER_GITLAB_ACCESS_TOKEN $PORTS $DOCKER_IMAGE ${@}"
echo $command
exec $command
