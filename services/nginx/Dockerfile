# Adapted from https://github.com/nginxinc/docker-nginx/blob/master/mainline/buster/Dockerfile
FROM debian:bookworm-slim

# Proxy/cert configuration — no-ops when args are empty (open-source builds)
ARG PROXY_URL=""
ARG NO_PROXY=""

RUN if [ -n "$PROXY_URL" ]; then \
      echo "Acquire::http::Proxy \"$PROXY_URL\";" >> /etc/apt/apt.conf && \
      echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf; \
    fi
ENV HTTP_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL} https_proxy=${PROXY_URL} \
    NO_PROXY=${NO_PROXY}


# create nginx user/group first, to be consistent throughout docker variants
RUN addgroup --system --gid 101 nginx \
    && adduser --system --disabled-login --ingroup nginx --no-create-home --home /nonexistent --gecos "nginx user" --shell /bin/false --uid 101 nginx

ENV DEBIAN_FRONTEND=noninteractive
# nginx (the server, with its built-in modules) and the WebDAV extension (modules-enabled/), not nginx-full or
# nginx-core: nginx.conf loads no other dynamic module, and theirs (image-filter: libgd and video codecs, geoip, xslt...)
# would make the image bigger
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
# https://wiki.debian.org/Nginx
# For https://github.com/arut/nginx-dav-ext-module
    nginx libnginx-mod-http-dav-ext \
# envsubst
    gettext-base \
    && rm -rf /var/lib/apt/lists/* \
# forward request and error logs to docker log collector
    && ln -sf /dev/stdout /var/log/nginx/access.log \
    && ln -sf /dev/stderr /var/log/nginx/error.log

# Clear proxy env so it doesn't leak into runtime
ENV HTTP_PROXY="" http_proxy="" \
    HTTPS_PROXY="" https_proxy="" \
    NO_PROXY=""

# Default configuration. docker-compose.yml bind-mounts services/nginx over it, so edits apply without rebuilding
COPY . /tmp/etc/nginx

EXPOSE 80 443
STOPSIGNAL SIGTERM
CMD ["nginx", "-g", "daemon off;"]
