FROM node:lts
WORKDIR /website

RUN apt-get update -qq && apt-get install -y --no-install-recommends rsync

ENV PATH /app/node_modules/.bin:$PATH
RUN yarn config set strict-ssl false

# RUN npm install -g yarn

# In the past we had ulimit issues and "ulimit -n 2000 &&"
COPY package.json yarn.lock ./
RUN yarn install
COPY . ./

# On the website we have algolia for the search, but the baseURL (/qaboard) is different than
# when running from the application (/docs). So we don't use algolia for the app...
RUN yarn run swizzle docusaurus-lunr-search SearchBar
RUN yarn build

# When upgrading, we want to enable clients to continue using a previous bundle
# without the application crashing and asking for a refresh
# The strategy is to server the application from a named volume at
VOLUME /builds
# When we start the app, we  copy the bundle over there and ensure new clients
# get the new version.
CMD ["rsync", "-r", "build/", "/builds"]
