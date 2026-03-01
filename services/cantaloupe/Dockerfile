# this file is an edited version of https://github.com/crkn-rcdr/cihm-cantaloupe/blob/master/Dockerfile
FROM alpine:3.10

WORKDIR /tmp

# Proxy/cert configuration — no-ops when args are empty (open-source builds)
ARG PROXY_URL=""
ARG CA_CERT_URL=""
ARG NO_PROXY=""

RUN if [ -n "$PROXY_URL" ]; then \
      sed -i 's/https/http/g' /etc/apk/repositories; \
    fi
ENV HTTP_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL} https_proxy=${PROXY_URL} \
    NO_PROXY=${NO_PROXY}

RUN apk update && apk add ca-certificates && rm -rf /var/cache/apk/*

# Copy any site-specific certs (directory may be empty for open-source builds)
COPY cert/ /tmp/cert/
RUN if ls /tmp/cert/*.crt 1>/dev/null 2>&1; then \
      cp /tmp/cert/*.crt /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi && \
    if [ -n "$CA_CERT_URL" ]; then \
      wget "$CA_CERT_URL" -P /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi


RUN apk add --no-cache --update -X http://dl-cdn.alpinelinux.org/alpine/edge/community \
    curl \
    graphicsmagick \
    openjpeg-tools \
    wget \
    && rm -rf /var/cache/apk/*

ENV GEM_HOME=/tmp/gems \
  JAVA_HOME=/usr/lib/jvm/java-11-openjdk

RUN apk --no-cache add openjdk11 wget openjpeg-tools\
  && rm -rf /var/cache/apk/*

# https://github.com/crkn-rcdr/cihm-cantaloupe/issues/15
RUN cd /tmp && apk add --no-cache --virtual build-dependencies cmake g++ make nasm \
  && wget https://github.com/libjpeg-turbo/libjpeg-turbo/archive/2.0.4.tar.gz -O libjpeg-turbo-2.0.4.tar.gz --no-check-certificate\
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



ENV VERSION=5.0.5

ARG user=cantaloupe
ARG uid=8182
ARG group=cantaloupe
ARG gid=8182
RUN wget -nv "https://github.com/medusa-project/cantaloupe/releases/download/v$VERSION/Cantaloupe-$VERSION.zip" --no-check-certificate \
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
RUN mkdir -p /var/logs/cantaloupe && mkdir -p /srv/cantaloupe/logs
VOLUME /srv/cantaloupe
RUN chmod 777 /srv/cantaloupe && chmod 777 /srv/cantaloupe/logs

# ENV GEM_HOME /tmp/gems
USER $user
CMD ["sh", "-c", "java -Dcantaloupe.config=/etc/cantaloupe.properties -Xms4g -Xmx12g -jar /usr/local/cantaloupe/cantaloupe-$VERSION.jar"]
