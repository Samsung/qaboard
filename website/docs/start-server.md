---
id: start-server
title: Starting a QA-Board server
sidebar_label: Starting the Server
---

The `qa` executable will need to send updates to a central server, that tracks and displays results.

> Please [fill issues](https://github.com/Samsung/qaboard/issues), [chat](https://spectrum.chat/qaboard) or <a href="mailto:arthur.flam@samsung.com">send an email</a> to maintainers if you run into issues. 

:::note
We're considering offering a hosted solution to help users get started. If your're interested, contact the <a href="mailto:arthur@fl.am">maintainers</a>. 
:::

## Dependencies
1. [`docker`](https://docs.docker.com/engine/install/) and [`docker-compose`](https://docs.docker.com/compose/install/).
2. Get the code with:
```bash
git@github.com:Samsung/qaboard.git
cd qaboard
```

## Starting the server
To start or restart the QA-Board server:
```bash
docker-compose up
#=> the application is live at localhost:8080

# To have the server start in the background and restart itself 
docker-compose -f docker-compose.yml -f production.yml up -d
```


## Environment variables
> You can edit an `.env` file to set them, `A=B` on each line, or add `environment:` keys to `backend` service in one of the `docker-compose.yml`

| ENV Variable           | Default | Usage                                            |
-------------------------|-------- |--------------------------------------------------|
| `GITLAB_ACCESS_TOKEN`  | _none_  | **Required** *for now*, to get info on git repos |
| `QABOARD_PORT_HTTP`    | 80      | Port mapped to the app on the host               |
| `QABOARD_DB_HOST`      | db      | Connect the backend to a non-default database host (e.g. instead of dev'ing with prod dumps, connect directly to it) |
| `QABOARD_DB_PORT`      | 5432    | Connect to a non-default database port           |
| `JENKINS_USER_NAME`    | _none_  | Used to [trigger jenkins jobs](/docs/triggering-third-party-tool) ([how-to-get-it?](/docs/triggering-third-party-tools#example-jenkins-integration-via-webhooks))               |
| `JENKINS_USER_TOKEN`   | _none_  |                                                  |
| `JENKINS_USER_CRUMB`   | _none_  |                                                  |
| `CANTALOUPE_MEM_START` | 1g      | Starting memory for the image server             |
| `CANTALOUPE_MEM_MAX`   | 2g      | Max memory for the image server                  |
| `UWSGI_PROCESSS`       | 1       | default: 1g                                      |


## Development
If you are doing development, you can interact with the individual services with e.g.

```bash
# development.yml adds ENV variables to be more verbose, tweak it!
docker-compose -f docker-compose.yml -f development.yml -f sirc.yml build backend
docker-compose -f docker-compose.yml -f development.yml -f sirc.yml up backend

# you can get a shell on the various services:
docker-compose -f docker-compose.yml -f development.yml -f sirc.yml run proxy /bin/ash
# or with the docker-compose conventions, if the service is up:
docker exec -it qaboard_proxy_1 bash

# This said, to dev on the frontend, it's best to
#   cd webapp && npm install && npm start
#   and edit webapp/src/setupProxy.js to have your dev version talk to either the prod/dev backend
```

> Refer to the examples in *[docker-compose.yml](docker-compose.yml)* or to the `docker-compose` docs.

## SSL / hosting behind a reverse proxy
What we do is directly change the `nginx` confix:


```nginx title="services/nginx/conf.d/qaboard.conf"
server {
  # ...
  listen 443 ssl;
  ssl_certificate_key /ssl/cert.key;
  ssl_certificate /ssl/cert.pem;
  # ...
}
```

And mount keys with:

```yaml title="docker-compose.yml"
proxy:
  volumes:
  - "somewhere/cert.key:/ssl/cert.key"
  - "somewhere/cert.pem:/ssl/cert.pem"
```

If you want to use your own reverse proxy, with `nginx` for instance you can set `QABOARD_PORT_HTTP=8080` and: 

```nginx
server {
  listen 80;
  server_name default_server;
  location / {
    proxy_pass http://localhost:8080/;
  }
}
```

