# this file is an edited version of https://github.com/kaij/cantaloupe/blob/docker-deploy/docker/Dockerfile

FROM openjdk:8u181-alpine

ENV VERSION 4.0.2
# EXPOSE 8183

WORKDIR /tmp


RUN apk add --update -X http://dl-cdn.alpinelinux.org/alpine/edge/community \
    curl \
    graphicsmagick \
    openjpeg-tools \
    wget

# From https://github.com/exo-docker/exo/blob/master/Dockerfile
# Install JAI (Java Advanced Imaging) API in the JVM
# We don't install the shared library because the jvm complains about stack guard disabling
# && chmod 755 /tmp/jai-*/lib/*.so \
# && mv -v /tmp/jai-*/lib/*.so "${JAVA_HOME}/jre/lib/amd64/" \
RUN wget -nv -q --no-cookies --no-check-certificate \
  --header "Cookie: gpw_e24=http%3A%2F%2Fwww.oracle.com%2F; oraclelicense=accept-securebackup-cookie" \
  -O "/tmp/jai.tar.gz" "http://download.oracle.com/otn-pub/java/jai/1.1.2_01-fcs/jai-1_1_2_01-lib-linux-i586.tar.gz" \
  && cd "/tmp" \
  && tar --no-same-owner -xvf "/tmp/jai.tar.gz" \
  && mv -v /tmp/jai-*/lib/jai_*.jar "${JAVA_HOME}/jre/lib/ext/" \
  && mv -v /tmp/jai-*/*-jai.txt "${JAVA_HOME}/" \
  && mv -v /tmp/jai-*/UNINSTALL-jai "${JAVA_HOME}/" \
  && rm -rf /tmp/*
ENV JAIHOME /tmp/jai-1_1_2_01/lib
ENV CLASSPATH $JAIHOME/jai_core.jar:$JAIHOME/jai_codec.jar:$JAIHOME/mlibwrapper_jai.jar:$CLASSPATH
ENV LD_LIBRARY_PATH .:$JAIHOME:$CLASSPATH


RUN  curl -k -OL "https://github.com/medusa-project/cantaloupe/releases/download/v$VERSION/Cantaloupe-$VERSION.zip" \
  && mkdir -p /usr/local/ \
  && cd /usr/local \
  && unzip /tmp/Cantaloupe-$VERSION.zip \
  && ln -s cantaloupe-$VERSION cantaloupe \
  && rm -rf /tmp/Cantaloupe-$VERSION \
  && rm /tmp/Cantaloupe-$VERSION.zip

RUN apk add -X http://dl-cdn.alpinelinux.org/alpine/edge/community --update ruby
RUN echo ':ssl_verify_mode: 0' > /root/.gemrc
RUN  gem install --no-document --install-dir /tmp/gems jwt json_pure


# RUN  apk add --update ruby msttcorefonts-installer fontconfig \
#    && update-ms-fonts \
#   && fc-cache -f


RUN adduser -S -u 11611 -g 10 arthurf --shell /bin/bash --no-create-home
RUN echo 'arthurf ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers

RUN  apk add --update msttcorefonts-installer fontconfig \
  && update-ms-fonts \
  && fc-cache -f

RUN apk -U add ca-certificates
COPY cert/* /tmp/cert/
RUN mkdir -p /usr/share/ca-certificates/extra && \
    mkdir -p /etc/ssh/certs && \
    cp -R /tmp/cert/* /usr/share/ca-certificates/extra/ && \
    cp -R /tmp/cert/* /etc/ssh/certs && \
    cp -R /tmp/cert/* /usr/local/share/ca-certificates && \
    update-ca-certificates


COPY cantaloupe.properties delegates.rb config.json /etc/
RUN  mkdir -p /var/log/cantaloupe \
  && mkdir -p /var/cache/cantaloupe \
  && chown -R arthurf /var/log/cantaloupe \
  && chown -R arthurf /var/cache/cantaloupe \
  && chown arthurf /etc/cantaloupe.properties \
  && chown arthurf /etc/delegates.rb \
  && chown arthurf /etc/config.json

RUN apk add sudo
USER arthurf
ENV GEM_HOME /tmp/gems

CMD ["sh", "-c", "java -Dcantaloupe.config=/etc/cantaloupe.properties -Dcom.sun.media.jai.disableMediaLib=true -Xms4g -Xmx12g -jar /usr/local/cantaloupe/cantaloupe-$VERSION.war"]

# http://planet31:8183/admin
# http://planet31:8183/iiif/2/ci/arthurf/cis/test.png/info.json
# https://github.com/c7a/cihm-cantaloupe
