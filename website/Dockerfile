# Built from the repository's root, so the docs can show repository files (<RepoFile path="...">, e.g.
# charts/qaboard/kind.yaml) and check the shot ids (docs-media/shots.yaml). Dockerfile.dockerignore keeps the rest of
# the repository out of the build context.
#   docker build -f website/Dockerfile .
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
    autoconf automake libtool build-base \
    && rm -rf /var/cache/apk/*

ENV PATH /app/node_modules/.bin:$PATH
RUN if [ -n "$PROXY_URL" ]; then \
      yarn config set strict-ssl false; \
    fi

# RUN npm install -g yarn

# In the past we had ulimit issues and "ulimit -n 2000 &&"
COPY website/package.json website/yarn.lock ./
# we try multiple times to work around network issues...
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile --network-timeout 100000 || \
    yarn install --frozen-lockfile --network-timeout 100000 || \
    yarn install --frozen-lockfile --network-timeout 100000
# The files outside website/ keep their place relative to it (/website/../charts/...)
COPY charts/ /charts/
COPY deployments/quickstart/compose.yml /deployments/quickstart/compose.yml
COPY examples/ /examples/
COPY docs-media/shots.yaml /docs-media/shots.yaml
COPY qaboard/schemas/ /qaboard/schemas/
COPY website/ ./

# On the website we have algolia for the search, but the baseURL (/qaboard) is different than
# when running from the application (/docs). So we don't use algolia for the app...
# RUN yarn run swizzle docusaurus-lunr-search SearchBar
ENV QABOARD_DOCS_FOR_WEBAPP true
ARG QABOARD_URL
ENV QABOARD_URL=$QABOARD_URL
# Adds the docs for the users of your site, from site-docs/$QABOARD_SITE/ (e.g. sirc)
ARG QABOARD_SITE=""
ENV QABOARD_SITE=$QABOARD_SITE
# The build downloads the docs' screenshots and clips (docs-media/README.md): without network access, set
# QABOARD_MEDIA=placeholder, or QABOARD_MEDIA_BASE_URL to a mirror of the media bucket. When a proxy blocks some files
# (e.g. videos), QABOARD_MEDIA_MISSING=remote has readers load those shots from the bucket (or the mirror), or
# QABOARD_MEDIA_MISSING=placeholder renders them as placeholders, instead of failing the build
ARG QABOARD_MEDIA=""
ARG QABOARD_MEDIA_BASE_URL=""
ARG QABOARD_MEDIA_MISSING=""
ENV QABOARD_MEDIA=$QABOARD_MEDIA QABOARD_MEDIA_BASE_URL=$QABOARD_MEDIA_BASE_URL QABOARD_MEDIA_MISSING=$QABOARD_MEDIA_MISSING
RUN yarn build

# When upgrading, we want to enable clients to continue using a previous bundle
# without the application crashing and asking for a refresh
# The strategy is to server the application from a named volume at
VOLUME /builds
# When we start the app, we  copy the bundle over there and ensure new clients
# get the new version.
CMD ["rsync", "-r", "build/", "/builds"]
