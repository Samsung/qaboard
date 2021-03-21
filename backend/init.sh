#!/bin/bash
set -ex

# at first startup, solves issues when running uwsgi as another user 
# chown $UWSGI_UID:$UWSGI_GID /var/qaboard
chmod 777 /var/qaboard

# Apply migrations if needed
cd /qaboard/backend/backend
alembic upgrade head || alembic downgrade head || alembic stamp head


# At SIRC we need to be able to turn into any user to delete their output files
if [ -z ${UWSGI_UID_CAN_SUDO+x} ]; then
  if [ -z ${UWSGI_UID+x} ]; then
    echo "not-needed"
  else
    echo "$UWSGI_UID ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers
  fi
fi


# Start the server
cd /qaboard/backend
uwsgi --listen $UWSGI_LISTEN_QUEUE_SIZE --ini /qaboard/backend/uwsgi.ini
