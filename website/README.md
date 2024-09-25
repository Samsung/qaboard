# QA-Board's Website and Docs
This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

### Usage with docker
To open a shell in the docker environment: 
```bash
# to just build:
# docker compose -f docker-compose.yml -f development.yml -f sirc.yml build website
docker compose -f docker-compose.yml -f development.yml -f sirc.yml run -p6051:3000 --entrypoint /bin/sh website
```

Now you can do all the commands of the regular setup:

```
/website $ npm run docusaurus start -- --host 0.0.0.0 --no-open --poll
```

### Installation
To install:

```bash
yarn
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server:

```bash
$ yarn start
#=> without docker, listens to http://localhost:3000/qaboard/docs
#=> with dockeer    listens to http://localhost:6051/docs
QABOARD_DOCS_FOR_WEBAPP

# To host the docs at /docs not /qaboard/docs:
export QABOARD_DOCS_FOR_WEBAPP=1

# if you do not use docker, where it's preconfigured,
# when doing dev you often will want to use
NODE_TLS_REJECT_UNAUTHORIZED=0 CHOKIDAR_USEPOLLING=true DANGEROUSLY_DISABLE_HOST_CHECK=true HOST=0.0.0.0 PORT=3001 yarn start --host 0.0.0.0
```


### Command commands
#### Build

```
$ yarn build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

#### Deployment

Using SSH:

```
$ USE_SSH=true yarn deploy
```

Not using SSH:

```
$ GIT_USER=<Your GitHub username> yarn deploy
```

If you are using GitHub pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
