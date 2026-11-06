# this file is an edited version of https://github.com/crkn-rcdr/cihm-cantaloupe/blob/master/Dockerfile
FROM alpine:3.21

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

# - a Java runtime, without the compiler (JDK). Not openjdk11-jre-headless: Alpine puts the natives of ImageIO's JPEG
#   reader and of color management (libjavajpeg, liblcms) in openjdk11-jre, Cantaloupe doesn't start without them
# - opj_decompress, for the JPEG2000 images (OpenJpegProcessor, see cantaloupe.properties)
# The other processors cantaloupe.properties picks (Java2dProcessor, PdfBoxProcessor) are pure Java.
# No libjpeg-turbo (TurboJpegProcessor) or GraphicsMagick: cantaloupe.properties doesn't use the first, and Cantaloupe 5
# removed GraphicsMagickProcessor.
# wget: GNU wget, which works through proxies (busybox's doesn't always)
RUN apk add --no-cache ca-certificates wget openjdk11-jre openjpeg-tools

ENV JAVA_HOME=/usr/lib/jvm/java-11-openjdk

# Copy any site-specific certs (directory may be empty for open-source builds)
COPY cert/ /tmp/cert/
RUN if ls /tmp/cert/*.crt 1>/dev/null 2>&1; then \
      cp /tmp/cert/*.crt /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi && \
    if [ -n "$CA_CERT_URL" ]; then \
      wget "$CA_CERT_URL" -O "/usr/local/share/ca-certificates/$(basename "$CA_CERT_URL")" && \
      update-ca-certificates; \
    fi


ENV VERSION=5.0.5

ARG user=cantaloupe
ARG uid=8182
ARG group=cantaloupe
ARG gid=8182
RUN wget -q "https://github.com/medusa-project/cantaloupe/releases/download/v$VERSION/Cantaloupe-$VERSION.zip" --no-check-certificate \
  && mkdir -p /usr/local/ \
  && cd /usr/local \
  && unzip -q /tmp/Cantaloupe-$VERSION.zip \
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

USER $user
CMD ["sh", "-c", "java -Dcantaloupe.config=/etc/cantaloupe.properties -Xms4g -Xmx12g -jar /usr/local/cantaloupe/cantaloupe-$VERSION.jar"]
