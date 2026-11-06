# Built from the repository's root, to include the release notes (website/release-notes/) and the schemas of the batch files (qaboard/schemas/).
# Dockerfile.dockerignore keeps the rest of the repository out of the build context.
#   docker build -f webapp/Dockerfile .
# Stages:
# - deps: node_modules, cached as long as package*.json don't change
# - dev: used by development.yml, serves the code with `npm start` (no production build needed)
# - build: the production bundle
# - production (default): copies the bundle to the /builds volume served by nginx
# node:*-slim: the web app's dependencies have no native code to compile, the full image's toolchain would only be
# more to download in each build
FROM node:24-slim AS deps
WORKDIR /app

# Proxy/cert configuration — no-ops when args are empty (open-source builds)
ARG PROXY_URL=""
ARG CA_CERT_URL=""
ARG NO_PROXY=""

RUN if [ -n "$PROXY_URL" ]; then \
      echo "Acquire::http::Proxy \"$PROXY_URL\";" >> /etc/apt/apt.conf && \
      echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf; \
    fi
ENV HTTP_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL} https_proxy=${PROXY_URL} \
    NO_PROXY=${NO_PROXY}

ARG NODE_TLS_REJECT_UNAUTHORIZED=""
ENV NODE_TLS_REJECT_UNAUTHORIZED=${NODE_TLS_REJECT_UNAUTHORIZED}

# Node has its own CAs: the system's are only needed to trust CA_CERT_URL's (NODE_EXTRA_CA_CERTS, in the build stage)
RUN if [ -n "$CA_CERT_URL" ]; then \
      apt-get update -qq && \
      apt-get install -y --no-install-recommends ca-certificates wget && \
      rm -rf /var/lib/apt/lists/* && \
      wget "$CA_CERT_URL" -P /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi


ENV PATH=/app/node_modules/.bin:$PATH

COPY webapp/package.json webapp/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund || \
    npm ci --no-audit --no-fund || \
    npm ci --no-audit --no-fund


# After `npm ci`: most changes add a release note, they shouldn't install the dependencies again
FROM deps AS sources
# vite bundles them in the app (see releaseNotes.js)
COPY website/release-notes /website/release-notes
# the Available Tests editor checks the batch files with them (see vite.config.js)
COPY qaboard/schemas /qaboard/schemas
COPY webapp/ ./


FROM sources AS dev
CMD ["npm", "start"]


FROM sources AS build
# Sentry's release, e.g. the commit the image is built from (docker-compose.yml passes $QABOARD_VERSION)
ARG QABOARD_VERSION=""
# With a token, the build uploads the source maps to Sentry, then deletes them (see vite.config.js).
# ARGs are only visible during the build, and this stage isn't part of the final image.
ARG SENTRY_AUTH_TOKEN=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ARG SENTRY_URL=""
# The upload trusts the CAs installed with CA_CERT_URL (node warns about a missing file: without it, its own CAs)
RUN if [ -f /etc/ssl/certs/ca-certificates.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; fi && \
    npm run build
# nginx serves the compressed files as they are (gzip_static), instead of compressing them on each request
RUN find build/assets -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.ttf' -o -name '*.json' \) -size +1k \
      -exec gzip -9 --keep {} +


# Only rsync and the bundle: the same small base as the website's image, so they share its layers
FROM alpine:3.21 AS production

# Proxy configuration — needed for apk add rsync. Behind a proxy, use HTTP repos (SIRC's proxy breaks HTTPS/SSL)
ARG PROXY_URL=""
RUN if [ -n "$PROXY_URL" ]; then \
      sed -i 's/https/http/g' /etc/apk/repositories; \
    fi && \
    http_proxy="$PROXY_URL" https_proxy="$PROXY_URL" apk add --no-cache rsync

# When upgrading, we want to enable clients to continue using a previous bundle
# without the application crashing and asking for a refresh
# The strategy is to server the application from a named volume at
VOLUME /builds
# When we start the app, we  copy the bundle over there and ensure new clients
# get the new version.
COPY --from=build /app/build /build
CMD ["rsync", "-r", "build/", "/builds"]
