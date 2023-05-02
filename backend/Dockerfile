# https://pythonspeed.com/articles/base-image-python-docker-images/
FROM python:3.11-slim-bullseye
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
    PYTHONFAULTHANDLER=1


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

# we want /qaboard to "look" like a package for poetry not to fail 
WORKDIR /qaboard
COPY setup.py fastentrypoints.py  ./

# We use the approch described in
#   https://pythonspeed.com/articles/pipenv-docker/
# There are other ways to do it, maybe faster
#   https://github.com/python-poetry/poetry/issues/1301
#   https://github.com/python-poetry/poetry/issues/856
RUN pip install poetry
# required to build python-scipy from source, since we use python3.11
# and they are not available pre-built yet...
RUN apt-get install -y gfortran pkg-config libopenblas-dev liblapack-dev

WORKDIR /qaboard/backend
COPY backend/pyproject.toml backend/poetry.lock ./
# Inside the docker container we don't care about isolating virtual environment
# otherwise we end of with a random (but stable) virtual env name, and it makes
# changing PATH to use the installed executable challenging.
# There are other approaches
# https://github.com/python-poetry/poetry/issues/1579
# https://github.com/python-poetry/poetry/issues/214 
RUN poetry config virtualenvs.create false
# [SIRC] We ran into strange host-key verification issues when downloading packages via poetry
RUN git config --global http.sslVerify false
# https://github.com/jelmer/dulwich/issues/698
# https://github.com/jelmer/dulwich/issues/879
# https://github.com/jelmer/dulwich/issues/1025
RUN poetry install -vvv --no-root
ENV QA_NO_CHECK_FOR_UPDATES=1

# Copy-in everything else:
COPY backend ./

WORKDIR /qaboard
COPY README.md MANIFEST.in ./
WORKDIR /qaboard/qaboard
COPY qaboard/ ./
WORKDIR /qaboard/tests
COPY tests/ ./

WORKDIR /qaboard
# We want to install "qaboard", but copying it ahead of time invalidates the build cache
# this solution still has us install the pinned-deps of "qaboard" each time...
# I guess we should bury our pride and list qaboard's deps as deps of the backend,
# this way the install below would not install any 3rd parties :| 
WORKDIR /qaboard/backend
COPY backend/wait-for-it.sh backend/init.sh backend/uwsgi.ini ./

# SIRC-only, installs cde-python, used to read hex/raw images for the auto-ROI feature
# It's annoying to use ssh from docker-compose, and our network doesn't help - better vendor cde-python...
# This patch prints the repo paths when cloning with ssh, so that we get more info! (-vvv doens't help) 
COPY third_party/cde-python /qaboard/third_party/cde-python
RUN sed -i 's/if not cls\.is_using_legacy_client\(\)/if (print(url, file=open("\/dev\/stdout", "w"))) or not cls.is_using_legacy_client/g' /usr/local/lib/python3.11/site-packages/poetry/vcs/git/backend.py && \
    grep is_using_legacy_client /usr/local/lib/python3.11/site-packages/poetry/vcs/git/backend.py
RUN sed -i 's~cde @ git+ssh://git@gitlab-srv/cde/cde-python~cde @ file://localhost/qaboard/third_party/cde-python#egg=cde~' ../setup.py && \
    sed -i 's~url = "ssh://git@gitlab-srv/cde/cde-python"~path = "/qaboard/third_party/cde-python/"~' poetry.lock && \
    sed -i 's~git = "ssh://git@gitlab-srv/cde/cde-python"~path = "/qaboard/third_party/cde-python/"~' poetry.lock && \
    sed -i 's~type = "git"~type = "path"~' poetry.lock && \
    grep cde-python ../setup.py && grep -C3 cde-python poetry.lock
RUN poetry install -vvv --extras qaboard
RUN git config --system --add safe.directory '*' && \
    git config --global --add safe.directory '*'

# RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org /cde-python
# https://pythonspeed.com/articles/build-secrets-docker-compose/
# https://github.com/docker/compose/pull/7296
# https://github.com/docker/compose/pull/6865
# https://github.com/docker/compose/issues/6358


WORKDIR /qaboard/backend
CMD ["/qaboard/backend/init.sh"]

# Where we keep a cache of application data (e.g. git clones)
VOLUME /var/qaboard
# It's useful to make it world-writable so that
# we can run as a non-root user during dev and clone without issues
RUN mkdir -p /var/qaboard/git && chmod -R 777 /var/qaboard/git


# TODO:
#   Projects can define their own iter_inputs() function to find inputs
#   The use case it to connect to databases. However, at this stage the function is executed
#   directly by the server. Not only is it unsecure (on our network let's say it's allright...),
#   but it introduces a strong coupling between dependencies needed by projects and the server.
#   Solutions could be:
#   - [x] Short term, make those users call in a subprocess *their* python with dependencies, and read from STDOUT.
#         we could read their projects's .envrc
#   - [ ] Middle term, execute those functions in a docker container used by users to define their environment
#   - [ ] The above makes things *slow* (?). What do we do? A sort of iter_input server?
#         Limit the logic/connections available to users? 
