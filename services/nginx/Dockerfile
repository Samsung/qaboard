# Adapted from https://github.com/nginxinc/docker-nginx/blob/master/mainline/buster/Dockerfile
FROM debian:buster-slim

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
# Use the Debian Archive since Buster is EOL
RUN sed -i 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g' /etc/apt/sources.list && \
    sed -i 's|http://security.debian.org|http://archive.debian.org|g' /etc/apt/sources.list && \
    echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99no-check-valid-until

RUN apt-get update -qq && apt-get install -y --no-install-recommends \
# https://wiki.debian.org/Nginx
# https://packages.debian.org/fr/sid/nginx-full
# For https://github.com/arut/nginx-dav-ext-module
    nginx-full \
# envsubst
    gettext-base \
    && apt-get remove --purge --auto-remove -y && rm -rf /var/lib/apt/lists/* \
# if we have leftovers from building, let's purge them (including extra, unnecessary build deps)
    && if [ -n "$tempDir" ]; then \
        apt-get purge -y --auto-remove \
        && rm -rf "$tempDir" /etc/apt/sources.list.d/temp.list; \
    fi \
# forward request and error logs to docker log collector
    && ln -sf /dev/stdout /var/log/nginx/access.log \
    && ln -sf /dev/stderr /var/log/nginx/error.log

# Clear proxy env so it doesn't leak into runtime
ENV HTTP_PROXY="" http_proxy="" \
    HTTPS_PROXY="" https_proxy="" \
    NO_PROXY=""

EXPOSE 80 443
STOPSIGNAL SIGTERM
CMD ["nginx", "-g", "daemon off;"]
