# https://pythonspeed.com/articles/base-image-python-docker-images/
FROM python:3.8-slim-buster
LABEL maintainer="arthurf.flam@samsung.com"


    # Keeps Python from generating .pyc files for 1-time use in the container's unionFS
ENV PYTHONDONTWRITEBYTECODE=1 \
    # Turns off buffering for easier container logging
    PYTHONUNBUFFERED=1 \
    # Tracebacks on segfaults
    PYTHONFAULTHANDLER=1 \
    DEBIAN_FRONTEND=noninteractive


# Install git, up-to-date.
# The application manages a cache of all projects' repos, so it can be useful.
# If we ran into scale issues, we could look into a service like Gitlab's gitaly.
RUN apt-get update -qq \
#     && apt-get install -y gnupg2 software-properties-common apt-utils \
#     && apt-key adv --keyserver keyserver.ubuntu.com --recv-keys A1715D88E1DF1F24 \
#     && add-apt-repository -y ppa:git-core/ppa \
#     && apt-get update -qq \
    && apt-get install -y git


# https://www.psycopg.org/docs/install.html#install-from-source
# https://www.psycopg.org/docs/faq.html#faq-compile
RUN apt-get update \
    # postgresql and toolchain
    && apt-get install -y libpq-dev gcc \
    # login packages
    && apt-get install -y libsasl2-dev libldap2-dev libssl-dev \
    && apt-get clean

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

# TODO: "poetry add" it 
RUN pip install celery



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
