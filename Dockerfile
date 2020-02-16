# TODO: Use a lighter base image like alpine-linux
#       Possibly let's do it when we split the application
#       with docker-compose into database+backend+frontend+image-servers
FROM ubuntu:bionic
LABEL maintainer="arthurf.flam@samsung.com"



ENV DEBIAN_FRONTEND noninteractive
RUN apt-get update && \
    echo exit 0 > /usr/sbin/policy-rc.d && \
    # Essential utilities
    # Using --no-install-recommends doesn't work out-of-the-box, e.g. apt-key misses dirmngr later 
    apt-get install -y \
                       sudo \
                       wget curl sudo \
                       software-properties-common build-essential \
                       libc6-dev \
                       python-dev && \
    # Useful utilities when debugging the container
    apt-get install -y zsh htop tree less nano && \
    # Remove the cache
    rm -rf /var/lib/apt/lists/*


# Trust various SSL certificates used by Samsung's IT
COPY backend/deployment/DLP-TRITON.crt /usr/local/share/ca-certificates/samsung/DLP-TRITON.crt
COPY backend/deployment/sirc-ca.cer    /usr/local/share/ca-certificates/samsung/sirc-ca.cer
COPY backend/deployment/sirc-ca.crt    /usr/local/share/ca-certificates/samsung/sirc-ca.crt
RUN update-ca-certificates && \
    yes | dpkg-reconfigure ca-certificates --


# Install git, up-to-date.
# Since the application manages a cache of all projects' repos, it is preferable.
# If we ran into scale issues, we could look into a service like Gitlab's gitaly.
# Note: if we didn't have proxy issues we would just
#       add-apt-repository -y ppa:git-core/ppa
RUN echo "deb http://ppa.launchpad.net/git-core/ppa/ubuntu trusty main" >> /etc/apt/sources.list && \
    echo "deb-src http://ppa.launchpad.net/git-core/ppa/ubuntu trusty main" >> /etc/apt/sources.list && \
    apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys A1715D88E1DF1F24 && \
    apt-get update -qq && apt-get install -y git


# Install a complete Python environment
RUN wget --no-check-certificate https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh && \
    bash Miniconda3-latest-Linux-x86_64.sh -f -b -p /opt/anaconda3
ENV PATH /opt/anaconda3/bin:${PATH}
# TODO:
#   Ideally we should freeze dependencies, use requirement.txt/requirement.lock.txt, etc, but we there was no time to spend on this...
#   To save build time dependencies are installed early in the dockerfile - now.
#   We ran into issues with uwsgi segfaulting at runtime, issues with the pandas from pip...
#   Some day we should clean this!
RUN conda install -k -c conda-forge libiconv
RUN conda install -k -c conda-forge uwsgi
RUN conda install -k pandas
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org \
                pip pipenv \
                gitpython click flask flask_cors flask-admin sqlalchemy alembic sqlalchemy_utils ujson sklearn scikit-image scikit-learn scikit-optimize


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
# For now, some projects need this to connect to MySQL:
RUN apt-get update -qq && apt-get install --no-install-recommends -y libssl-dev default-libmysqlclient-dev && \
    pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org \
    # https://github.com/PyMySQL/mysqlclient-python
    # https://github.com/ContinuumIO/anaconda-issues/issues/10646
    mysqlclient \
    # We still ran into issues with missing libs.. this is python only
    PyMySQL[rsa]


# nginx as reverse proxy
RUN echo 'deb http://nginx.org/packages/ubuntu/ bionic nginx'     >  /etc/apt/sources.list.d/nginx.list && \
    echo 'deb-src http://nginx.org/packages/ubuntu/ bionic nginx' >> /etc/apt/sources.list.d/nginx.list && \
    apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys ABF5BD827BD9BF62 && \
    # nginx-extra instead of just -full or smaller for WebDav and DAV Ext
    apt-get update -qq && apt-get install -y --no-install-recommends nginx-extras && \
    rm /etc/nginx/sites-enabled/default
EXPOSE 5000 80 443


# PostgreSQL Database
# TODO: compare to the official dockerfile, even replace with it...
#       https://github.com/docker-library/postgres/blob/f19a74ec301fe755b70a822f905c8f537f67bc9a/11/Dockerfile
RUN echo 'deb http://apt.postgresql.org/pub/repos/apt/ bionic-pgdg main' > /etc/apt/sources.list.d/pgdg.list && \
    wget --quiet --no-check-certificate -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add - && \
    apt-get update -qq && apt-get install -y --no-install-recommends postgresql-10 postgresql-contrib-10
    # Allow connections from the outside world - with passwords
RUN echo "listen_addresses = '*'" >> /etc/postgresql/10/main/postgresql.conf && \
    echo "shared_preload_libraries = 'pg_stat_statements'" >> /etc/postgresql/10/main/postgresql.conf && \
    echo 'host    all             all              ::/0                            md5' >> /etc/postgresql/10/main/pg_hba.conf && \
    echo 'host    all             all              0.0.0.0/0                       md5' >> /etc/postgresql/10/main/pg_hba.conf
USER postgres
RUN /etc/init.d/postgresql start && sleep 10 && psql --command "CREATE USER qaboard WITH SUPERUSER PASSWORD 'password';"
USER root
VOLUME  ["/etc/postgresql", "/var/log/postgresql", "/var/lib/postgresql"]
EXPOSE 5432
# Solves issues when using old backups with an undefined uid. The postgres dockerfile fixes the uid in advance...
RUN groupadd -g 107 postgresold
# Python PostgreSQL driver
RUN apt-get install -y --no-install-recommends libpq-dev && \
    pg_config --version && \
    conda install -k -c conda-forge psycopg2


# nodejs
RUN curl -ksL https://deb.nodesource.com/setup_10.x  | \
      sed 's/wget -/wget --no-check-certificate -/g' | \
      sed 's/curl -/curl -k -/g'                     | \
      bash - && \
    apt-get install -y nodejs && \
    npm config set strict-ssl false && \
    npm config set cafile /usr/local/share/ca-certificates/samsung/DLP-TRITON.crt


# Frontend's dependencies
WORKDIR /qaboard/webapp
COPY webapp/package.json webapp/npm-shrinkwrap.json ./
## FIXME ####################################
# ENV NODE_ENV production
# # At the  moment we don't build the app from the container because of frequent issues:
# # - ulimit would kick in (solvable via ENV AFAIK)
# # - network issues would cause always one of the 1000 dependencies to fail fetching
# #   solvable via an internal pip proxy (e.g. artifactory)
# # As a user, you are expected to build it yourself with: 
# # $ cd webapp; npm ci; npm build
# # Then mount the build/ folder to /qaboard/webapp/build
# We used to have things like
# RUN ulimit -n 2000 && npm ci -ddd      # install exactly as in the lock-file (prefered...)
# RUN ulimit -n 2000 && npm install -ddd # install compatible dependencies
# RUN npm run build
COPY . /qaboard/


# Backend API
ENV LANG 'C.UTF-8'
ENV LC_ALL 'C.UTF-8'
WORKDIR /qaboard
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org --editable . ./backend

WORKDIR /qaboard
VOLUME /var/qaboard


# Some of our NFS mounts seem to use squash_root, eg /stage/algo_data
# It forces us to acces them with a regular SIRC user and dance around with sudo
# FIXME: use a different user, possibly use ARG/.env to parametrize
RUN useradd -u 11611 -g 10 arthurf --shell /bin/bash --no-create-home; \
    echo 'arthurf ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers
USER arthurf


# reverse proxy settings
COPY backend/deployment/nginx/mime.types backend/deployment/nginx/nginx.conf /etc/nginx/
COPY backend/deployment/nginx/conf.d/qaboard.conf /etc/nginx/conf.d/

CMD ["/qaboard/backend/deployment/init.sh"]
