# We don't use this Dockerfile, instead rely on the official nginx image
# But we lost full support for webdav, so
# TODO: Create an image to restore webdav.
#       Likely exactly like below but need to test it!
FROM ubuntu:bionic
RUN apt-get update && apt-get install -y nginx nginx-extras apache2-utils

RUN echo 'deb http://nginx.org/packages/ubuntu/ bionic nginx'     >  /etc/apt/sources.list.d/nginx.list && \
    echo 'deb-src http://nginx.org/packages/ubuntu/ bionic nginx' >> /etc/apt/sources.list.d/nginx.list && \
    apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --keyserver-options http-proxy=$PROXY --recv-keys ABF5BD827BD9BF62 && \
    # nginx-extra instead of just -full or smaller for WebDav and DAV Ext
    apt-get update -qq && apt-get install -y --no-install-recommends nginx-extras && \
    rm /etc/nginx/sites-enabled/default
