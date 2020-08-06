FROM node:lts
WORKDIR /webapp


ENV PROXY_HOST=webproxy.transchip.com \
    PROXY_PORT=8080 \
    PROXY_PROTOCOL=http
ENV PROXY $PROXY_PROTOCOL://$PROXY_HOST:$PROXY_PORT
ENV HTTP_PROXY=$PROXY \
    http_proxy=$PROXY \
    HTTPS_PROXY=$PROXY \
    https_proxy=$PROXY \
    NO_PROXY='gitlab-srv,gitlab-srv.transchip.com,localhost,aospt-dt'
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

RUN apt update -qq && apt-get install -y --no-install-recommends rsync

ENV PATH /app/node_modules/.bin:$PATH

COPY package.json npm-shrinkwrap.json ./

# In the past we had ulimit issues and "ulimit -n 2000 &&"
RUN npm ci
COPY . ./
ARG REACT_APP_QABOARD_DOCS_ROOT="https://samsung.github.io/qaboard/"
ENV REACT_APP_QABOARD_DOCS_ROOT=$REACT_APP_QABOARD_DOCS_ROOT
RUN npm run-script build

# When upgrading, we want to enable clients to continue using a previous bundle
# without the application crashing and asking for a refresh
# The strategy is to server the application from a named volume at
VOLUME /builds
# When we start the app, we  copy the bundle over there and ensure new clients
# get the new version.
CMD ["rsync", "-r", "build/", "/builds"]
