FROM node:22-alpine
WORKDIR /website

# Proxy/cert configuration — no-ops when args are empty (open-source builds)
ARG PROXY_URL=""
ARG NO_PROXY=""

ENV HTTP_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL} https_proxy=${PROXY_URL} \
    NO_PROXY=${NO_PROXY}

ARG NODE_TLS_REJECT_UNAUTHORIZED=""
ENV NODE_TLS_REJECT_UNAUTHORIZED=${NODE_TLS_REJECT_UNAUTHORIZED}

# Switch apk repos to http when behind proxy
RUN if [ -n "$PROXY_URL" ]; then \
      sed -i 's/https/http/g' /etc/apk/repositories; \
    fi
RUN apk update && apk add --no-cache \
    # needed for node-gyp.. some do it with npm install in one layer
    # https://github.com/mhart/alpine-node/issues/27
    # https://github.com/nodejs/docker-node/issues/384
    # https://github.com/nodejs/docker-node/issues/282
    g++ make python3 \
    rsync \
    && rm -rf /var/cache/apk/*

ENV PATH /app/node_modules/.bin:$PATH
RUN if [ -n "$PROXY_URL" ]; then \
      yarn config set strict-ssl false; \
    fi

# RUN npm install -g yarn

# In the past we had ulimit issues and "ulimit -n 2000 &&"
COPY package.json yarn.lock ./
# we try multiple times to work around network issues...
RUN yarn install --network-timeout 100000 || yarn install --network-timeout 100000 || yarn install --network-timeout 100000 || yarn install --network-timeout 100000
COPY . ./

# On the website we have algolia for the search, but the baseURL (/qaboard) is different than
# when running from the application (/docs). So we don't use algolia for the app...
# RUN yarn run swizzle docusaurus-lunr-search SearchBar
ENV QABOARD_DOCS_FOR_WEBAPP true
ARG QABOARD_URL
ENV QABOARD_URL=$QABOARD_URL
RUN yarn build

# When upgrading, we want to enable clients to continue using a previous bundle
# without the application crashing and asking for a refresh
# The strategy is to server the application from a named volume at
VOLUME /builds
# When we start the app, we  copy the bundle over there and ensure new clients
# get the new version.
CMD ["rsync", "-r", "build/", "/builds"]
