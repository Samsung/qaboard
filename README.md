# qatools-webapp
A web application integrated with [`qatools`](http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial) to:
- Show, debug and compare algorithm results.
- Tune parameters.

> **WIP:** Admin guides are being written!
> **WIP:** We'll use a configuration format like `docker-compose`'s to split the container into database/backend/..., define env/ports/mounts cleanly, and make dev/ops simpler.

## Repository organization
- [slamvizapp-webapp](slamvizapp-webapp/) is the frontend, a web application.
- [slamvizapp](slamvizapp/) is the applications' backend:
  * It manages a database where results are stored...
  * and exposes it via a simple HTTP API.
- [cantaloupe](cantaloupe/) setups a [Cantaloupe](https://medusa-project.github.io/cantaloupe/) IIF server, used to stream large images to the users.

## How to build
First get the code
```bash
cd
mkdir -p dvs/slamvizapp
git clone git@gitlab-srv/dvs/slamvizapp.git
cd slamvizapp
```

Then build with `docker>=18.06`:
```bash
# since we need to access private repositories
export DOCKER_BUILDKIT=1
eval `ssh-agent`
ssh-add ~/.ssh/id_rsa

export DOCKER_IMAGE=qaboard
export CI_ENVIRONMENT_SLUG=staging
docker build --ssh default --tag $DOCKER_IMAGE-$CI_ENVIRONMENT_SLUG .
```

## How to run
You must set a few environment variable:
- *$GITLAB_ACCESS_TOKEN*: [get it here](http://gitlab-srv/profile/personal_access_tokens)
- *$SSH_PASSPHRASE*: the passphrase a SIRC user key in in *deployment/ssh/id_rsa*. In the future we'll configure SSH agent forwarding from the host to make this simpler...

To connect to a Jenkins server, you can optionnally define *JENKINS_USER_NAME*, *JENKINS_USER_TOKEN*, *JENKINS_USER_CRUMB*.

> In the future we plan to introduce a proper "secret" store, per-instance and per project.

Then you're all set:
```bash
# By (bad, fixme) default the container is run with "--restart always" in the background.
# For interactive debugging,
export CI_DEBUG=ON

# This mounts $HOME/dvs/slamvizapp where the container looks for its code,
# and enables easier developmen
export QABOARD_DEBUG_WITH_MOUNTS=TRUE

# Wraps `docker run`. Adapt the script to your needs...
./deployment/start-docker.sh
# => now serving http://localhost:9000


# Using `CI_ENVIRONMENT_SLUG=staging` changes port mapping slightly...

For development, you may want to restore a database backup. As a quick solution you can (DANGEROUS) connect to the SIRC application server:
```bash
QABOARD_DB_HOST=qa
```

Troubleshooting:
- If you have issues like `too many levels of symbolic links`, try again until success...

## TODO
- Check the database is initialized correctly from 0.
- As-is, the nginx server tries to look for SSL keys and fails. It really should handled by a reverse proxy, not by us...

## SSL configuration
```bash
cd deployment/nginx/ssl/qa

# 1. Generate a key `.key`.
openssl genrsa -out qa.key 2048

# 2. Generate a certificate request `.csr`.
openssl req -new -sha256 -key qa.key -out qa.csr -config qa.csr.conf
# Accept all the defaults:
# - Country Name: IL
# - State or Province Name: Israel
# - Locality Name: Ramat Gan
# - Organization Name: Samsung
# - Organizational Unit Name: SIRC
# - Common Name: *.qa
# - Email: arthur.flam@samsung.com
# - Password: (empty)
# - Optionnal Company Name: (empty)

# Check all is good.
openssl req -noout -text -in qa.csr

# 3. Send the CSR to IT.
# 4. They will give you a `.cer` certificate. Convert it to `.pem` with 
openssl x509 -in dvs.cer -inform der -outform pem -out qa.pem

# 5. Now you can configure your server to use qa.key and qa.pem
```

References:

- [nginx configuration](http://nginx.org/en/docs/http/configuring_https_servers.html)
- [multiname certificates](https://stackoverflow.com/questions/23523456/how-to-give-a-multiline-certificate-name-cn-for-a-certificate-generated-using)
