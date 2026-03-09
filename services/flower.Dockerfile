FROM mher/flower
USER root

# Proxy/cert configuration — no-ops when args are empty (open-source builds)
ARG PROXY_URL=""
ARG NO_PROXY=""

ENV HTTP_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL} https_proxy=${PROXY_URL} \
    NO_PROXY=${NO_PROXY}


# Proxy/cert configuration — no-ops when args are empty (open-source builds)
ARG PROXY_URL=""
ARG CA_CERT_URL=""
ARG NO_PROXY=""
RUN if [ -n "$PROXY_URL" ]; then \
      sed -i 's/https/http/g' /etc/apk/repositories; \
    fi
RUN apk update && apk add --no-cache ca-certificates
# Copy any site-specific certs (directory may be empty for open-source builds)
# COPY services/cantaloupe/cert/ /tmp/cert/
RUN if ls /tmp/cert/*.crt 1>/dev/null 2>&1; then \
      cp /tmp/cert/*.crt /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi && \
    if [ -n "$CA_CERT_URL" ]; then \
      wget "$CA_CERT_URL" -P /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi

RUN if [ -n "$PROXY_URL" ]; then \
      echo "[global]\ntrusted-host = pypi.python.org\n pypi.org\n files.pythonhosted.org\n download.pytorch.org\n github.com\n objects.githubusercontent.com\n" > /etc/pip.conf; \
    fi

RUN apk update && apk add --no-cache --virtual build-dependencies cmake g++ make nasm

COPY . /qaboard

RUN pip install /qaboard

# Install site-specific extras (e.g. QABOARD_EXTRA=sirc)
ARG GIT_SERVER=""
RUN --mount=type=ssh \
    if [ -n "$GIT_SERVER" ]; then \
      apk update && apk add --no-cache openssh-client && \
      ssh -T -o StrictHostKeyChecking=no git@$GIT_SERVER; \
    fi
ENV PYTHONPATH="/opt/site-packages:${PYTHONPATH}"
ARG QABOARD_EXTRA=""
ARG CDE_PACKAGE=""
RUN --mount=type=ssh \
    --mount=type=cache,target=/root/.cache/uv \
    if [ -n "$QABOARD_EXTRA" ]; then \
      pip install --no-deps --target /opt/site-packages \
        "qaboard-site-$QABOARD_EXTRA @ file:../deployments/$QABOARD_EXTRA/cli" "$CDE_PACKAGE"; \
    fi

USER flower
