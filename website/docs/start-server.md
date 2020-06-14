---
id: start-server
title: Starting a QA-Board server
sidebar_label: Starting the Server
---

:::caution
**For now** QA-Board expects that you use Gitlab. [We're working on removing that requirement](https://github.com/Samsung/qaboard/issues/1).  
:::


The `qa` executable will need to send updates to a central server, that tracks and displays results.

> Please [fill issues](https://github.com/Samsung/qaboard/issues), [chat](https://spectrum.chat/qaboard) or <a href="mailto:arthur.flam@samsung.com">send an email</a> to maintainers if you run into issues. 


## Starting the server
1. You need [`docker`](https://docs.docker.com/engine/install/), [`docker-compose`](https://docs.docker.com/compose/install/) and `git`.
2. *(optionnal)* If you have a github.com account, [being `docker login`'ed](https://help.github.com/en/packages/using-github-packages-with-your-projects-ecosystem/configuring-docker-for-use-with-github-packages#authenticating-with-a-personal-access-token) let's you pull pre-built images.
2. To start the QA-Board server:
```bash
git clone git@github.com:Samsung/qaboard.git
cd qaboard
docker-compose up -d
#=> the application is live at localhost:8080
```


To have the server restart automatically:

```bash
docker-compose -f docker-compose.yml -f production.yml up -d
```

:::note
We're considering offering a hosted solution to help users get started. If your're interested, contact the <a href="mailto:arthur.flam@gmail.com">maintainers</a>.
:::

If you want to install from a helm chart for Kubernetes, a CloudFormation configuration or Terraform, <a href="mailto:arthur.flam@gmail.com">get in touch</a>.


## Environment variables
> To configure your installation, you can edit an `.env` file (`A=B` on each line). You can also edit one of the `docker-compose` files (`docker-compose.yml`, `development.yml`, `production.yml`...): add `environment:` keys to `backend` service.

| ENV Variable           | Default | Usage                                            |
-------------------------|-------- |--------------------------------------------------|
| `GITLAB_ACCESS_TOKEN`  | _none_  | **Required** *for now*, to get info on git repos. Get it at https://$gitlab-server/profile/personal_access_tokens |
| `QABOARD_PORT_HTTP`    | 80      | Port mapped to the app on the host               |
| `QABOARD_DB_HOST`      | db      | Connect the backend to a non-default database host (e.g. instead of dev'ing with prod dumps, connect directly to it) |
| `QABOARD_DB_PORT`      | 5432    | Connect to a non-default database port           |
| `JENKINS_USER_NAME`    | _none_  | Used to [trigger jenkins jobs](/docs/triggering-third-party-tool) ([how-to-get-it?](/docs/triggering-third-party-tools#example-jenkins-integration-via-webhooks))               |
| `JENKINS_USER_TOKEN`   | _none_  |                                                  |
| `JENKINS_USER_CRUMB`   | _none_  |                                                  |
| `CANTALOUPE_MEM_START` | 1g      | Starting memory for the image server             |
| `CANTALOUPE_MEM_MAX`   | 2g      | Max memory for the image server                  |
| `UWSGI_PROCESSS`       | 1       | default: 1g                                      |

:::note
In the future we plan to introduce a proper "secret" store, per user and per project.
:::

> Consult the [Troubleshooting](backend-admin/troubleshooting) page for examples that show how to get logs from the various services composing QA-Board.
>
> For development, consult the READMEs for the [backend](https://github.com/Samsung/qaboard/tree/master/backend) and the [frontend](https://github.com/Samsung/qaboard/tree/master/webapp).


## For "production"
### Backups
In *production.yml* you can uncomment the `cron-backup-db` service to enable daily backups, and replace `/WHERE/TO/SAVE/BACKUPS` with a (backup'ed!)location on the host.

### Using SSL / hosting behind a reverse proxy
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

## Cleanup
We run those 2 cron jobs:
```cron
# Weekly cleanup of old results
# https://samsung.github.io/qaboard/docs/deleting-old-data
59 1 1 * * cd qaboard && docker-compose exec backend qaboard_clean

# Restart the image server, somehow after a while they need it (need research...)
0 4 * * * cd qaboard && docker-compose -f docker-compose.yml -f production.yml stop cantaloupe && docker-compose -f docker-compose.yml -f production.yml rm -v cantaloupe && docker-compose -f docker-compose.yml -f production.yml up -d cantaloupe

```

:::note
It would be cleaner to run those crontabs within `docker-compose`... (pull requests welcome :smile:)
:::