#!/bin/bash
set -ex

# at first startup, solves issues when running uwsgi as another user 
# chown $UWSGI_UID:$UWSGI_GID /var/qaboard
chmod 777 /var/qaboard

# Apply migrations if needed
cd /qaboard/backend/backend
alembic upgrade head || alembic downgrade head || alembic stamp head

# Start the server
cd /qaboard/backend
uwsgi --ini /qaboard/backend/uwsgi.ini