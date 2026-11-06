# https://pythonspeed.com/articles/base-image-python-docker-images/
# TODO: 3.14 when pillow ships in binary https://pillow.readthedocs.io/en/latest/installation/platform-support.html
#       -slim-trixie when python-ldap binary links with the updated libldap..
# Stages:
# - base: Python, git, the shared libraries the dependencies link to, uv
# - build-deps: + compilers and headers, the Python dependencies (some are compiled: uwsgi, lxml, xmlsec, python-ldap, psycopg2)
# - site: site-specific packages (QABOARD_EXTRA, CDE_PACKAGE)
# - dev: used by development.yml, which mounts the code: the compilers stay, for `uv run`
# - production (default): base + the dependencies + the code, without the compilers and headers
FROM python:3.13-slim-bookworm AS base

LABEL maintainer="arthurf.flam@samsung.com"

# Proxy/cert configuration — no-ops when args are empty (open-source builds)
# SIRC/DSK pass values via compose overlay build args
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

# What the server needs at runtime, in one layer:
# - git (and ssh, for the repositories cloned with ssh), sudo (at SIRC we need to be able to turn into any user to
#   delete their output files), procps (ps, top...)
# - the shared libraries of the dependencies compiled in build-deps: libpq (psycopg2), libldap and libsasl
#   (python-ldap), libxml2, libxslt and libxmlsec1 (lxml, xmlsec)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
      ca-certificates wget \
      git openssh-client less \
      sudo procps \
      libpq5 \
      libldap-2.5-0 libldap-common libsasl2-2 libsasl2-modules \
      libxml2 libxslt1.1 libxmlsec1 libxmlsec1-openssl && \
    rm -rf /var/lib/apt/lists/* && \
    if [ -n "$CA_CERT_URL" ]; then \
      wget "$CA_CERT_URL" -P /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi
# requests verifies with certifi's CAs, not the system's: without it, the SSO provider (and git hosts...) signed by
# CA_CERT_URL's CA fail TLS. The system bundle has the usual public CAs too.
# uv has its own CAs too: SSL_CERT_FILE makes it use the system's, e.g. to download build backends (hatchling) through
# a proxy signed by CA_CERT_URL's CA ("invalid peer certificate: UnknownIssuer")
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt


    # Keeps Python from generating .pyc files for 1-time use in the container's unionFS
ENV PYTHONDONTWRITEBYTECODE=1 \
    # Turns off buffering for easier container logging
    PYTHONUNBUFFERED=1 \
    # Tracebacks on segfaults
    PYTHONFAULTHANDLER=1 \
    # Avoid issues with SSL misconfigured at SIRC
    PYTHONWARNINGS="ignore:Unverified HTTPS request"


ARG GIT_SSL_VERIFY="true"
RUN if [ -n "$PROXY_URL" ]; then \
      git config --global http.proxy "$PROXY_URL"; \
    fi && \
    if [ "$GIT_SSL_VERIFY" = "false" ]; then \
      git config --global http.sslVerify false; \
    fi && \
    # gc tends to take time in our big repos and the locks slow everything down
    # causing uwsgi to spawn more workers and eat RAM
    git config --global gc.auto 0 && \
    # We manage git repos in various directories...
    git config --system --add safe.directory '*' && \
    git config --global --add safe.directory '*'

ARG GIT_SERVER=""
RUN --mount=type=ssh \
    if [ -n "$GIT_SERVER" ]; then \
      ssh -T -o StrictHostKeyChecking=no git@$GIT_SERVER; \
    fi


# References:
# https://docs.astral.sh/uv/guides/integration/docker/
# https://hynek.me/articles/docker-uv/
COPY --from=ghcr.io/astral-sh/uv:0.10.7 /uv /uvx /bin/
    # Already isolated environment
ENV UV_SYSTEM_PYTHON=1 \
    UV_PROJECT_ENVIRONMENT="/usr/local/" \
    # Still useful for dev
    PATH="/qaboard/backend/.venv/bin:$PATH" \
    # Silence uv complaining about not being able to use hard links
    UV_LINK_MODE=copy \
    # Faster application startups
    UV_COMPILE_BYTECODE=1 \
    # Prevent uv from accidentally downloading isolated Python builds
    UV_PYTHON_DOWNLOADS=never

ENV QA_NO_CHECK_FOR_UPDATES=1

# Where we keep a cache of application data (e.g. git clones)
# It's useful to make it world-writable so that
# we can run as a non-root user during dev and clone without issues
RUN mkdir -p /var/qaboard/git && chmod -R 777 /var/qaboard/git


FROM base AS build-deps
# To compile the dependencies without binary wheels (see tool.uv.no-binary-package in backend/pyproject.toml)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
      build-essential pkg-config \
      # https://www.psycopg.org/docs/install.html#install-from-source
      libpq-dev \
      # for Ldap Authentication
      libsasl2-dev libldap2-dev \
      # required for python3-saml for python-xmlsec https://xmlsec.readthedocs.io/en/stable/install.html
      libxml2-dev libxmlsec1-dev libxslt1-dev zlib1g-dev && \
    rm -rf /var/lib/apt/lists/*
    # If we want uwsgi's routing support we need libpcre
    # https://uwsgi-docs.readthedocs.io/en/latest/InternalRouting.html
    # we used to have libpcre3 but it is not shipped as part of recent debian
    # https://launchpad.net/ubuntu/+source/uwsgi/+changelog
    # and this breaks at link-time
    # libpcre2-dev

# Make it possible to resolve dependencies of the CLI package
# README.md is only needed later to build the qaboard package: copying it here would mean that
# editing it invalidates the cache of the slow dependency layer below (uwsgi/lxml/xmlsec are compiled)
WORKDIR /qaboard
COPY pyproject.toml ./

WORKDIR /qaboard/backend
# Install all dependencies
# https://github.com/xmlsec/python-xmlsec/issues/320
ENV UWSGI_PROFILE_OVERRIDE="xml=no" \
    CC=gcc \
    CXX=g++
RUN --mount=type=ssh \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=backend/uv.lock,target=uv.lock,readwrite \
    --mount=type=bind,source=backend/pyproject.toml,target=pyproject.toml \
    uv sync \
    # we ran into issues making sure we really build uwsgi
    # From source to use the UWSGI_PROFILE_OVERRIDE set above
    #FIXME: when we fix the xml bugs and issues then we can uncomment --locked
    # --locked \
    --no-install-project \
    --no-install-package qaboard


# Install site-specific extras (e.g. QABOARD_EXTRA=sirc) in their own stage: they are installed again only when
# deployments/ or the args change, not with each change of the code
FROM base AS site
WORKDIR /qaboard/backend
ARG QABOARD_EXTRA=""
ARG CDE_PACKAGE=""
# deployments/ is only mounted during the build: images don't contain other sites' configuration
RUN --mount=type=ssh \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=deployments,target=/qaboard/deployments,rw \
    mkdir -p /opt/site-packages && \
    if [ -n "$QABOARD_EXTRA" ]; then \
      ## Cannot work as uv requires to resolve even extras...
      # uv sync --extra "$QABOARD_EXTRA" --refresh-package qaboard; \
      ## Annoying for dev and when managing lock-files
      # uv pip install "qaboard-site-$QABOARD_EXTRA @ file:../deployments/$QABOARD_EXTRA/cli" "$CDE_PACKAGE"; \
      uv pip install --no-deps --target /opt/site-packages \
        "qaboard-site-$QABOARD_EXTRA @ file:../deployments/$QABOARD_EXTRA/cli" "$CDE_PACKAGE"; \
    fi


# For development.yml: it mounts the code, and `uv run` may compile dependencies
FROM build-deps AS dev
COPY --from=site /opt/site-packages /opt/site-packages
ENV PYTHONPATH="/opt/site-packages:${PYTHONPATH}"
ARG QABOARD_EXTRA=""
ARG CDE_PACKAGE=""
ENV CDE_PACKAGE=${CDE_PACKAGE} QABOARD_EXTRA=${QABOARD_EXTRA}
VOLUME /var/qaboard
CMD ["/qaboard/backend/init.sh"]


FROM base AS production
# The dependencies, without the compilers and headers they were built with
COPY --from=build-deps /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/site-packages
COPY --from=build-deps /usr/local/bin /usr/local/bin

# Backend
WORKDIR /qaboard
COPY pyproject.toml README.md ./
WORKDIR /qaboard/backend
ADD backend .
# CLI package
WORKDIR /qaboard/qaboard
COPY qaboard/ ./
WORKDIR /qaboard/tests
COPY tests/ ./


WORKDIR /qaboard/backend
# Sync the project, asserting the lockfile is up to date
# with a shared cache across builds
RUN --mount=type=ssh \
    --mount=type=cache,target=/root/.cache/uv \
    uv sync --refresh-package qaboard && \
    # The backend is installed in editable mode, so uv doesn't compile it (UV_COMPILE_BYTECODE): with
    # PYTHONDONTWRITEBYTECODE, each process would compile it again when it starts (uwsgi, the jobs worker, migrations...)
    python -m compileall -q backend
    #FIXME: when we fix the xml bugs and issues then we can uncomment --locked
    # --locked

COPY --from=site /opt/site-packages /opt/site-packages
ENV PYTHONPATH="/opt/site-packages:${PYTHONPATH}"
ARG QABOARD_EXTRA=""
ARG CDE_PACKAGE=""
# Useful if we need to dev...
ENV CDE_PACKAGE=${CDE_PACKAGE}
ENV QABOARD_EXTRA=${QABOARD_EXTRA}

# TODO: Ideally clear proxy env so it doesn't leak into runtime containers
# but for dev it is not a good experience
# ENV HTTP_PROXY="" http_proxy="" \
#     HTTPS_PROXY="" https_proxy=""
#     # we keep NO_PROXY however!

# Where we keep a cache of application data (e.g. git clones)
VOLUME /var/qaboard

# More CAs to trust: space-separated *.crt paths in the build context, e.g. an intermediate certificate that the IdP
# doesn't send (browsers find it, requests doesn't: "unable to get local issuer certificate"). Late: it reads the context
ARG CA_CERTS=""
RUN --mount=type=bind,target=/context \
    set -e; if [ -n "$CA_CERTS" ]; then \
      for cert in $CA_CERTS; do cp "/context/$cert" /usr/local/share/ca-certificates/; done && \
      update-ca-certificates; \
    fi

# The version of the image, e.g. the commit it is built from (docker-compose.yml passes $QABOARD_VERSION):
# Sentry's release (see backend/sentry.py). Last, as it changes with each build.
ARG QABOARD_VERSION=""
ENV QABOARD_VERSION=${QABOARD_VERSION}

WORKDIR /qaboard/backend
CMD ["/qaboard/backend/init.sh"]
