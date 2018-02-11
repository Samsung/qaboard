#!/usr/bin/env bash
# `docker run` wrapper
# TODO: define everything in a `docker-compose` file
set -ex

DOCKER_IMAGE=gitlab-srv.transchip.com:4567/dvs/slamresultsvizapp
DOCKER_VOLUMES=""

# SSH access
DOCKER_VOLUMES+=" --volume=$HOME/dvs/slamvizapp/deployment/ssh/id_rsa:/root/.ssh/id_rsa"
DOCKER_SSH_PASSPHRASE="--env SSH_PASSPHRASE=${SSH_PASSPHRASE}"
DOCKER_GITLAB_ACCESS_TOKEN="--env GITLAB_ACCESS_TOKEN=${GITLAB_ACCESS_TOKEN}"

# SIRC network access
DOCKER_VOLUMES+=" --volume=/home:/home"
DOCKER_VOLUMES+=" --volume=/stage:/stage"
DOCKER_VOLUMES+=" --volume=/raid:/raid"
DOCKER_VOLUMES+=" --volume=/net/f2/algo_archive/PTAM_Results:/net/f2/algo_archive/PTAM_Results"
# --volume=/home/arthurf/ci/dvs:/home/arthurf/ci/dvs
# DOCKER_VOLUMES+=" --volume=/net/f2:/net/f2"


# Git clone configuration
# docker volume create slamvizapp   # ls inspect rm
# docker volume create slamvizapp-postgresql
# docker volume create slamvizapp-postgresql-log
# docker volume create slamvizapp-postgresql-lib
DOCKER_VOLUMES+=" --volume=slamvizapp:/var/slamvizapp"
# Database configuration
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql:/etc/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-log:/var/log/postgresql"
DOCKER_VOLUMES+=" --volume=slamvizapp-postgresql-lib:/var/lib/postgresql"

# Custom configuration
# DOCKER_VOLUMES+=" --volume=$HOME/.zshrc:/root/.zshrc"
# DOCKER_VOLUMES+=" --volume=$HOME/.oh-my-zsh:/root/.oh-my-zsh"
# DOCKER_VOLUMES+=" --volume=$HOME/.zsh_history:/root/.zsh_history"
DOCKER_VOLUMES+=" --volume=$HOME/dvs/slamvizapp/deployment/init.sh:/slamvizapp/deployment/init.sh"

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

command="docker run --name slamvizapp --detach --restart always $DOCKER_VOLUMES $DOCKER_SSH_PASSPHRASE $DOCKER_GITLAB_ACCESS_TOKEN -p0.0.0.0:5000:5000 -p0.0.0.0:5432:5432 -p0.0.0.0:5001:443 $DOCKER_IMAGE ${@}"
echo $command
exec $command
