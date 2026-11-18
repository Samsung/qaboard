# The latest patch of a minor version: Metabase migrates its database when it upgrades, and can't downgrade
FROM metabase/metabase:v0.65.x

# Proxy/cert configuration — no-ops when args are empty (open-source builds)
ARG PROXY_URL=""
ARG CA_CERT_URL=""
ARG NO_PROXY=""

ENV HTTP_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL} https_proxy=${PROXY_URL} \
    NO_PROXY=${NO_PROXY}

# Site-specific certs and Java keystore — only run when args are set
RUN if [ -n "$CA_CERT_URL" ]; then \
      wget "$CA_CERT_URL" -P /usr/local/share/ca-certificates/; \
    fi

# JAVA_TOOL_OPTIONS for proxy/trust — set by SIRC overlay via environment, not build args
