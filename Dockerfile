FROM ubuntu:bionic
LABEL maintainer="arthurf.flam@samsung.com"

# SIRC proxy configuration
# if you run into network issues, build the image somewhere else :_)
ENV PROXY_HOST=dlp2-wcg01 \
        PROXY_PORT=8080 \
        PROXY_PROTOCOL=http
ENV PROXY $PROXY_PROTOCOL://$PROXY_HOST:$PROXY_PORT

RUN \
    echo "Acquire::http::Proxy \"$PROXY\";" >> /etc/apt/apt.conf; \
    echo "Acquire::https::Proxy \"$PROXY\";" >> /etc/apt/apt.conf; \
    echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf; \
    echo 'Acquire::http::Verify-Peer "false";' >> /etc/apt/apt.conf; \
    echo "[http]\nsslverify = false\n# proxy = $PROXY" >> /root/.gitconfig
ENV HTTP_PROXY=$PROXY \
    http_proxy=$PROXY \
    HTTPS_PROXY=$PROXY \
    https_proxy=$PROXY \
    NO_PROXY='gitlab-srv,gitlab-srv.transchip.com,localhost,aospt-dt'

COPY deployment/DLP-TRITON.crt /usr/local/share/ca-certificates/samsung/DLP-TRITON.crt
COPY deployment/sirc-ca.cer /usr/local/share/ca-certificates/samsung/sirc-ca.cer


ENV DEBIAN_FRONTEND noninteractive
RUN apt-get update && \
    echo exit 0 > /usr/sbin/policy-rc.d && \
    # Essential utilities
    apt-get install -y wget curl sudo \
                       software-properties-common build-essential \
                       libc6-dev \
                       python-dev && \
                       # libgl1-mesa-glx \
    # Useful utilities when debugging the container
    apt-get install -y zsh htop tree less nano


RUN update-ca-certificates && \
    yes | dpkg-reconfigure ca-certificates --



    # If we didn't have proxy issues we would just
    # add-apt-repository -y ppa:git-core/ppa
RUN echo "deb http://ppa.launchpad.net/git-core/ppa/ubuntu trusty main" >> /etc/apt/sources.list && \
    echo "deb-src http://ppa.launchpad.net/git-core/ppa/ubuntu trusty main" >> /etc/apt/sources.list && \
    apt-key adv --keyserver-options http-proxy=$HTTP_PROXY --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys A1715D88E1DF1F24 && \
    apt-get update && apt-get install -y git && \
    git config --global http.proxy $PROXY


# Python environment
# RUN wget --no-check-certificate https://repo.continuum.io/archive/Anaconda3-5.3.1-Linux-x86_64.sh && \
#     bash Anaconda3-5.3.1-Linux-x86_64.sh -f -b -p /opt/anaconda3
RUN wget --no-check-certificate https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh && \
    bash Miniconda3-latest-Linux-x86_64.sh -f -b -p /opt/anaconda3
ENV PATH /opt/anaconda3/bin:${PATH}
# ideally we should freeze dependencies using pip/pipenv, but to avoid spending time on this...
#RUN wget --no-check-certificate https://projects.unbit.it/downloads/uwsgi-2.0.18.tar.gz && \
#    tar xvf uwsgi-2.0.18.tar.gz
#RUN cd uwsgi-2.0.18 && \
#    export CFLAGS="$CFLAGS -fPIC" && \
#    make PROFILE=nolang PYTHON=python3.7 && \
#    python uwsgiconfig.py --build --verbose
#RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.org projects.unbit.it \
#    https://projects.unbit.it/downloads/uwsgi-lts.tar.gz
# RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org \
#     pandas
RUN conda install -k -c conda-forge libiconv
RUN conda install -k -c conda-forge uwsgi
# RUN conda install -k -c conda-forge/label/gcc7 uwsgi
RUN conda install -k pandas
# RUN conda update -n base -c defaults conda
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org \
                pip pipenv \
                gitpython click flask flask_cors sqlalchemy alembic sqlalchemy_utils flask-admin ujson sklearn scikit-image scikit-learn click && \
    pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org 'git+http://gitlab-srv/arthurf/scikit-optimize'

# Some projects need this (TODO: a cleaner way to request specific packages...)
# https://github.com/PyMySQL/mysqlclient-python
# https://github.com/ContinuumIO/anaconda-issues/issues/10646
RUN apt-get -y install libssl-dev default-libmysqlclient-dev && \
    pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org mysqlclient
# We still run into issues with missing libs.. this is python only
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org PyMySQL[rsa]


# nginx as reverse proxy
RUN echo 'deb http://nginx.org/packages/ubuntu/ bionic nginx'     >  /etc/apt/sources.list.d/nginx.list && \
    echo 'deb-src http://nginx.org/packages/ubuntu/ bionic nginx' >> /etc/apt/sources.list.d/nginx.list && \
    apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --keyserver-options http-proxy=$PROXY --recv-keys ABF5BD827BD9BF62 && \
    # nginx-extra instead of just -full or smaller for WebDav and DAV Ext
    apt-get update && apt-get install -y nginx-extras && \
    rm /etc/nginx/sites-enabled/default
COPY deployment/nginx/mime.types deployment/nginx/nginx.conf /etc/nginx/
COPY deployment/nginx/conf.d/qaboard.conf /etc/nginx/conf.d/
EXPOSE 5000 80 443


# PostgreSQL database
# TODO: compare to the official dockerfile, even replace with it...
#       https://github.com/docker-library/postgres/blob/f19a74ec301fe755b70a822f905c8f537f67bc9a/11/Dockerfile
RUN echo 'deb http://apt.postgresql.org/pub/repos/apt/ bionic-pgdg main' > /etc/apt/sources.list.d/pgdg.list && \
    wget --quiet --no-check-certificate -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add - && \
    apt-get update; apt-get install -y postgresql-10 postgresql-contrib-10
    # Allow connections from the outside world - with passwords
RUN echo "listen_addresses = '*'" >> /etc/postgresql/10/main/postgresql.conf && \
    echo "shared_preload_libraries = 'pg_stat_statements'" >> /etc/postgresql/10/main/postgresql.conf && \
    echo 'host    all             all              ::/0                            md5' >> /etc/postgresql/10/main/pg_hba.conf && \
    echo 'host    all             all              0.0.0.0/0                       md5' >> /etc/postgresql/10/main/pg_hba.conf
USER postgres
RUN /etc/init.d/postgresql start && sleep 10 && psql --command "CREATE USER ci WITH SUPERUSER PASSWORD 'dvsdvs';"
USER root
VOLUME  ["/etc/postgresql", "/var/log/postgresql", "/var/lib/postgresql"]
EXPOSE 5432
# solves issues using old backups
RUN groupadd -g 107 postgresold
#   group­mod -g 107 postgres


RUN apt-get install -y libpq-dev && \
    pg_config --version && \
    conda install -k -c conda-forge psycopg2
    # pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org --no-binary :all: psycopg2


# nodejs
RUN curl -ksL https://deb.nodesource.com/setup_10.x  | \
      sed 's/wget -/wget --no-check-certificate -/g' | \
      sed 's/curl -/curl -k -/g'                     | \
      bash - && \
    apt-get install -y nodejs && \
    npm config set strict-ssl false && \
    npm config set cafile /usr/local/share/ca-certificates/samsung/DLP-TRITON.crt && \
    npm config set https-proxy $HTTP_PROXY && \
    npm config set http-proxy  $http_proxy


# Frontend's dependencies
WORKDIR /slamvizapp/slamvizapp-webapp
COPY /slamvizapp-webapp/package.json /slamvizapp-webapp/package-lock.json ./
# ENV NODE_ENV production
## FIXME ####################################
# At the  moment we don't build the app from the container (ulimit/network issues)
# Before, you need to
# $ cd slamvizapp-webapp; npm ci; npm build
# RUN ulimit -n 2000 && npm install -ddd
# RUN ulimit -n 2000 && npm ci -ddd
COPY . /slamvizapp/
# RUN npm run build
##############################################


# Backend API
ENV LANG 'C.UTF-8'
ENV LC_ALL 'C.UTF-8'
WORKDIR /slamvizapp
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org --editable .[server]
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org 'git+http://gitlab-srv/common-infrastructure/qatools' && \
    pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org 'git+http://gitlab-srv/cde/cde-python' && \
    echo cache-busting-000


VOLUME /var/slamvizapp


# Some of our NFS mounts seem to use squash_root
# eg /stage/algo_data
# this forces us to acces them with a regular SIRC user
# and dance around with sudo
RUN useradd -u 11611 -g 10 arthurf --shell /bin/bash --no-create-home; \
    echo 'arthurf ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers
USER arthurf

CMD ["/slamvizapp/deployment/init.sh"]
