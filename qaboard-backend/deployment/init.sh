#!/usr/bin/env bash
# TODO: https://github.com/Yelp/dumb-init
# TODO: https://docs.docker.com/compose/overview/
set -evx
export LC_ALL=C.UTF-8
export LANG=C.UTF-8

echo 'starting'
sudo nginx &

echo '...starting the database'
# initdb -D /usr/local/pgsql/data
# pg_createcluster
sudo /etc/init.d/postgresql start &
sleep 6

# The first time you may need to
# # docker run --entrypoint /bin/bash --rm -it  --volume=qaboard-postgresql-production:/etc/postgresql --volume=qaboard-postgresql-log-production:/var/log/postgresql --volume=qaboard-postgresql-lib-production:/var/lib/postgresql  gitlab-srv.transchip.com:4567/common-infrastructure/qaboard:production
# # sudo pg_createcluster 10 main

echo '...applying database migrations'
cd /qaboard/qaboard-backend/slamvizapp
alembic upgrade head || alembic downgrade head || alembic stamp head


echo '...starting the application'
sleep 1
sudo chmod 777 /qaboard/qaboard-backend/deployment/
cd /qaboard/qaboard-backend && sudo -E /opt/anaconda3/bin/uwsgi --ini /qaboard/qaboard-backend/deployment/slamvizapp.ini &

export QABOARD_DB_ECHO=True
cd /qaboard/qaboard-backend && FLASK_APP=slamvizapp FLASK_DEBUG=1 flask run --host 0.0.0.0 --with-threads --port 5002 &

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
