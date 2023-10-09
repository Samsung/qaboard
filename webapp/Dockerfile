FROM node:lts as dev
WORKDIR /app

ENV PROXY_HOST=webproxy \
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
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

RUN apt-get update -qq && \
    apt-get install ca-certificates wget -y && \
    wget http://itweb/downloads/sirc-ca.crt -P /usr/local/share/ca-certificates/ && \
    update-ca-certificates


ENV PATH /app/node_modules/.bin:$PATH

COPY package.json package-lock.json ./

# https://docs.npmjs.com/cli/v7/using-npm/config
## RUN npm config set fetch-retry-maxtimeout 60000
# we used this config until npm started to say it's not valid (?)
# RUN npm config set fetch-retries 10\
#     npm config set fetch-timeout 10000# In the past we had ulimit issues and "ulimit -n 2000 &&"
RUN npm ci || npm ci || npm ci

COPY . ./
ARG REACT_APP_QABOARD_DOCS_ROOT="https://samsung.github.io/qaboard/"
ENV REACT_APP_QABOARD_DOCS_ROOT=$REACT_APP_QABOARD_DOCS_ROOT
ARG REACT_APP_SENTRY_DSN
ENV REACT_APP_SENTRY_DSN=$REACT_APP_SENTRY_DSN
ARG REACT_APP_QABOARD_LOGIN_TYPE
ENV REACT_APP_QABOARD_LOGIN_TYPE=$REACT_APP_QABOARD_LOGIN_TYPE
ARG REACT_APP_QABOARD_LOGIN_REQUIRED
ENV REACT_APP_QABOARD_LOGIN_REQUIRED=$REACT_APP_QABOARD_LOGIN_REQUIRED

RUN npm run-script build
RUN sentry-cli sourcemaps inject build && \
    sentry-cli sourcemaps upload build
CMD ["npm", "start"]


FROM debian:bullseye as production
COPY --from=dev /app/build /build

ENV PROXY_HOST=webproxy \
    PROXY_PORT=8080 \
    PROXY_PROTOCOL=http
ENV PROXY $PROXY_PROTOCOL://$PROXY_HOST:$PROXY_PORT
ENV HTTP_PROXY=$PROXY \
    http_proxy=$PROXY \
    HTTPS_PROXY=$PROXY \
    https_proxy=$PROXY \
    NO_PROXY='localhost'
RUN echo "Acquire::http::Proxy \"$PROXY\";" >> /etc/apt/apt.conf; \
    echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf; \
    echo "[http]\nsslverify = false\n# proxy = $PROXY" >> /root/.gitconfig
RUN apt-get update -qq && apt-get install -y --no-install-recommends rsync
# RUN apk update --allow-untrusted && apk add rsync --allow-untrusted

# When upgrading, we want to enable clients to continue using a previous bundle
# without the application crashing and asking for a refresh
# The strategy is to server the application from a named volume at
VOLUME /builds
# When we start the app, we  copy the bundle over there and ensure new clients
# get the new version.
CMD ["rsync", "-r", "build/", "/builds"]
