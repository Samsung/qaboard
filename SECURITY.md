# Security Policy

## Reporting a vulnerability

Please **do not open public GitHub issues** for security problems.

Instead, email **arthur.flam@samsung.com** with:
- a description of the issue and its impact,
- the affected component (CLI, backend API, webapp, deployment files) and version or commit,
- steps to reproduce, if you have them.

We will acknowledge your report, keep you updated while we work on a fix, and credit you in the release notes if you wish.

Only the latest version on the default branch receives security fixes.


## Threat model

QA-Board has two very different trust boundaries:

- **The `qa` CLI and the job runners (LSF, Celery, Dask, local) run code by design.** They run your project's code, `qaboard.yaml` hooks, `.envrc` files in artifact folders, and so on. Anyone who can commit to a tracked repository, write to the artifacts storage or send jobs to the runners can run code there. This is expected.
- **The server (backend API) must not let network access turn into code execution.** Remote code execution, credential leaks or privilege escalation through the API are vulnerabilities, and we want to hear about them.


## Fixed issues

Fixed on the default branch, after the `qaboard` 1.0.3 release:

- Shell command injection in the "redo runs" and "tuning" features: values stored in the database (batch labels, paths, configurations, job options...) were put unquoted in shell scripts.
- Shell command injection when stopping batches, through the stored runner options. Stopping Dask batches could also connect to any scheduler address; it now only connects to those listed in `QABOARD_DASK_SCHEDULERS`.
- Missing authentication: redo, tuning and other actions could be used by anyone. They now require a logged-in user (or an API token), and jobs run as that user instead of a user name chosen by the client.
- The `GITLAB_ACCESS_TOKEN` could be sent to any host chosen by the client. It is now only sent to `GITLAB_HOST` and hosts listed in `QABOARD_GITLAB_HOSTS`.
- A hardcoded default Flask `SECRET_KEY` allowed forging session cookies. If `SECRET_KEY` is not set, a random key is now generated and saved in `$QABOARD_DATA_DIR/secret_key`.
- Path traversal when reading and writing the custom test groups files.
- Git argument injection through commit IDs when restoring artifacts.
- The GitLab proxy, webhook proxy, export, save-artifacts and delete endpoints now require a logged-in user.
- Changing or deleting a single output (`PUT`/`DELETE /api/v1/output/<id>`) didn't require a login. Since the output's folder is chosen by the client that created it, anyone could make the server delete any folder it can write to.
- The GitLab and GitHub webhooks could make the server clone a repository to any path, and from any host: with a `GITHUB_ACCESS_TOKEN`, the token was sent to that host. Repository paths are now validated, the token is only sent to github.com and hosts listed in `QABOARD_GITHUB_HOSTS`, and webhooks can be authenticated with `QABOARD_WEBHOOK_SECRET`.
- The server wrote, deleted and ran code in output and artifacts folders chosen by the clients, anywhere on its filesystem. It now only does so inside the storage folders listed in `QABOARD_STORAGE_ROOTS` (default: `/mnt/qaboard`), and never in its own folders (`QABOARD_DATA_DIR`, the git clones, the shared folder, the image cache, its user's home). Results with other folders are refused.
- Deleting results followed symlinks: deleting an output that contained a link to a folder deleted the folder's contents. Files listed in manifests could also point outside of the output folder.


## Known issues

We know about the issues below. In the deployments maintained by the authors, they are mitigated by network isolation and site configuration. **If you run QA-Board yourself, please apply the mitigations listed below.** We plan to fix them in the code.

### Results are sent to the server without authentication
The `qa` CLI sends runs, batches and commits to `POST /api/v1/output`, `/api/v1/batch` and `/api/v1/commit` without authentication, so that it works from any CI or workstation. As a result:
- anyone who can reach the server can create or change results, and delete results (`qa optimize` deletes the previous best iteration's runs through `POST /api/v1/batch`);
- the output and artifacts folders stored with results can be any folder in the storage (`QABOARD_STORAGE_ROOTS`). Deleting results, and the cleanup scripts, delete files there, as the owner of the files when the server can switch users;
- results can point to an existing commit and replace its artifacts folder. Redo, tuning and "Run Tests" run code from that folder (its `.envrc` files and the project's entrypoint). They run as the logged-in user when an LSF bridge is configured, but listing the tests of a tuning group (`POST /api/v1/tests/group`, a logged-in user is needed) runs `qa batch --list` in the backend itself, as the server's user.

Code that runs as the server's user can read its credentials (database, GitLab token, the ssh key of the LSF bridge...). If users can write in the storage, they can also change the `.envrc` files and the code that the server, CI and other users run from it.

*Mitigations*: only expose the server to trusted networks; set `QABOARD_STORAGE_ROOTS` as narrowly as you can; make sure users can't write to the artifacts folders.
*Planned*: an option to require API tokens on these endpoints, and running the tests listing without access to the server's credentials.

### Insecure defaults in `docker-compose.yml`
- RabbitMQ is published on ports 5672/15672 with the `guest:guest` account. Celery workers run the shell commands given in the tasks they receive, so **anyone who can reach RabbitMQ can run commands on the workers**.
- Flower is published on port 8888 without authentication.
- Postgres uses the password `password`, and some deployment files publish its port.
- pgAdmin uses a default password.

*Mitigations*: don't publish these ports outside the Docker network (or firewall them), and change all the default credentials.

### Webhooks
Without `QABOARD_WEBHOOK_SECRET`, anyone who can reach the server can send fake push events to `/webhook/gitlab` and `/webhook/github`: they make the server fetch repositories, and change the projects' git metadata.

*Mitigation*: set `QABOARD_WEBHOOK_SECRET`, and the same secret in the GitLab and GitHub webhooks.

### Accounts and sessions
- With `QABOARD_LOGIN_TYPE=LOCAL`, anyone can sign up. Set `QABOARD_DISABLE_SIGNUP=True`, or use LDAP or SAML.
- The default setup uses plain HTTP, so session cookies and API tokens can be sniffed on the network. Serve QA-Board over HTTPS.
- API tokens don't expire by default, and can't be revoked from the web application.
- The SAML login redirects to the `RelayState` URL without checking it (open redirect).

### Other
- `GET /api/v1/export` lets logged-in users create links or copies of output files in most folders the server can write to.
- `POST /api/v1/jenkins/build/trigger` doesn't require authentication, because the CLI's Jenkins runner calls it. Jenkins credentials are only sent to the hosts configured in `JENKINS_AUTH`.
- `POST /api/v1/gitlab/job` doesn't require authentication: anyone can read the details of GitLab CI jobs that `GITLAB_ACCESS_TOKEN` can see.
- Milestones can be created and deleted without a login.
- `GET /api/v1/output/<id>/manifest` doesn't require a login: it writes `manifest.outputs.json` in the output's folder, and returns the list of files in it.
- Inside the backend container, `fs_utils.as_user` passes results between processes using a world-writable temporary file read with `pickle`.


## Using the API from scripts

Actions like redo, tuning or deleting results need a logged-in user. To use them from scripts:

1. While logged in to QA-Board in your browser, open the developer console and run:
   ```js
   fetch('/api/v1/user/token/', {method: 'POST'}).then(r => r.json()).then(console.log)
   ```
2. Save the token in `~/.qaboard/secrets.yaml` (or set `$QA_TOKEN`), and make sure only you can read the file:
   ```bash
   mkdir -p ~/.qaboard
   echo "QA_TOKEN: <your-token>" > ~/.qaboard/secrets.yaml
   chmod 600 ~/.qaboard/secrets.yaml
   ```
3. The `qa` CLI and `qaboard.api` then send it as `Authorization: Bearer <token>`. With `curl`, use `-H "Authorization: Bearer $QA_TOKEN"`.

The token is only read from `$QA_TOKEN` or your personal file (`$QA_USER_SECRETS`, default `~/.qaboard/secrets.yaml`), never from the shared `$QA_SECRETS` file. Treat it like a password: anyone holding it can act as you.
