FROM ubuntu:trusty
LABEL maintainer="arthurf.flam@samsung.com"

# SIRC proxy configuration
# if you run into network issues, build the image somewhere else :_)
ENV PROXY_HOST=dlp2-wcg01 \
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

RUN apt-get update && \
    apt-get install -y git wget && \
    git config --global http.proxy $PROXY


# Essential utilities
RUN apt-get update && apt-get install -y build-essential libgl1-mesa-glx

# Useful utilities when debugging the container
RUN apt-get install -y zsh htop tree less nano

# Python - anaconda distribution
RUN wget --no-check-certificate https://repo.continuum.io/archive/Anaconda3-5.0.1-Linux-x86_64.sh
RUN bash Anaconda3-5.0.1-Linux-x86_64.sh -f -b -p /opt/anaconda3
ENV PATH /opt/anaconda3/bin:${PATH}
# ideally we should freeze dependencies using pip/pipenv, but to avoid spending time on this...
RUN conda install -k pandas
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org pipenv gitpython click flask flask_cors sqlalchemy alembic psycopg2-binary sqlalchemy_utils flask-admin ujson sklearn scikit-learn uwsgi
RUn pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org 'git+http://gitlab-srv/arthurf/scikit-optimize'

# uwsgi and matplotlib dependencies

# postgresql database
RUN echo 'deb http://apt.postgresql.org/pub/repos/apt/ trusty-pgdg main' > /etc/apt/sources.list.d/pgdg.list
RUN wget --quiet --no-check-certificate -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add -
RUN apt-get update; apt-get install -y postgresql-9.6 postgresql-contrib-9.6
# allow connections from the outside world - with passwords
RUN echo "listen_addresses = '*'" >> /etc/postgresql/9.6/main/postgresql.conf && \
    echo "shared_preload_libraries = 'pg_stat_statements'" >> /etc/postgresql/9.6/main/postgresql.conf && \
    echo 'host    all             all              ::/0                            md5' >> /etc/postgresql/9.6/main/pg_hba.conf && \
    echo 'host    all             all              0.0.0.0/0                       md5' >> /etc/postgresql/9.6/main/pg_hba.conf
USER postgres
RUN /etc/init.d/postgresql start && psql --command "CREATE USER ci WITH SUPERUSER PASSWORD 'dvsdvs';"
VOLUME  ["/etc/postgresql", "/var/log/postgresql", "/var/lib/postgresql"]
# && createdb -O docker docker
EXPOSE 5432
# CMD ["/usr/lib/postgresql/9.6/bin/postgres", "-D", "/var/lib/postgresql/9.6/main", "-c", "config_file=/etc/postgresql/9.6/main/postgresql.conf"]
# RUN sudo -postgres psql -U postgres

# nginx as reverse proxy
USER root
RUN echo 'deb http://nginx.org/packages/ubuntu/ trusty nginx'     >  /etc/apt/sources.list.d/nginx.list && \
    echo 'deb-src http://nginx.org/packages/ubuntu/ trusty nginx' >> /etc/apt/sources.list.d/nginx.list && \
    apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys ABF5BD827BD9BF62 && \
    apt-get update && apt-get install -y nginx

# more certificate stuff
COPY deployment/DLP-TRITON.crt /usr/local/share/ca-certificates/samsung/DLP-TRITON.crt
RUN update-ca-certificates
# COPY deployment/DLP-TRITON.crt /etc/ssl/certs/samsung/DLP-TRITON.crt
# RUN cat /etc/ssl/certs/samsung/DLP-TRITON.crt >> /etc/ssl/certs/ca-certificates.crt
# RUN yes | dpkg-reconfigure ca-certificates --

# nodejs
RUN echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf && \
    echo 'Acquire::https::Verify-Host "false";' >> /etc/apt/apt.conf && \
    curl -ksL https://deb.nodesource.com/setup_10.x | sed 's/wget -/wget --no-check-certificate -/g' | bash - && \
    apt-get install -y nodejs

# yarn
RUN curl -k -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add - && \
    echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list && \
    apt-get install apt-transport-https && \
    apt-get update && \
    apt-get install -y yarn && \
    yarn config set strict-ssl false && \
    yarn config set cafile /usr/local/share/ca-certificates/samsung/DLP-TRITON.crt && \
    yarn config set https-proxy $HTTP_PROXY && \
    yarn config set http-proxy  $HTTP_PROXY \
    npm config set strict-ssl false && \
    npm config set cafile /usr/local/share/ca-certificates/samsung/DLP-TRITON.crt && \
    npm config set https-proxy $HTTP_PROXY && \
    npm config set http-proxy  $http_proxy

# our API's dependencies
WORKDIR /slamvizapp
COPY ./requirements-freeze.txt ./
RUN pip install --upgrade pip
# we just want to prime the cache..
# RUN cat requirements-freeze.txt | xargs -n 1 pip install
# RUN pip install -U git+https://github.com/google/python-adb
# RUN pip install -r requirements-freeze.txt || true
# RUN conda install --yes requirements-freeze.txt || true

# our frontend's dependencies
WORKDIR /slamvizapp/slamvizapp-webapp
COPY /slamvizapp-webapp/package.json /slamvizapp-webapp/yarn.lock ./
ENV NODE_ENV production
# RUN yarn global add grunt-cli # for building openseadragon from source
RUN npm install -g grunt-cli

RUN npm ci
# RUN yarn install --frozen-lockfile
# yarn doesn't run build scripts when installing purely lockfiles...
# https://github.com/yarnpkg/yarn/issues/1671
# RUN cd node_modules/openseadragon && yarn add grunt-cli && yarn add grunt && ls -alh && yarn install && yarn run prepare
# RUN yarn check --verify-tree

# RUN cat node_modules/openseadragon/package.json
RUN ls -alh node_modules/openseadragon
RUN ls -alh node_modules/openseadragon/build/openseadragon
COPY . /slamvizapp/
RUN yarn build

# our API
WORKDIR /slamvizapp
# RUN pip install --editable . # proxy madness
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org 'git+http://gitlab-srv/common-infrastructure/qatools'
RUN pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org --editable .[server]
ENV LANG 'C.UTF-8'
ENV LC_ALL 'C.UTF-8'

VOLUME /var/slamvizapp

# nginx config
COPY deployment/nginx /etc/nginx
EXPOSE 5000 80 443

# some of our NFS mounts seem to use squash_root
# eg /stage/algo_data
# this forces us to acces them with a regular SIRC user
# and dance around with sudo
RUN useradd -u 11611 -g 10 arthurf --shell /bin/bash --no-create-home; \
    echo 'arthurf ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers
USER arthurf

CMD ["/slamvizapp/deployment/init.sh"]
