#!/bin/bash
set -ex

# at first startup, solves issues when running uwsgi as another user 
# chown $UWSGI_UID:$UWSGI_GID /var/qaboard
chmod 777 /var/qaboard

# Apply migrations if needed
# When we deploy several replicas, migrations run once before the rollout (deployments/deploy.py, the helm chart's Job)
if [ "${QABOARD_RUN_MIGRATIONS:-1}" != "0" ]; then
  /qaboard/backend/migrate.sh
fi


# At SIRC we need to be able to turn into any user to delete their output files
if [ -z ${UWSGI_UID+x} ]; then
  echo "not-needed"
else
  echo "$UWSGI_UID ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers
fi


# Start the server
# exec: uwsgi becomes PID 1 and receives SIGTERM from `docker stop`/kubernetes, to shutdown gracefully
cd /qaboard/backend
exec uwsgi --listen $UWSGI_LISTEN_QUEUE_SIZE --ini /qaboard/backend/uwsgi.ini
