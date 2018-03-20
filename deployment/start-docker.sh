#!/usr/bin/env bash
# `docker run` wrapper
# TODO: define everything in a `docker-compose` file
set -ex
DOCKER_IMAGE=gitlab-srv.transchip.com:4567/dvs/slamvizapp

# ENVIRONMENT=
# SUFFIX

# useful for debug
# STAGING='-staging'

POLICY="--restart always --detach"
# POLICY="--rm -it"

PORTS="-p0.0.0.0:5002:5002 -p0.0.0.0:5000:5000 -p0.0.0.0:5432:5432 -p0.0.0.0:5001:443"
# PORTS="-p0.0.0.0:8002:5002 -p0.0.0.0:8000:5000 -p0.0.0.0:6432:5432 -p0.0.0.0:8001:443"


DOCKER_VOLUMES=""
DOCKER_VOLUMES+=" --volume=/opt/dockermounts/home:/home"
# DOCKER_VOLUMES+=" --volume=/home:/home"
DOCKER_VOLUMES+=" --volume=/stage:/stage"
DOCKER_VOLUMES+=" --volume=/opt/dockermounts/raid:/raid"
# DOCKER_VOLUMES+=" --volume=/raid:/raid"
DOCKER_VOLUMES+=" --volume=/net/f2/algo_archive/PTAM_Results:/net/f2/algo_archive/PTAM_Results"
# --volume=/home/arthurf/ci/dvs:/home/arthurf/ci/dvs
# DOCKER_VOLUMES+=" --volume=/net/f2:/net/f2"


# helps avoid mount errors...
HOME_DOCKER=/opt/dockermounts$HOME
# SSH access
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/dvs/slamvizapp/deployment/ssh/id_rsa:/root/.ssh/id_rsa"
# if [[ ! -z "$GITHUB_ACCESS_TOKEN" ]]; then
  DOCKER_SSH_PASSPHRASE="--env SSH_PASSPHRASE=${SSH_PASSPHRASE}"
# else
#   echo "[Error] \$SSH_PASSPHRASE is not defined : the app won't be able to use git"; exit
# fi

# if [[ ! -z "$GITHUB_ACCESS_TOKEN" ]]; then
  DOCKER_GITLAB_ACCESS_TOKEN="--env GITLAB_ACCESS_TOKEN=${GITLAB_ACCESS_TOKEN}"
# else
#   echo "[Error] \$GITLAB_ACCESS_TOKEN is not defined: create one at http://gitlab-srv/profile/personal_access_tokens"; exit
# fi


# Git clone configuration
DOCKER_VOLUMES+=" --volume=slamvizapp:/var/slamvizapp"
# Database configuration
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql:/etc/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-log:/var/log/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-lib:/var/lib/postgresql"

# Custom configuration
# DOCKER_VOLUMES+=" --volume=$HOME/.zshrc:/root/.zshrc"
# DOCKER_VOLUMES+=" --volume=$HOME/.oh-my-zsh:/root/.oh-my-zsh"
# DOCKER_VOLUMES+=" --volume=$HOME/.zsh_history:/root/.zsh_history"
DOCKER_VOLUMES+=" --volume=$HOME_DOCKER/dvs/slamvizapp/deployment/init.sh:/slamvizapp/deployment/init.sh"

### Main Docker CLI options:
# --name slamvizapp-server

# Networking:
# --publish-all -P
# --publish -p
# --ip
# --ip6

# Container lifecycle:
# --rm: removed container on exit
# VS
# --restart always

# --detach -d
# VS
# -i interactive
# -t pseudo tty

command="docker run --name slamvizapp$STAGING $POLICY $DOCKER_VOLUMES $DOCKER_SSH_PASSPHRASE $DOCKER_GITLAB_ACCESS_TOKEN $PORTS $DOCKER_IMAGE ${@}"
echo $command
exec $command
