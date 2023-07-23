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
If you want to use a different folder, find-and-replace */mnt/qaboard* with your path in `docker-compose.yml` and *services/nginx/conf.d/qaboard.conf*.
:::

:::note Shared Storage?
Later, read how to setup [**NFS**](https://www.digitalocean.com/community/tutorials/how-to-set-up-an-nfs-mount-on-ubuntu-18-04) or [**Samba**](https://www.digitalocean.com/community/tutorials/how-to-set-up-a-samba-share-for-a-small-organization-on-ubuntu-16-04). If you need fine-tuning read about [options for NFS volumes](https://docs.docker.com/compose/compose-file/#volume-configuration-reference) in *docker-compose.yml*.
:::

:::note Working in the cloud?
Use file-base storage like [AWS EFS](https://aws.amazon.com/en/efs/) or [GCP Filestore](https://cloud.google.com/filestore).

We plan on supporting blob-stores like AWS **S3**. <a href="mailto:arthur.flam@gmail.com">Contact us</a> or [create an issue](https://github.com/samsung/qaboard/issues) if it would help.
:::

:::tip At SIRC
To resolve auto-mount issues causing "too many levels of symbolic links", run `./at-sirc-before-up.py`.
:::

## Starting the server
1. You need Linux, [`docker`](https://docs.docker.com/engine/install/), [`docker-compose`](https://docs.docker.com/compose/install/) and `git`.
2. To start the QA-Board server:
```bash
git clone https://gitlab-srv/common-infrastructure/qaboard.git
cd qaboard

docker-compose -f docker-compose.yml -f sirc.yml pull

# At SIRC we need to make sure important folders are mounted before starting containers...
./at-sirc-before-up.py

docker-compose -f docker-compose.yml -f sirc.yml up -d
#=> the application is live at localhost:8080
```

To have the server restart automatically:

At SIRC:
```bash
docker-compose -f docker-compose.yml -f production.yml -f sirc.yml up -d
```

:::note
Want to install from a Kubernetes helm chart, CloudFormation or Terraform plans? <a href="mailto:arthur.flam@gmail.com">Get in touch</a>.
:::

## User Management
qaboard supports `user sign-in` to allow different levels of access and user-features such as Tuning.

Supported sign-in systems:
- Local - users that are created by qaboard. \
To register a new user, add an entry to the database under `users` table. \
Or enable http requests of the _signup()_ function at _backend/backend/api/auth.py_ , then use the curl command:
  ```bash
  curl -d "username=<user_name>&password=<password>&email=<user_email>&full_name=<user_full_name>" -X POST '<qaboard_url>/api/v1/user/signup/
  ```
- LDAP
- SSO via SAML

The login policy is set via environment variables such as `QABOARD_LOGIN_TYPE`, `QABOARD_LOGIN_REQIRED`, `QABOARD_LDAP_`, `QABOARD_SAML_`, as describred in the Environment Variables section.

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
| `QABOARD_LOGIN_TYPE`   | _LOCAL_  | Set to `LOCAL/LDAP/SAML`                   |
| `QABOARD_LOGIN_REQUIRED`   | _false_  | Set to `true` to block anonymous users                   |
| `QABOARD_LDAP_HOST`   | _none_  | Server hostname (including port)                   |
| `QABOARD_LDAP_PORT`   | _389_  | Server port, usually 389 (or 636 if SSL is used / **not supported yet!**). |
| `QABOARD_LDAP_USER_BASE`   | _none_  | Search base for users. |
| `QABOARD_LDAP_BIND_DN`     | _none_  | The Distinguished Name to bind as, this user will be used to lookup information about other users. |
| `QABOARD_LDAP_PASSWORD`    | _none_  | The password to bind with for the lookup user. |
| `QABOARD_LDAP_USER_FILTER` | _none_  | User lookup filter, the placeholder `{login}` will be replaced by the user supplied login. (e.g. `(&(objectClass=inetOrgPerson)(|(uid={login})(mail={login})))`, or `(&(objectClass=user)(|(sAMAccountName={login})))`) |
| `QABOARD_LDAP_ATTRIBUTE_EMAIL`         | _mail_  |                                            |
| `QABOARD_LDAP_ATTRIBUTE_COMMON_NAME`   | _cn_    |                                            |
| `QABOARD_SAML_DIR`   | _none_  | The path to the directory with the SAML configuration files, as in the [python-saml](https://github.com/SAML-Toolkits/python-saml) docs |
| `QABOARD_SAML_ATTRIBUTE_EMAIL`         | _none_  |                                            |
| `QABOARD_SAML_ATTRIBUTE_COMMON_NAME`         | _none_  |                                            |
| `QABOARD_SAML_ATTRIBUTE_USER_NAME`   | _none_    |                                            |
| `QABOARD_SAML_ATTRIBUTE_ID`   | _none_    |                                            |
| `CANTALOUPE_MEM_START` | 1g      | Starting memory for the image server                 |
| `CANTALOUPE_MEM_MAX`   | 2g      | Max memory for the image server                      |
| `UWSGI_PROCESSS`       | 1       | default: 1g                                          |
| `SENTRY_DSN`           | _none_  | monitor crashes with sentry.io. Example: https://xxxxxxxxxxx@sentry.io/000 |
| `SENTRY_SAMPLE_RATE`           | 0.2  | sample for perf monitoring |


:::note
In the future we plan to introduce a proper "secret" store, per user and per project.
:::

> Consult the [Troubleshooting](backend-admin/troubleshooting) page for examples that show how to get logs from the various services composing QA-Board.
>
> For development, consult the READMEs for the [backend](https://github.com/Samsung/qaboard/tree/master/backend) and the [frontend](https://github.com/Samsung/qaboard/tree/master/webapp).


## (Optional) For "production"
### Backups
In *production.yml* you can uncomment the `cron-backup-db` service to enable daily backups.

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
0 4 * * * cd qaboard && docker-compose -f docker-compose.yml -f production.yml -f sirc.yml stop cantaloupe && docker-compose -f docker-compose.yml -f production.yml -f sirc.yml rm -v cantaloupe && docker-compose -f docker-compose.yml -f production.yml -f sirc.yml up -d cantaloupe


# Restart CDE's IIIF bridge
0 4 * * * cd qaboard && docker-compose -f docker-compose.yml -f production.yml -f sirc.yml restart iiif-cde

# To resolve auto-mount issues causing "too many levels of symbolic links"
@reboot /home/ispq/qaboard_prod/at-sirc-before-up.py.
```

:::tip
Check `qaboard_clean --help` to implement complex cleanup strategies.
:::
