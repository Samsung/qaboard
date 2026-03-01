# https://pythonspeed.com/articles/base-image-python-docker-images/
FROM python:3.13-slim-trixie

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

RUN apt-get update -qq && \
    apt-get install -y ca-certificates wget && \
    if [ -n "$CA_CERT_URL" ]; then \
      wget "$CA_CERT_URL" -P /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi


    # Keeps Python from generating .pyc files for 1-time use in the container's unionFS
ENV PYTHONDONTWRITEBYTECODE=1 \
    # Turns off buffering for easier container logging
    PYTHONUNBUFFERED=1 \
    # Tracebacks on segfaults
    PYTHONFAULTHANDLER=1 \
    # Avoid issues with SSL misconfigured at SIRC
    PYTHONWARNINGS="ignore:Unverified HTTPS request"


# Git: debian ships a recent enough version without requiring an alternative PPA
ARG GIT_SSL_VERIFY="true"
RUN apt-get install -y git && \
    if [ -n "$PROXY_URL" ]; then \
      git config --global http.proxy "$PROXY_URL"; \
    fi

RUN if [ "$GIT_SSL_VERIFY" = "false" ]; then \
      git config --global http.sslVerify false; \
    fi && \
    # gc tends to take time in our big repos and the locks slow everything down
    # causing uwsgi to spawn more workers and eat RAM
    git config --global gc.auto 0 && \
    # We manage git repos in various directories...
    git config --system --add safe.directory '*' && \
    git config --global --add safe.directory '*'

RUN apt-get update -qq && \
    apt-get install -y \
    # https://www.psycopg.org/docs/install.html#install-from-source
    # https://www.psycopg.org/docs/faq.html#faq-compile
    libpq-dev build-essential \
    # for Ldap Authentication
    libsasl2-dev libldap2-dev \
    # At SIRC we need to be able to turn into any user to delete their output files
    sudo \
    # procps is a set of command line and full-screen utilities that
    # provide information out of the pseudo-filesystem.
    # https://github.com/warmchang/procps
    procps
    # If we want uwsgi's routing support we need libpcre
    # https://uwsgi-docs.readthedocs.io/en/latest/InternalRouting.html
    # we used to have libpcre3 but it is not shipped as part of recent debian
    # https://launchpad.net/ubuntu/+source/uwsgi/+changelog
    # and this breaks at link-time
    # libpcre2-dev

# Required to build some projects from source
RUN apt-get update -qq && \
    apt-get install -y \
    # for scipy if python is very recent
    gfortran pkg-config libopenblas-dev liblapack-dev \
    # required for python3-saml for python-xmlsec https://xmlsec.readthedocs.io/en/stable/install.html
    libxml2-dev libxmlsec1-dev libxmlsec1-openssl libz-dev

# https://github.com/xmlsec/python-xmlsec/issues/320
ENV UWSGI_PROFILE_OVERRIDE="xml=no"


# References:
# https://docs.astral.sh/uv/guides/integration/docker/
# https://hynek.me/articles/docker-uv/
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /uvx /bin/
    # Already isolated environment
ENV UV_SYSTEM_PYTHON=1 \
    # Silence uv complaining about not being able to use hard links
    UV_LINK_MODE=copy \
    # Faster application startups
    UV_COMPILE_BYTECODE=1 \
    # Prevent uv from accidentally downloading isolated Python builds
    UV_PYTHON_DOWNLOADS=never

# Make it possible to resolve dependencies of the CLI package
WORKDIR /qaboard
COPY pyproject.toml README.md ./

WORKDIR /qaboard/backend
# Install all dependencies
RUN --mount=type=ssh \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=backend/uv.lock,target=uv.lock,readwrite \
    --mount=type=bind,source=backend/pyproject.toml,target=pyproject.toml \
    uv sync \
    # we ran into issues making sure we really build uwsgi
    # from source to use the UWSGI_PROFILE_OVERRIDE set above
    # --refresh-package uwsgi \
    # --no-binary-package uwsgi \
    #FIXME: when we fix the xml bugs and issues then we can uncomment --locked
    # --locked \
    --no-install-project \
    --no-install-package qaboard

# FIXME: should not be needed: why don't we use the system python?
ENV PATH="/qaboard/backend/.venv/bin:$PATH"

# Backend
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
    uv sync --refresh-package qaboard
    #FIXME: when we fix the xml bugs and issues then we can uncomment --locked
    # --locked

# Install site-specific extras (e.g. QABOARD_EXTRA=sirc)
ARG QABOARD_EXTRA=""
RUN --mount=type=ssh \
    --mount=type=cache,target=/root/.cache/uv \
    if [ -n "$QABOARD_EXTRA" ]; then \
      ssh -T -o StrictHostKeyChecking=no git@gitlab-srv || true && \
      uv sync --extra "$QABOARD_EXTRA" --refresh-package qaboard; \
    fi

# Clear proxy env so it doesn't leak into runtime containers
ENV HTTP_PROXY="" http_proxy="" \
    HTTPS_PROXY="" https_proxy="" \
    NO_PROXY=""

ENV QA_NO_CHECK_FOR_UPDATES=1

# Where we keep a cache of application data (e.g. git clones)
VOLUME /var/qaboard
# It's useful to make it world-writable so that
# we can run as a non-root user during dev and clone without issues
RUN mkdir -p /var/qaboard/git && chmod -R 777 /var/qaboard/git

WORKDIR /qaboard/backend
CMD ["/qaboard/backend/init.sh"]
