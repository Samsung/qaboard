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

- Some project data could be read without checking who can see the project: a run's details and its manifest
  (`GET /api/v1/output/<id>` and `/manifest`, which also wrote a file), a project's test groups, the commits of
  milestones used as references, and files under `/s/` with tokens limited to other projects. They now follow
  project roles.
- Stored XSS: HTML and SVG files in the storage ran their scripts in QA-Board's origin, as whoever opened them, from
  a link or in the run cards' viewers (figures saved as HTML, reports). Their scripts now run sandboxed in an origin
  of their own, in the web app's viewers; opened on their own (`/s/...`), they show without scripts
  (`Content-Security-Policy: sandbox`, `services/nginx/conf.d/qaboard-files.conf`). Error messages in run cards are
  shown as text.
- `POST /api/v1/task/celery/<id>` didn't require a login, and waited forever for a Celery worker: it now requires
  one, and gives up after 2 minutes.
- `POST /api/v1/webhook/proxy`, used for the webhooks and links of `qaboard.yaml`'s integrations, let logged-in users
  send any request to any URL from the server (SSRF), including internal services, and passed back the answer's
  cookies. It now only calls the hosts of the integrations of the project's, commit's and batches' `qaboard.yaml`, the
  git and Jenkins hosts and `QABOARD_PROXY_HOSTS`, also after redirects, without users' cookies, and its answers
  can't set cookies or run scripts.
- `POST /api/v1/jenkins/build/trigger` started any Jenkins job, with the server's Jenkins credentials, for anyone who
  could reach the server. Without a user (the CLI's Jenkins runner), it now only starts the jobs listed in the projects'
  `qaboard.yaml`, and none when `ingest.auth` is `token`. Signed-in users must be developers of the project they name,
  and the audit log records who started what.
- `POST /api/v1/gitlab/job` (without a login) and `/api/v1/gitlab/job/play` read and played the CI jobs of any GitLab
  project the server's token can see. They now only use the repository of a QA-Board project the user can access
  (developers, to play jobs).

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
- When signing up failed, e.g. because the user name was taken, the server logged the form with the plaintext password, and answered with the database error, which included the password's hash and the email.
- Logins with an empty password were sent to LDAP, where they can succeed as anonymous binds, and the user name was put unescaped in the LDAP search filter.
- The image viewer's API (`/api/v1/output/image/pixel`, `/pixels` and `/diff`) didn't require a login, and read any image on the server's filesystem, also outside the storage (with `..` or absolute paths), whatever the files' restrictions. It now requires a login, only reads files in `QABOARD_STORAGE_ROOTS` (not the server's own folders), and checks the user can read them, like the file browser. The video viewer's API (`/api/v1/output/video/...`) does the same.
- `POST /api/v1/output/diff/report` wrote a PDF in a folder chosen by the client, anywhere the server could write, without a login. It was unused and is removed.
- Sessions couldn't be revoked: signing out only deleted the browser's cookie, and a copied session cookie stayed valid until `SECRET_KEY` changed. Sessions are now stored on the server, end after `sessions.idle_days` without activity and `sessions.max_days` in any case, and end when users sign out, when they or admins revoke them, and when the account is disabled.
- There were no rate limits on signing in. The shipped nginx configuration now limits signing in, sign-up and `qa auth login` codes.
- The GitLab proxy (`GET /api/v1/gitlab/proxy`), used for avatars and badges, fetched any URL for logged-in users, including internal services (SSRF), and passed back all the response's headers. It now only fetches from the GitLab hosts, gravatar and the hosts listed in `QABOARD_PROXY_HOSTS`, also after redirects, and its responses can't run scripts.


## Known issues

We know about the issues below. In the deployments maintained by the authors, they are mitigated by network isolation and site configuration. **If you run QA-Board yourself, please apply the mitigations listed below.** We plan to fix them in the code.

### Results are sent to the server without authentication (by default)
By default (`ingest.auth` is `off`), the `qa` CLI can send runs, batches and commits to `POST /api/v1/output`, `/api/v1/batch` and `/api/v1/commit` without authentication, so that it works from any CI or workstation. Results sent with a token record who really sent them; the others are shown as unverified. As a result, until you require tokens:
- anyone who can reach the server can create or change results, also in private projects, and delete results (`qa optimize` deletes the previous best iteration's runs through `POST /api/v1/batch`);
- the output and artifacts folders stored with results can be any folder in the storage (`QABOARD_STORAGE_ROOTS`). Deleting results, and the cleanup scripts, delete files there, as the owner of the files when the server can switch users;
- the reference branch's `qaboard.yaml` sent with a commit becomes the project's configuration. Its `recreate_artifacts` settings tell the server where to send a request (a webhook URL, a Jenkins job, a job of the project's own GitLab repository) when a logged-in user redoes runs on a commit whose artifacts are missing. GitLab and Jenkins credentials are only sent to the hosts configured on the server, but webhooks can target any address the server can reach (without following redirects);
- results can point to an existing commit and replace its artifacts folder. Redo, tuning and "Run Tests" run code from that folder (its `.envrc` files and the project's entrypoint). They run as the logged-in user when an LSF bridge is configured, but listing the tests of a tuning group (`POST /api/v1/tests/group`, a logged-in user is needed) runs `qa batch --list` in the backend itself, as the server's user.

Code that runs as the server's user can read its credentials (database, GitLab token, the ssh key of the LSF bridge...). If users can write in the storage, they can also change the `.envrc` files and the code that the server, CI and other users run from it.

*Mitigations*: require tokens to send results (`ingest.auth` set to `token` in the admin panel, or `QABOARD_INGEST_AUTH=token`, after a period in `warn`); only expose the server to trusted networks; set `QABOARD_STORAGE_ROOTS` as narrowly as you can; make sure users can't write to the artifacts folders.
*Planned*: per-project ingest policies (signed-in senders already need the developer role), and running the tests listing without access to the server's credentials.

### Default passwords in `docker-compose.yml`
RabbitMQ, Flower and pgAdmin are only published on the host itself (`127.0.0.1`), but their default credentials stay until you change them:
- RabbitMQ uses the `guest:guest` account. Celery workers run the shell commands given in the tasks they receive, so **anyone who can connect to RabbitMQ can run commands on the workers**: publishing it for workers on other hosts (`QABOARD_RABBITMQ_HOST_IP`, DSK's overlay) needs a password.
- Flower can revoke tasks and shut the workers down. At `/flower/`, QA-Board's nginx only lets QA-Board's admins in (`snippets/qaboard-admins-only.conf`); on its port (`127.0.0.1:8888`) it has no login unless `FLOWER_BASIC_AUTH` is set.
- Postgres uses the password `password` unless `QABOARD_DB_PASSWORD` is set, and some deployment files publish its port.
- pgAdmin uses a default password.

*Mitigations*: set the passwords in `.env` before the first start (see [Passwords and admin services](https://samsung.github.io/qaboard/docs/deploy#passwords-and-admin-services)), and don't publish these ports outside the Docker network (or firewall them).

### Webhooks
Without `QABOARD_WEBHOOK_SECRET`, anyone who can reach the server can send fake push events to `/webhook/gitlab` and `/webhook/github`: they make the server fetch repositories, and change the projects' git metadata.

*Mitigation*: set `QABOARD_WEBHOOK_SECRET`, and the same secret in the GitLab and GitHub webhooks. Until you do, the server warns about it when it starts, and in **Admin → Overview**.

### Accounts and sessions
- With `QABOARD_LOGIN_TYPE=LOCAL`, anyone can sign up unless you turn off `auth.local_signup`, or use LDAP or SAML (local sign-up is then off by default).
- The default setup uses plain HTTP, so session cookies and API tokens can be sniffed on the network. Serve QA-Board over HTTPS, with `QABOARD_URL=https://…`: cookies then get the `Secure` flag.
- Tokens created before October 2026 ("legacy" tokens) can read, send results and act as their user (not use the admin API), and don't expire. Admins see them in **Admin → Tokens**; ask their owners to replace them.
- The rate limits on signing in, sign-up, `qa auth login` codes and SSO redirects are in the nginx configuration QA-Board ships (`services/nginx/conf.d/qaboard.conf`, and the chart's). If you use your own reverse proxy in front of the backend, add `limit_req` rules on `/api/v1/user/auth/`, `/api/v1/user/signup/`, `/api/v1/auth/device/code` and `/api/v1/auth/oidc/`.

### Other
- `POST /api/v1/webhook/proxy` calls the hosts listed in the integrations of the projects' `qaboard.yaml`: while anyone can send results (`ingest.auth` is `off`), anyone can add hosts there. Likewise, without a user, `POST /api/v1/jenkins/build/trigger` starts the Jenkins jobs those files list.
- Anyone who can reach the server can read the files it serves under `/s/`, unless you restrict them (see [user management](https://samsung.github.io/qaboard/docs/backend-admin/user-management#restricting-who-can-read-files)). Even then, the image server (IIIF, `/iiif/`) doesn't check permissions: anyone who can reach it can read the images it can decode in the folders mounted in it (`docker-compose.yml` used to mount the whole host filesystem, sites now mount their storage).
  *Mitigations*: mount only the storage folders in the image server's container, and don't expose `/iiif/` to untrusted networks.
- The example WebDAV configuration (`services/nginx/webdav.conf`) lets anyone who can reach the server read, write and delete files, without QA-Board's checks. It is only enabled where a deployment includes it.
- `GET /api/v1/export` lets logged-in users create links or copies of output files in most folders the server can write to.
- `GET /api/v1/output/<id>/manifest` doesn't require a login: it writes `manifest.outputs.json` in the output's folder, and returns the list of files in it.
- Inside the backend container, `fs_utils.as_user` passes results between processes using a world-writable temporary file read with `pickle`.


## Using the API from scripts

Actions like redo, tuning or deleting results need a signed-in user. To use them from scripts:

1. Run `qa auth login`, and approve the code in your browser: `qa` then sends its token. `qa auth token` prints it, e.g. for `curl -H "Authorization: Bearer $(qa auth token)"`.
2. Or create a token in the web app, in **Settings → Access tokens**, with only the scopes and projects it needs, and set it as `$QABOARD_TOKEN` (in CI, as a protected secret).

Tokens are stored hashed on the server and shown once. `qa auth login` saves its token in `~/.config/qaboard/hosts.yaml`, readable only by you. Tokens are never read from the shared `$QA_SECRETS` file (the older `QA_TOKEN` in `~/.qaboard/secrets.yaml` still works). Treat tokens like passwords: anyone holding one can act as you, within its scopes. Revoke them in **Settings → Access tokens**, or with `qa auth logout`.
