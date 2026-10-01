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


## Known issues

We know about the issues below. In the deployments maintained by the authors, they are mitigated by network isolation and site configuration. **If you run QA-Board yourself, please apply the mitigations listed below.** We plan to fix them in the code.

### Results are sent to the server without authentication
The `qa` CLI sends runs, batches and commits to `POST /api/v1/output`, `/api/v1/batch` and `/api/v1/commit` without authentication, so that it works from any CI or workstation. As a result:
- anyone who can reach the server can create or change results;
- paths stored with results (output and artifacts folders) can't be trusted. Deleting results, and the cleanup scripts, delete files at those paths, as the owner of the files when the server can switch users.

*Mitigations*: only expose the server to trusted networks; make sure the server can't write to folders outside your QA-Board storage.
*Planned*: an option to require API tokens on these endpoints, and refusing to delete files outside the configured storage roots.

### Insecure defaults in `docker-compose.yml`
- RabbitMQ is published on ports 5672/15672 with the `guest:guest` account. Celery workers run the shell commands given in the tasks they receive, so **anyone who can reach RabbitMQ can run commands on the workers**.
- Flower is published on port 8888 without authentication.
- Postgres uses the password `password`, and some deployment files publish its port.
- pgAdmin uses a default password.

*Mitigations*: don't publish these ports outside the Docker network (or firewall them), and change all the default credentials.

### Accounts and sessions
- With `QABOARD_LOGIN_TYPE=LOCAL`, anyone can sign up. Set `QABOARD_DISABLE_SIGNUP=True`, or use LDAP or SAML.
- The default setup uses plain HTTP, so session cookies and API tokens can be sniffed on the network. Serve QA-Board over HTTPS.
- API tokens don't expire by default, and can't be revoked from the web application.
- The SAML login redirects to the `RelayState` URL without checking it (open redirect).

### Other
- `GET /api/v1/export` lets logged-in users create links or copies of output files in most folders the server can write to.
- `POST /api/v1/jenkins/build/trigger` doesn't require authentication, because the CLI's Jenkins runner calls it. Jenkins credentials are only sent to the hosts configured in `JENKINS_AUTH`.
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
