# Based on https://github.com/wjordan/dockerfile-libvips
# Original: alpine:edge + vips-tools from edge/testing
# Updated: alpine:3.21 (pinned), vips-tools now in community repo
FROM alpine:3.21

# SIRC proxy
ENV http_proxy=http://webproxy.transchip.com:8080 \
    https_proxy=http://webproxy.transchip.com:8080 \
    HTTP_PROXY=http://webproxy.transchip.com:8080 \
    HTTPS_PROXY=http://webproxy.transchip.com:8080

# Override default repos with HTTP (SIRC proxy breaks HTTPS/SSL)
RUN echo "http://dl-cdn.alpinelinux.org/alpine/v3.21/main" > /etc/apk/repositories \
    && echo "http://dl-cdn.alpinelinux.org/alpine/v3.21/community" >> /etc/apk/repositories \
    && apk add --no-cache vips-tools bash \
    && rm -rf /var/cache/apk/*