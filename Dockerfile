FROM ubuntu:trusty
LABEL maintainer="arthurf.flam@samsung.com"

# SIRC proxy configuration
# if you run into network issues, build the image somewhere else :_)
RUN echo 'Acquire::http::Proxy "http://dlp-wcg01:8080";' >> /etc/apt/apt.conf
RUN echo 'Acquire::https::Proxy "http://dlp-wcg01:8080";' >> /etc/apt/apt.conf
RUN echo '[http]\nsslverify = false\n# proxy = http://dlp-wcg01:8080' >> /root/.gitconfig
ENV HTTP_PROXY 'http://dlp-wcg01:8080'
ENV http_proxy 'http://dlp-wcg01:8080'
ENV HTTPS_PROXY 'http://dlp-wcg01:8080'
ENV https_proxy 'http://dlp-wcg01:8080'
ENV NO_PROXY 'gitlab-srv'

RUN apt-get update
RUN apt-get install -y git wget
RUN git config --global http.proxy http://dlp-wcg01:8080

# Useful utilities when debugging the container
RUN apt-get install -y zsh htop tree less nano

# Python - anaconda distribution
RUN wget --no-check-certificate https://repo.continuum.io/archive/Anaconda3-5.0.1-Linux-x86_64.sh
RUN bash Anaconda3-5.0.1-Linux-x86_64.sh -f -b -p /opt/anaconda3
ENV PATH /opt/anaconda3/bin:${PATH}
RUN conda install pandas
RUN pip install pipenv

# uwsgi and matplotlib dependencies
RUN apt-get update && apt-get install -y build-essential libgl1-mesa-glx

# postgresql database
RUN echo 'deb http://apt.postgresql.org/pub/repos/apt/ trusty-pgdg main' > /etc/apt/sources.list.d/pgdg.list
RUN wget --quiet --no-check-certificate -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add -
RUN apt-get update; apt-get install -y postgresql-9.6
# allow connections from the outside world - with passwords
RUN echo "listen_addresses = '*'" >> /etc/postgresql/9.6/main/postgresql.conf
RUN echo 'host    all             all              ::/0                            md5' >> /etc/postgresql/9.6/main/pg_hba.conf
RUN echo 'host    all             all              0.0.0.0/0                       md5' >> /etc/postgresql/9.6/main/pg_hba.conf
USER postgres
RUN /etc/init.d/postgresql start && psql --command "CREATE USER ci WITH SUPERUSER PASSWORD 'dvsdvs';"
VOLUME  ["/etc/postgresql", "/var/log/postgresql", "/var/lib/postgresql"]
# && createdb -O docker docker
EXPOSE 5432
# CMD ["/usr/lib/postgresql/9.6/bin/postgres", "-D", "/var/lib/postgresql/9.6/main", "-c", "config_file=/etc/postgresql/9.6/main/postgresql.conf"]
# RUN sudo -postgres psql -U postgres

# nginx as reverse proxy
USER root
RUN echo 'deb http://nginx.org/packages/ubuntu/ trusty nginx'     >  /etc/apt/sources.list.d/nginx.list
RUN echo 'deb-src http://nginx.org/packages/ubuntu/ trusty nginx' >> /etc/apt/sources.list.d/nginx.list
RUN apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys ABF5BD827BD9BF62
RUN apt-get update && apt-get install -y nginx

# more certificate stuff
COPY deployment/DLP-TRITON.crt /usr/local/share/ca-certificates/samsung/DLP-TRITON.crt
RUN update-ca-certificates
# COPY deployment/DLP-TRITON.crt /etc/ssl/certs/samsung/DLP-TRITON.crt
# RUN cat /etc/ssl/certs/samsung/DLP-TRITON.crt >> /etc/ssl/certs/ca-certificates.crt
# RUN yes | dpkg-reconfigure ca-certificates --

# nodejs
RUN curl -ksL https://deb.nodesource.com/setup_9.x | bash -
RUN apt-get install -y nodejs

# yarn
RUN curl -k -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add -
RUN echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list
RUN apt-get install apt-transport-https
RUN apt-get update && apt-get install -y yarn
RUN yarn config set strict-ssl false
RUN yarn config set cafile /usr/local/share/ca-certificates/samsung/DLP-TRITON.crt
RUN yarn config set https-proxy $HTTP_PROXY
RUN yarn config set http-proxy  $HTTP_PROXY

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
RUN yarn install --pure-lockfile
COPY . /slamvizapp/
RUN yarn build

# our API
WORKDIR /slamvizapp
RUN pip install --editable .
ENV LANG 'C.UTF-8'
ENV LC_ALL 'C.UTF-8'

VOLUME /var/slamvizapp

# nginx config
COPY deployment/nginx /etc/nginx

EXPOSE 5000
EXPOSE 80
EXPOSE 443

CMD deployment/init.sh
