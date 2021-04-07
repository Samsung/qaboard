---
id: deploy
title: Starting a QA-Board server
sidebar_label: Server Bringup
---
QA-Board's run-wrapper, `qa`, will sync with a central server that tracks and displays results.

:::note Need a hosted version?
We're considering offering a hosted solution to help you get started. If you are interested, contact the <a href="mailto:arthur.flam@gmail.com">maintainers</a>.

Until then, please [fill issues](https://github.com/Samsung/qaboard/issues), [chat](https://spectrum.chat/qaboard) or <a href="mailto:arthur.flam@samsung.com">send an email</a> to maintainers if you run into issues starting a server. We're responsive.

:::

## Create a directory to store results 
QA-Board expects that all clients can access a shared storage to save and read results.

To get started quickly on a single server, create a *local* folder. Worry about sharing it later: 

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
1. You need Linux, [`docker`](https://docs.docker.com/engine/install/), [`docker-compose`](https://docs.docker.com/compose/install/) and `git`.
2. To start the QA-Board server:
```bash
git clone https://github.com/Samsung/qaboard.git
cd qaboard

docker-compose pull
docker-compose up -d
#=> the application is live at localhost:5151

# if you can't access the application, check the port is not blocked by a firewall
# cloud services often require you to add the ports you need to an allow-list.
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
| `JENKINS_AUTH`         | _none_  | Credentials used to [trigger jenkins jobs](/docs/triggering-third-party-tool) on 1 or many jenkins servers. The format is a JSON string looking like `{"hostname_1": {"user": "jenkinsuser", "token": "xxxxx", "crumb": "yyy"}}` ([how-to-get-the-token-crumb?](/docs/triggering-| `GITLAB_AUTH`         | _none_  | Credentials used to forward private project avatars from Gitlab. The format is a JSON string looking like `{"hostname": {"user": "username", "password": "xxxxx", "type": "user"}}`. `type` is optionnal and can also be `ldap_user`. Asking for a password is not great but [the API is not sufficient](https://docs.gitlab.com/ce/api/#session-cookie)... You can use `"http": true` if needed. |
third-party-tools#example-jenkins-integration-via-webhooks))               |
| `QABOARD_LDAP_ENABLED`   | _none_  | If set to `true` LDAP is enabled                   |

  # Server hostname (including port)
| `QABOARD_LDAP_HOST`   | _none_  |                    |
| `QABOARD_LDAP_PORT`   | _389_  | Server port, usually 389 (or 636 if SSL is used / **not supported yet!**). |
| `QABOARD_LDAP_USER_BASE`   | _none_  | Search base for users. |
| `QABOARD_LDAP_BIND_DN`     | _none_  | The Distinguished Name to bind as, this user will be used to lookup information about other users. |
| `QABOARD_LDAP_PASSWORD`    | _none_  | The password to bind with for the lookup user. |
| `QABOARD_LDAP_USER_FILTER` | _none_  | User lookup filter, the placeholder `{login}` will be replaced by the user supplied login. (e.g. `(&(objectClass=inetOrgPerson)(|(uid={login})(mail={login})))`, or `(&(objectClass=user)(|(sAMAccountName={login})))`) |
| `QABOARD_LDAP_ATTRIBUTE_EMAIL`         | _mail_  |                                            |
| `QABOARD_LDAP_ATTRIBUTE_COMMON_NAME`   | _cn_    |                                            |
| `CANTALOUPE_MEM_START` | 1g      | Starting memory for the image server                 |
| `CANTALOUPE_MEM_MAX`   | 2g      | Max memory for the image server                      |
| `UWSGI_PROCESSS`       | 1       | default: 1g                                          |
| `UWSGI_UID_CAN_SUDO`   | _none_  | if set, the uwsgi user can sudo                      |

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
59 1 1 * * cd qaboard && docker-compose exec -T backend qaboard_clean
# https://github.com/docker/compose/issues/3352

# Weekly removal of old docker images, helps to avoid filling the disk on the host
59 1 2 * * docker image prune --force

# Restart the image server, somehow after a while they need it (need research...)
0 4 * * * cd qaboard && docker-compose -f docker-compose.yml -f production.yml stop cantaloupe && docker-compose -f docker-compose.yml -f production.yml rm -v cantaloupe && docker-compose -f docker-compose.yml -f production.yml up -d cantaloupe
```

:::tip
Check `qaboard_clean --help` to implement complex cleanup strategies.
:::
