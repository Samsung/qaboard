#!/usr/bin/env bash
# todo: https://docs.docker.com/compose/overview/
set -ev
export LC_ALL=C.UTF-8
export LANG=C.UTF-8

echo 'starting'

echo '...preparing ssh-agent'
export SSH_ASKPASS=$HOME/askpass
echo -e '#!/usr/bin/env bash\necho "${SSH_PASSPHRASE}"' > $SSH_ASKPASS; chmod +x $SSH_ASKPASS
eval `ssh-agent`
DISPLAY= setsid ssh-add $HOME/.ssh/id_rsa
ssh-keyscan gitlab-srv >> $HOME/.ssh/known_hosts

sudo nginx &

# TODO: Maybe this can be removed once the old volumes
# are owned by arthurf and not root 
sudo chown -R arthurf /var/slamvizapp

echo '...starting the database'
sudo /etc/init.d/postgresql start &
# sudo -u postgres /usr/lib/postgresql/9.6/bin/postgres \
#   -D /var/lib/postgresql/9.6/main \
#   -c config_file=/etc/postgresql/9.6/main/postgresql.conf &

echo '...applying database migrations'
cd /slamvizapp/slamvizapp
alembic upgrade head || alembic downgrade head || alembic stamp head

# echo '...executing as...'
# useradd -u 11611 -g 10 arthurf -s /usr/bin/zsh
# su arthurf
# runuser -u arthurf -- *

echo '...initializing the database'
slamvizapp_init_database --scrap-from slam --loop &
# slamvizapp_init_database --scrap-from cis --loop &
# slamvizapp_init_database --verbose

echo '...starting the application'
sleep 2
cd /slamvizapp && /opt/anaconda3/bin/uwsgi --ini /slamvizapp/deployment/slamvizapp.ini &

# export LC_ALL=C.UTF-8
# export LANG=C.UTF-8
cd /slamvizapp && FLASK_APP=slamvizapp FLASK_DEBUG=1 flask run --host 0.0.0.0 --with-threads --port 5002 &

# command
# status=$?
# if [ $status -ne 0 ]; then
#   echo "Failed to start my_first_process: $status"
#   exit $status
# fi

while sleep 1800; do
  slamvizapp_clean
done

# quid: check access permissions
# https://gist.github.com/d11wtq/8699521
# eval "$(ssh-agent -s)"
# ssh-add ~/.ssh/id_rsa
# ssh -o StrictHostKeyChecking=no git@gitlab-srv:dvs/psp_swip
# git clone git@gitlab-srv:dvs/psp_swip
exec "${@}"