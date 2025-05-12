# https://pythonspeed.com/articles/base-image-python-docker-images/
FROM python:3.12-slim-bookworm

LABEL maintainer="arthurf.flam@samsung.com"

# SIRC proxy configuration [debian/ubuntu]
# Copied from http://gitlab-srv/docker/drun/snippets/11/edit
# if you still run into network issues, try building the image on a different server :_)
ENV PROXY_HOST=webproxy.transchip.com \
        PROXY_PORT=8080 \
        PROXY_PROTOCOL=http
ENV PROXY $PROXY_PROTOCOL://$PROXY_HOST:$PROXY_PORT
RUN echo "Acquire::http::Proxy \"$PROXY\";" >> /etc/apt/apt.conf; \
    echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf; \
    echo "[http]\nsslverify = false\n# proxy = $PROXY" >> /root/.gitconfig
ENV HTTP_PROXY=$PROXY \
    http_proxy=$PROXY \
    HTTPS_PROXY=$PROXY \
    https_proxy=$PROXY \
    NO_PROXY='gitlab-srv,gitlab-srv.transchip.com,localhost,aospt-dt,sentry,sentry.transchip.com'


RUN apt-get update -qq && \
    apt-get install ca-certificates wget -y && \
    wget http://itweb/downloads/sirc-ca.crt -P /usr/local/share/ca-certificates/ && \
    update-ca-certificates


    # Keeps Python from generating .pyc files for 1-time use in the container's unionFS
ENV PYTHONDONTWRITEBYTECODE=1 \
    # Turns off buffering for easier container logging
    PYTHONUNBUFFERED=1 \
    # Tracebacks on segfaults
    PYTHONFAULTHANDLER=1 \
    # Avoid issues with SSL misconfigured at SIRC
    PYTHONWARNINGS="ignore:Unverified HTTPS request"


# Install git, up-to-date.
# The application manages a cache of all projects' repos, so it's useful.
# If we ran into scale issues, we could look into a service like Gitlab's gitaly.
# Note: if we didn't have proxy issues we would just
#       add-apt-repository -y ppa:git-core/ppa
RUN apt-get update -qq && \
    apt-get install -y gpg
    # This should work but doesn't because of proxy issues
    # apt-get install -y software-properties-common && \
    # add-apt-repository ppa:git-core/ppa && \
RUN echo start && \
    echo "deb http://ppa.launchpad.net/git-core/ppa/ubuntu trusty main" >> /etc/apt/sources.list && \
    echo "deb-src http://ppa.launchpad.net/git-core/ppa/ubuntu trusty main" >> /etc/apt/sources.list && \
    # this should work but gpg seems to not be found
    # gpg --batch --keyserver hkp://keyserver.ubuntu.com:80 --keyserver-options http-proxy=$HTTP_PROXY --recv-keys A1715D88E1DF1F24 && \
    apt-key adv --keyserver-options http-proxy=$HTTP_PROXY --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys A1715D88E1DF1F24 && \
    apt-get update -qq && apt-get install -y git && \
    git config --global http.proxy $PROXY

# [SIRC] We ran into strange host-key verification issues when downloading packages via poetry
RUN git config --global http.sslVerify false && \
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
    procps \
    # If we want uwsgi's routing support
    # https://uwsgi-docs.readthedocs.io/en/latest/InternalRouting.html
    libpcre3 libpcre3-dev

# Required to build some projects from source
RUN apt-get update -qq && \
    apt-get install -y \
    # for scipy if python is very recent
    gfortran pkg-config libopenblas-dev liblapack-dev \
    # required for python3-saml for python-xmlsec https://xmlsec.readthedocs.io/en/stable/install.html
    libxml2-dev libxmlsec1-dev libxmlsec1-openssl

# https://github.com/xmlsec/python-xmlsec/issues/320
ENV UWSGI_PROFILE_OVERRIDE="xml=no"


# References:
# https://docs.astral.sh/uv/guides/integration/docker/
# https://hynek.me/articles/docker-uv/
COPY --from=ghcr.io/astral-sh/uv:0.7.3 /uv /uvx /bin/
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

# Including internal dependencies
RUN --mount=type=ssh ssh -T -o StrictHostKeyChecking=no git@gitlab-srv

WORKDIR /qaboard/backend
# Install all dependencies
RUN --mount=type=ssh \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=backend/uv.lock,target=uv.lock,readwrite \
    --mount=type=bind,source=backend/pyproject.toml,target=pyproject.toml \
    uv sync \
    --refresh-package uwsgi \
    --no-binary-package uwsgi \
    --locked \
    --no-install-project \
    --no-install-package qaboard && \
    # needs a build...
    uv add uwsgi --refresh-package uwsgi --no-binary-package uwsgi

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
    uv sync --locked


ENV QA_NO_CHECK_FOR_UPDATES=1

# Where we keep a cache of application data (e.g. git clones)
VOLUME /var/qaboard
# It's useful to make it world-writable so that
# we can run as a non-root user during dev and clone without issues
RUN mkdir -p /var/qaboard/git && chmod -R 777 /var/qaboard/git

WORKDIR /qaboard/backend
CMD ["/qaboard/backend/init.sh"]
