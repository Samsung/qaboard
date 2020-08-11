---
id: deploy
title: Starting a QA-Board server
sidebar_label: Server Bringup
---
QA-Board's run-wrapper, `qa`, will sync with a central server, that tracks and displays results.

:::note Need a hosted version?
We're considering offering a hosted solution to help you get started. If your're interested, contact the <a href="mailto:arthur.flam@gmail.com">maintainers</a>.

Until then, please [fill issues](https://github.com/Samsung/qaboard/issues), [chat](https://spectrum.chat/qaboard) or <a href="mailto:arthur.flam@samsung.com">send an email</a> to maintainers if you run into issues starting a server. We're responsive.

:::

## Create a directory to store results 
QA-Board expect that all clients can access a shared storage to save and read results.

To get started quickly on a single server, just create a *local* folder, and worry about sharing it later: 

```bash
mkdir -p /mnt/qabaord
chmod -R 777 /mnt/qabaord
```

:::tip
If you want to use a different folder, replace */mnt/qaboard* with your path in `docker-compose.yml` and *services/nginx/conf.d/qaboard.conf*.
:::

:::note Shared Storage?
Later, read how to setup [**NFS**](https://www.digitalocean.com/community/tutorials/how-to-set-up-an-nfs-mount-on-ubuntu-18-04) or [**Samba**](https://www.digitalocean.com/community/tutorials/how-to-set-up-a-samba-share-for-a-small-organization-on-ubuntu-16-04). If you need fine-tuning read about [options for NFS volumes](https://docs.docker.com/compose/compose-file/#volume-configuration-reference) in *docker-compose.yml*.
:::

:::note Working in the cloud?
Use file-base storage like [AWS EFS](https://aws.amazon.com/en/efs/) or [GCP Filestore](https://cloud.google.com/filestore).

We plan on supporting blob-stores like AWS **S3**. <a href="mailto:arthur.flam@gmail.com">Contact us</a> or [create an issue](https://github.com/samsung/qaboard/issues) if it would help.
:::



## Starting the server
1. You need [`docker`](https://docs.docker.com/engine/install/), [`docker-compose`](https://docs.docker.com/compose/install/) and `git`.
2. To start the QA-Board server:
```bash
git clone git@github.com:Samsung/qaboard.git
cd qaboard

docker-compose pull
docker-compose up -d
#=> the application is live at localhost:5151
```


To have the server restart automatically:

```bash
docker-compose -f docker-compose.yml -f production.yml up -d
```

:::note
Want to install from a Kubernetes helm chart, CloudFormation or Terraform plans? <a href="mailto:arthur.flam@gmail.com">Get in touch</a>.
:::

## (Optional) Environment variables
> To configure your installation, you can either edit [an `.env` file](https://docs.docker.com/compose/environment-variables/#the-env-file) or `services.backend.environment` in one of the `docker-compose` files (*docker-compose.yml*, *development.yml*, *production.yml*...).


| ENV Variable           | Default | Usage                                                |
-------------------------|-------- |------------------------------------------------------|
| `GITLAB_ACCESS_TOKEN`  | _none_  | Optional for some extra features. Get it with a `read_repository` scope at https://$gitlab-server/profile/personal_access_tokens |
| `GITLAB_HOST`          | _none_  | e.g. *https://gitlab.com* or *http://my-gitlab-srv/* |
| `QABOARD_PORT_HTTP`    | 5151    | Port mapped to the app on the host                   |
| `QABOARD_DB_HOST`      | db      | Connect the backend to a non-default database host (e.g. instead of dev'ing with prod dumps, connect directly to it) |
| `QABOARD_DB_PORT`      | 5432    | Connect to a non-default database port               |
| `JENKINS_USER_NAME`    | _none_  | Used to [trigger jenkins jobs](/docs/triggering-third-party-tool) ([how-to-get-it?](/docs/triggering-third-party-tools#example-jenkins-integration-via-webhooks))               |
| `JENKINS_USER_TOKEN`   | _none_  |                                                      |
| `JENKINS_USER_CRUMB`   | _none_  |                                                      |
| `CANTALOUPE_MEM_START` | 1g      | Starting memory for the image server                 |
| `CANTALOUPE_MEM_MAX`   | 2g      | Max memory for the image server                      |
| `UWSGI_PROCESSS`       | 1       | default: 1g                                          |

:::note
In the future we plan to introduce a proper "secret" store, per user and per project.
:::

> Consult the [Troubleshooting](backend-admin/troubleshooting) page for examples that show how to get logs from the various services composing QA-Board.
>
> For development, consult the READMEs for the [backend](https://github.com/Samsung/qaboard/tree/master/backend) and the [frontend](https://github.com/Samsung/qaboard/tree/master/webapp).


## (Optional) For "production"
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

## (Optional) Cleanup
We run those cron jobs:
```cron
# Weekly cleanup of old results
# https://samsung.github.io/qaboard/docs/deleting-old-data
59 1 1 * * cd qaboard && docker-compose exec backend qaboard_clean

# Weekly removal of old docker images, helps to avoid filling the disk on the host
59 1 2 * * docker image prune --force

# Restart the image server, somehow after a while they need it (need research...)
0 4 * * * cd qaboard && docker-compose -f docker-compose.yml -f production.yml stop cantaloupe && docker-compose -f docker-compose.yml -f production.yml rm -v cantaloupe && docker-compose -f docker-compose.yml -f production.yml up -d cantaloupe
```

:::note
It would be cleaner to run those crontabs within `docker-compose`... (pull requests welcome :smile:)
:::
