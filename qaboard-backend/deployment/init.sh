#!/usr/bin/env bash
# TODO: https://github.com/Yelp/dumb-init
# TODO: https://docs.docker.com/compose/overview/
set -evx
export LC_ALL=C.UTF-8
export LANG=C.UTF-8

echo 'starting'

echo '...preparing ssh-agent'
export SSH_ASKPASS=$HOME/askpass
echo -e '#!/usr/bin/env bash\necho "${SSH_PASSPHRASE}"' > $SSH_ASKPASS; chmod +x $SSH_ASKPASS
eval `ssh-agent`
DISPLAY= setsid ssh-add $HOME/.ssh/id_rsa


sudo nginx &

echo '...starting the database'
# initdb -D /usr/local/pgsql/data
# pg_createcluster
sudo /etc/init.d/postgresql start &
sleep 6

# The first time you may need to
# # docker run --entrypoint /bin/bash --rm -it  --volume=slamvizapp-postgresql-production:/etc/postgresql --volume=slamvizapp-postgresql-log-production:/var/log/postgresql --volume=slamvizapp-postgresql-lib-production:/var/lib/postgresql  gitlab-srv.transchip.com:4567/dvs/slamvizapp:production
# # sudo pg_createcluster 10 main

echo '...applying database migrations'
cd /slamvizapp/slamvizapp
alembic upgrade head || alembic downgrade head || alembic stamp head


echo '...starting the application'
sleep 1
sudo chmod 777 /slamvizapp/deployment/
cd /slamvizapp && sudo -E /opt/anaconda3/bin/uwsgi --ini /slamvizapp/deployment/slamvizapp.ini &

export QABOARD_DB_ECHO=True
cd /slamvizapp && FLASK_APP=slamvizapp FLASK_DEBUG=1 flask run --host 0.0.0.0 --with-threads --port 5002 &

# command
# status=$?
# if [ $status -ne 0 ]; then
#   echo "Failed to start my_first_process: $status"
#   exit $status
# fi


while sleep 43200; do
  echo OK
done


exec "${@}"
