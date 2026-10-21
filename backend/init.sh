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
  # Without $SECRET_KEY, a key is generated in this file, maybe by root (e.g. the migrations), readable only by its owner
  secret_key="${QABOARD_DATA_DIR:-/var/qaboard}/secret_key"
  if [ -f "$secret_key" ]; then
    chown "$UWSGI_UID${UWSGI_GID:+:$UWSGI_GID}" "$secret_key"
  fi
fi


# Start the server
cd /qaboard/backend
if [ "${QABOARD_JOBS_WORKER:-1}" = "0" ]; then
  # exec: uwsgi becomes PID 1 and receives SIGTERM from `docker stop`/kubernetes, to shutdown gracefully
  exec uwsgi --listen $UWSGI_LISTEN_QUEUE_SIZE --ini /qaboard/backend/uwsgi.ini
fi

# Next to uwsgi: the worker that runs the server's jobs (Admin > Storage), e.g. hard-deleting deleted runs.
# It runs as root, like this script: it can delete files as their owner (backend/fs_utils.py). Every replica runs one,
# the database decides who runs which job. QABOARD_JOBS_WORKER=0 if you run `qaboard-admin jobs worker` elsewhere.
set +e
uwsgi --listen $UWSGI_LISTEN_QUEUE_SIZE --ini /qaboard/backend/uwsgi.ini &
server=$!
(
  # its running job stops at its next check, and is queued again: another worker resumes it
  trap 'kill -TERM $child 2>/dev/null; wait $child; exit 0' TERM
  while true; do
    qaboard-admin jobs worker &
    child=$!
    wait $child
    echo "The jobs worker stopped, it restarts in 30s"
    sleep 30 &
    wait $!
  done
) &
worker=$!
# `docker stop`/kubernetes send SIGTERM to PID 1: both stop gracefully
trap 'kill -TERM $server $worker 2>/dev/null' TERM INT
wait $server
status=$?
# a signal interrupts `wait`: we wait for uwsgi to finish its requests
while kill -0 $server 2>/dev/null; do
  wait $server
  status=$?
done
kill -TERM $worker 2>/dev/null
wait $worker
exit $status
