#!/usr/bin/env bash
# todo: https://docs.docker.com/compose/overview/
set -ev
export LC_ALL=C.UTF-8
export LANG=C.UTF-8

echo 'starting'

echo '...preparing ssh-agent'
echo -e '#!/usr/bin/env bash\necho "${SSH_PASSPHRASE}"' > /root/askpass; chmod +x /root/askpass
export SSH_ASKPASS=/root/askpass
eval `ssh-agent`
DISPLAY= setsid ssh-add /root/.ssh/id_rsa
ssh-keyscan gitlab-srv >> ~/.ssh/known_hosts

nginx &

echo '...cloning dvs/psp_swip'
cd /var/slamvizapp
git clone -q git@gitlab-srv:dvs/psp_swip || cd psp_swip && git fetch origin

echo '...starting the database'
/etc/init.d/postgresql start &
# sudo -u postgres /usr/lib/postgresql/9.6/bin/postgres \
#   -D /var/lib/postgresql/9.6/main \
#   -c config_file=/etc/postgresql/9.6/main/postgresql.conf &

echo '...applying database migrations'
cd /slamvizapp/slamvizapp
alembic upgrade head || alembic downgrade head || alembic stamp head

echo '...initializing the database'
slamvizapp_init_database --loop &
# slamvizapp_init_database --verbose

echo '...starting the application'
sleep 5
cd /slamvizapp && /opt/anaconda3/bin/uwsgi --ini /slamvizapp/deployment/slamvizapp.ini &
# export LC_ALL=C.UTF-8
# export LANG=C.UTF-8
# cd /slamvizapp && FLASK_APP=slamvizapp FLASK_DEBUG=1 flask run --host 0.0.0.0 --with-threads --port 5002

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