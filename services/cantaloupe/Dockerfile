# this file is an edited version of https://github.com/crkn-rcdr/cihm-cantaloupe/blob/master/Dockerfile
FROM alpine:3.10

WORKDIR /tmp
RUN apk add --no-cache --update -X http://dl-cdn.alpinelinux.org/alpine/edge/community \
    curl \
    graphicsmagick \
    openjpeg-tools \
    wget \
    && rm -rf /var/cache/apk/*


ENV JAIHOME=/tmp/jai-1_1_2_01/lib \
  CLASSPATH=$JAIHOME/jai_core.jar:$JAIHOME/jai_codec.jar:$JAIHOME/mlibwrapper_jai.jar:$CLASSPATH \
  LD_LIBRARY_PATH=.:$JAIHOME:$CLASSPATH \
  GEM_HOME=/tmp/gems \
  JAVA_HOME=/usr/lib/jvm/java-11-openjdk

RUN apk --no-cache add openjdk11 wget openjpeg-tools \
  # network issues at SIRC...
  # msttcorefonts-installer fontconfig \
  # && update-ms-fonts \
  # && fc-cache -f \
  # See https://github.com/exo-docker/exo/blob/master/Dockerfile#L99
  && wget -nv -q --no-cookies \
  --header "Cookie: gpw_e24=http%3A%2F%2Fwww.oracle.com%2F; oraclelicense=accept-securebackup-cookie" \
  -O "/tmp/jai.tar.gz" "http://download.oracle.com/otn-pub/java/jai/1.1.2_01-fcs/jai-1_1_2_01-lib-linux-i586.tar.gz" \
  && tar -xzpf jai.tar.gz \
  && rm -rf /var/cache/apk/*


# https://github.com/crkn-rcdr/cihm-cantaloupe/issues/15
RUN cd /tmp && apk add --no-cache --virtual build-dependencies cmake g++ make nasm \
  && wget https://github.com/libjpeg-turbo/libjpeg-turbo/archive/2.0.4.tar.gz -O libjpeg-turbo-2.0.4.tar.gz \
  && tar -xpf libjpeg-turbo-2.0.4.tar.gz \
  && cd libjpeg-turbo-2.0.4 \
  && cmake \
  -DCMAKE_INSTALL_PREFIX=/usr \
  -DCMAKE_INSTALL_LIBDIR=/usr/lib \
  -DBUILD_SHARED_LIBS=True \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$CFLAGS" \
  -DWITH_JPEG8=1 \
  -DWITH_JAVA=1 \
  && make && make install \
  && cd .. &&  rm -rf libjpeg-turbo-2.0.4* \
  && apk del build-dependencies \
  && rm -rf /var/cache/apk/*



ENV VERSION=4.1.5

ARG user=cantaloupe
ARG uid=8182
ARG group=cantaloupe
ARG gid=8182
RUN wget -nv "https://github.com/medusa-project/cantaloupe/releases/download/v$VERSION/Cantaloupe-$VERSION.zip" \
  && mkdir -p /usr/local/ \
  && cd /usr/local \
  && unzip /tmp/Cantaloupe-$VERSION.zip \
  && ln -s cantaloupe-$VERSION cantaloupe \
  && rm -rf /tmp/Cantaloupe-$VERSION \
  && rm /tmp/Cantaloupe-$VERSION.zip \
  # can fail if already exists (e.g. uucp)
  && (addgroup -S $group --gid $gid || true) && (adduser -S $user --uid $uid -G $group || true) \
  && mkdir -p /var/log/cantaloupe \
  && mkdir -p /var/cache/cantaloupe \
  && chown -R $user:$group /var/log/cantaloupe \
  && chown -R $user:$group /var/cache/cantaloupe


COPY --chown=$user:$group cantaloupe.properties /etc/

# if we run as another user, we don't want to deal with uid/gid issues
RUN mkdir -p /srv/cantaloupe/logs
VOLUME /srv/cantaloupe
RUN chmod 777 /srv/cantaloupe && chmod 777 /srv/cantaloupe/logs

# ENV GEM_HOME /tmp/gems
USER $user
CMD ["sh", "-c", "java -Dcantaloupe.config=/etc/cantaloupe.properties -Dcom.sun.media.jai.disableMediaLib=true -Xms4g -Xmx12g -jar /usr/local/cantaloupe/cantaloupe-$VERSION.war"]
