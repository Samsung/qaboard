# qatools-webapp
A web application integrated with [`qatools`](http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial) to:
- Show, debug and compare algorithm results.
- Tune parameters.

> **WIP:** admin guides are being written, and the deployment/dev story for qaboard being improved...

## Repository organization
- [slamvizapp-webapp](slamvizapp-webapp/) is the frontend, a web application.
- [slamvizapp](slamvizapp/) is the applications' backend:
  * It manages a database where results are stored...
  * and exposes it via a simple HTTP API.
- [cantaloupe](cantaloupe/) setups a [Cantaloupe](https://medusa-project.github.io/cantaloupe/) IIF server, used to stream large images to the users.

## How to run (with Docker, recommended)
Set the slamvizapp repository under *my-vdi/dvs/slamvizapp*.
Run the command [`docker build -t qaboard-staging`].

You need to set two environment variables:
- *$GITLAB_ACCESS_TOKEN*: an access token from Gitlab ([get it here](http://gitlab-srv/profile/personal_access_tokens))
- *$SSH_PASSPHRASE*: the passphrase to `arthurf`'s key in *deployment/ssh/id_rsa* (or provide your own key and use your own user) 

Open */deployment/start-docker.sh* and uncomment the line: 
*DOCKER_IMAGE="qaboard-${DOCKER_TAG:=$CI_ENVIRONMENT_SLUG}"*

Then you're all set:
```bash
# This short script wraps `docker run`. By default it will enable "--restart always"
# Adapt it to your needs.
./deployment/start-docker.sh
# => now serving http://dvs:5000

# For a interactive debugging...
CI_DEBUG=ON CI_ENVIRONMENT_SLUG=staging QABOARD_DEBUG_WITH_MOUNTS=TRUE ./deployment/start-docker.sh
# => now serving http://dvs:9000
```
if it's failed with error: [`too many levels of symbolic links`]
try again until success.


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
