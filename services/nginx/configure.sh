#!/bin/sh
# Generates /etc/nginx from this folder (mounted at /tmp/etc/nginx) and the site's /tmp/deployment/nginx/conf.d
#   configure.sh            at startup, see the proxy's command in docker-compose.yml
#   configure.sh --reload   applies config changes without downtime (used by deployments/deploy.py).
#                           Exits with 1 if the new config is invalid (we keep the current one),
#                           with 2 if it's valid but nginx couldn't reload (restarting the container is safe)
set -e
rm -rf /etc/nginx.new /etc/nginx.old
# -L: kubernetes mounts ConfigMaps as symlinks
cp -rL /tmp/etc/nginx /etc/nginx.new
if [ -d /tmp/deployment/nginx/conf.d/ ]; then
  cp -rL /tmp/deployment/nginx/conf.d/* /etc/nginx.new/conf.d/
fi
envsubst < /etc/nginx.new/nginx.conf.template > /etc/nginx.new/nginx.conf
if [ -d /etc/nginx ]; then mv /etc/nginx /etc/nginx.old; fi
mv /etc/nginx.new /etc/nginx

if [ "$1" = "--reload" ]; then
  if nginx -t -q; then
    nginx -s reload || exit 2
  else
    echo "ERROR: invalid nginx configuration, keeping the current one" >&2
    rm -rf /etc/nginx
    mv /etc/nginx.old /etc/nginx
    exit 1
  fi
fi
