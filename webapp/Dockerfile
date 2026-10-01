# Stages:
# - deps: node_modules, cached as long as package*.json don't change
# - dev: used by development.yml, serves the code with `npm start` (no production build needed)
# - build: the production bundle
# - production (default): copies the bundle to the /builds volume served by nginx
FROM node:20 AS deps
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

RUN apt-get update -qq && \
    apt-get install -y ca-certificates wget && \
    if [ -n "$CA_CERT_URL" ]; then \
      wget "$CA_CERT_URL" -P /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi


ENV PATH /app/node_modules/.bin:$PATH

COPY package.json package-lock.json ./

# https://docs.npmjs.com/cli/v7/using-npm/config
## RUN npm config set fetch-retry-maxtimeout 60000
# we used this config until npm started to say it's not valid (?)
# RUN npm config set fetch-retries 10\
#     npm config set fetch-timeout 10000# In the past we had ulimit issues and "ulimit -n 2000 &&"
# too many peer deps issues
# RUN npm ci || npm ci || npm ci
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps --no-audit --no-fund || \
    npm install --legacy-peer-deps --no-audit --no-fund || \
    npm install --legacy-peer-deps --no-audit --no-fund


FROM deps AS dev
COPY . ./
CMD ["npm", "start"]


FROM deps AS build
COPY . ./

ARG SENTRY_ORG
ENV SENTRY_ORG=$SENTRY_ORG
ARG SENTRY_PROJECT
ENV SENTRY_PROJECT=$SENTRY_PROJECT
ARG SENTRY_AUTH_TOKEN
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN

RUN npm run-script build
RUN if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      sentry-cli sourcemaps inject build && \
      sentry-cli sourcemaps upload build; \
    fi


FROM debian:bookworm-slim AS production
COPY --from=build /app/build /build

# Proxy/cert configuration — needed for apt-get install rsync
ARG PROXY_URL=""
ARG NO_PROXY=""

RUN if [ -n "$PROXY_URL" ]; then \
      echo "Acquire::http::Proxy \"$PROXY_URL\";" >> /etc/apt/apt.conf && \
      echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf; \
    fi
ENV HTTP_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL} https_proxy=${PROXY_URL} \
    NO_PROXY=${NO_PROXY}

RUN apt-get update -qq && apt-get install -y --no-install-recommends rsync

# Clear proxy env so it doesn't leak into runtime
ENV HTTP_PROXY="" http_proxy="" \
    HTTPS_PROXY="" https_proxy="" \
    NO_PROXY=""

# When upgrading, we want to enable clients to continue using a previous bundle
# without the application crashing and asking for a refresh
# The strategy is to server the application from a named volume at
VOLUME /builds
# When we start the app, we  copy the bundle over there and ensure new clients
# get the new version.
CMD ["rsync", "-r", "build/", "/builds"]
