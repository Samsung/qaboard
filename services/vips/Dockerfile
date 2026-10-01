# Based on https://github.com/wjordan/dockerfile-libvips
# Original: alpine:edge + vips-tools from edge/testing
# Updated: alpine:3.21 (pinned), vips-tools now in community repo
FROM alpine:3.21

# Proxy configuration — no-ops when args are empty (open-source builds)
# e.g. at SIRC: --build-arg PROXY_URL=http://webproxy.transchip.com:8080
ARG PROXY_URL=""
ENV http_proxy=${PROXY_URL} \
    https_proxy=${PROXY_URL} \
    HTTP_PROXY=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL}

# Behind a proxy, use HTTP repos (SIRC's proxy breaks HTTPS/SSL)
RUN if [ -n "$PROXY_URL" ]; then \
      sed -i 's/https/http/g' /etc/apk/repositories; \
    fi \
    && apk add --no-cache vips-tools bash \
    && rm -rf /var/cache/apk/*
