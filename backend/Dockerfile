# https://pythonspeed.com/articles/base-image-python-docker-images/
FROM python:3.8-slim-buster
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
    NO_PROXY='gitlab-srv,gitlab-srv.transchip.com,localhost,aospt-dt'


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
RUN apt-get update && apt-get install -y gnupg2 && \
    echo "deb http://ppa.launchpad.net/git-core/ppa/ubuntu trusty main" >> /etc/apt/sources.list && \
    echo "deb-src http://ppa.launchpad.net/git-core/ppa/ubuntu trusty main" >> /etc/apt/sources.list && \
    apt-key adv --keyserver-options http-proxy=$HTTP_PROXY --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys A1715D88E1DF1F24 && \
    apt-get update -qq && apt-get install -y git && \
    git config --global http.proxy $PROXY


# https://www.psycopg.org/docs/install.html#install-from-source
# https://www.psycopg.org/docs/faq.html#faq-compile
RUN apt-get update && apt-get install -y libpq-dev gcc
# for Ldap Authentication
RUN apt-get update && apt-get install libsasl2-dev libldap2-dev -y

# At SIRC we need to be able to turn into any user to delete their output files
RUN apt-get update && apt-get install -y sudo

# If we want uwsgi's routing support
# https://uwsgi-docs.readthedocs.io/en/latest/InternalRouting.html
# RUN sudo apt-get install libpcre3 libpcre3-dev

# we want /qaboard to "look" like a package for poetry not to fail 
WORKDIR /qaboard
COPY setup.py fastentrypoints.py  ./

# We use the approch described in
#   https://pythonspeed.com/articles/pipenv-docker/
# There are other ways to do it, maybe faster
#   https://github.com/python-poetry/poetry/issues/1301
#   https://github.com/python-poetry/poetry/issues/856
RUN pip install poetry
WORKDIR /qaboard/backend
COPY backend/pyproject.toml backend/poetry.lock ./
# Inside the docker container we don't care about isolating virtual environment
# otherwise we end of with a random (but stable) virtual env name, and it makes
# changing PATH to use the installed executable challenging.
# There are other approaches
# https://github.com/python-poetry/poetry/issues/1579
# https://github.com/python-poetry/poetry/issues/214 
RUN poetry config virtualenvs.create false
RUN poetry install --no-root
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
RUN poetry install --extras qaboard



# SIRC-only, installs cde-python, used to read hex/raw images for the auto-ROI feature
COPY third_party/cde-python /cde-python
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org /cde-python
# --ssh is not supported by docker-compose at this point
# so the simplest option is vendoring...!
# https://pythonspeed.com/articles/build-secrets-docker-compose/
# https://github.com/docker/compose/pull/7296
# https://github.com/docker/compose/pull/6865
# https://github.com/docker/compose/issues/6358


WORKDIR /qaboard/backend
CMD ["/qaboard/backend/init.sh"]

# Where we keep a cache of application data (e.g. git clones)
VOLUME /var/qaboard
RUN mkdir -p /var/qaboard && chmod -R 777 /var/qaboard


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
