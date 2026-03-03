# fluentd/Dockerfile

FROM fluent/fluentd:v1.16.6-debian-1.0

USER root

# Proxy/cert configuration — no-ops when args are empty (open-source builds)
ARG PROXY_URL=""
ARG CA_CERT_URL=""
ARG NO_PROXY=""

RUN if [ -n "$PROXY_URL" ]; then \
      echo "Acquire::http::Proxy \"$PROXY_URL\";" >> /etc/apt/apt.conf && \
      echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf; \
    fi
ENV HTTP_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL} https_proxy=${PROXY_URL} \
    NO_PROXY=${NO_PROXY}

RUN apt-get update -qq && \
    apt-get install -y ca-certificates wget && \
    if [ -n "$CA_CERT_URL" ]; then \
      wget "$CA_CERT_URL" -P /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

RUN apt-get install -y strace curl wget

# RUN ["gem", "install", "fluent-plugin-elasticsearch", "--no-document", "--version", "5.4.3"]
# RUN ["gem", "install", "fluent-plugin-concat", "--no-document", "--version", "2.5.0"]
RUN gem install fluent-plugin-elasticsearch:5.4.3 \
    fluent-plugin-concat:2.5.0 \
    fluent-plugin-grafana-loki --no-document

USER fluent
