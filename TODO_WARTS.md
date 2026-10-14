# Warts: further fixes

Found while surveying the code base (October 2026), after the cleanups that change no behaviour
(dead code, unused imports, typos: see the git log). Everything here is a **follow-up**.

- Tags: effort **S** (an hour) / **M** (a day) / **L** (more), and whether the fix changes **behaviour/API**
  (*no change*, *behaviour* = what users or admins observe, *API* = HTTP routes/params/responses, CLI flags, qaboard.yaml).
- Within each section, items are ordered by value/effort. Line numbers are as of October 2026: search for the quoted code if they drifted.
- Not repeated here: [docs/known-issues.md](docs/known-issues.md) (site-specific code, ops, EOL images, migrations)
  and [webapp/TODO.md](webapp/TODO.md) (viewers to check, dependencies, class components).

## Top 10

1. **`qaboard_clean` applies the first project's settings to all projects** (clean.py:252-253). [S, behaviour]
2. **LDAP login: an empty password may log in as anyone, the login is injected in the LDAP filter** (api/auth.py:379-391). [S, behaviour]
3. **Logged-in users can make the server send any HTTP request** (`/api/v1/webhook/proxy`, `/api/v1/git/proxy`),
   and anyone can trigger Jenkins builds with the server's credentials (api/integrations.py). See "Left after the git-hosts and performance changes". [S, API]
4. **Anonymous requests can block uwsgi workers forever** (api/tasks.py:20-24). [S, API]
5. **Anonymous requests write PDF reports anywhere and read any image** (api/image.py:123-126,167-182). [S, API]
6. **Every `POST /api/v1/batch` overwrites the commit's qaboard.yaml with the client's** (api/batch.py:50-58, and models/CiCommit.py:272 for projects). [S, behaviour]
7. **`qaboard_clean` never deletes artifacts, nor commits that never had outputs** (clean.py:264, 307). [S, behaviour]
8. **`qa get` is broken on Python ≥ 3.13, and CI only tests 3.11 while the backend image runs 3.13** (qaboard/qa.py:170-179, .github/workflows/ci.yaml). [S, behaviour]
9. **The server process runs with `umask 0` after the first manifest refresh** (models/Output.py:370), and other `os.umask(000)` windows race between threads. [S, behaviour]
10. **docker-compose.yml publishes RabbitMQ (guest/guest), Flower and pgadmin on all host interfaces** (docker-compose.yml:131-132,147,226). [S, behaviour]

## Security

- **LDAP** (api/auth.py). [S, behaviour]
  - `simple_bind_s(certificate, password)` (391) with an empty password is an *unauthenticated bind*: many LDAP
    servers accept it, so anyone knowing a user name logs in. Reject empty passwords before binding.
  - `ldap_user_filter.replace("{login}", user_name)` (379) without `ldap.filter.escape_filter_chars`: `*` or `)(`
    in the login change the search, and the first match is used. Escape it.
  - `search_s(...)[0][0]` (385) raises `IndexError` (500) for unknown users instead of returning `invalid-username`.
  - No LDAPS/StartTLS (372): passwords go in clear to the LDAP server. Support `ldaps://` or `start_tls_s()`.
- **Celery task endpoint** (api/tasks.py:20-24): `POST /api/v1/task/celery/<id>` needs no login, and loops
  `while result.status == "PENDING": sleep(1)` with no timeout: without a free worker, each call ties a uwsgi
  worker forever (compose runs 2). Add `@login_required` and a deadline. [S, API]
- **Image endpoints** (api/image.py): `GET/POST /api/v1/output/diff/report` (167) needs no login, `mkdir`s and writes a PDF in
  `data['output_dir_url_new'][2:]/reports` without `check_storage_path`, and its `report_url` has a double slash (`/s//algo/...`).
  `/api/v1/output/image/pixel` (123) and `/image/diff` (149) read any image the server can read (`url_to_dir` of a client URL).
  Add `@login_required`, `check_storage_path` for writes, and restrict reads to the storage roots. [S, API]
- **`QABOARD_LOGIN_REQUIRED` is only enforced by the web app** (api/api.py:55, webapp/src/components/authentication/PrivateContent.jsx:21):
  the API and `/s/` files stay readable anonymously, while website/docs/backend-admin/managing-users.mdx:59 says it
  "blocks anonymous users from accessing any content". Enforce it in a `before_request` (and nginx `auth_request` for `/s/`), or fix the docs. [M, behaviour]
- **Project permissions are only checked on some reads** (`is_authorized_user`, api/auth.py:272): `GET /api/v1/output/<id>`,
  `/manifest`, `/api/v1/tests/groups`, image endpoints and `/s/` ignore `QABOARD_LOGIN_RESTRICTED_YAML`. [M, API]
- **Local signup can squat LDAP/SAML user names** (api/auth.py:83-104, 331-336): signup is on unless `QABOARD_DISABLE_SIGNUP=True`,
  and `auth()` (328-336) uses the local password for any user stored as `LOCAL`. Someone can sign up with the name of an LDAP user who never
  logged in, and keep that account. Disable local signup when `QABOARD_LOGIN_TYPE` is LDAP/SAML. [S, behaviour]
- **SAML open redirects** (api/auth.py:503,518, flagged by TODOs): validate `RelayState`/SLO URLs against the server's host. [S, behaviour]
  After a successful ACS without `RelayState`, the code falls through to "Handle bad requests" and answers an empty 403 (520).
- **Error messages echo user data** (api/auth.py:347,417,491): `user_info{...}` includes LDAP/SAML attributes. Log them, return a plain message. [S, API]
- **Stored XSS**: `forms.jsx:531` renders the server's `message` as HTML, built with f-strings from DB paths (api/tuning.py:143-171);
  `viewers/html.jsx:30-33` renders output HTML files in the app's origin; `OutputCard.jsx:567-570` renders error responses as HTML.
  Escape the tuning message (or send text), and render user HTML in a sandboxed `<iframe srcdoc>`. [M, behaviour]
- **API tokens** (models/User.py:64-99, api/auth.py:219,227): stored in clear in the database, accepted in `?token=` (ends up in access logs),
  and `login_user(user)` in the request loader also sets a session cookie for token requests. Store a hash, prefer the header. [M, behaviour]
- **Webhooks are accepted unauthenticated by default** (no `webhook_secret` in `QABOARD_GIT_HOSTS` and `QABOARD_WEBHOOK_SECRET` empty,
  `receive_push` in api/webhooks.py): warn at startup, or require a secret for new hosts. [S, no change]

## Backend: bugs

- **`qaboard_clean` settings leak between projects** (clean.py:252-253): `before` and `can_delete_reference_branch` are the CLI
  arguments *and* the loop variables, so after the first project, every project uses the first one's `storage.garbage.after`
  (or `1month`), and once a project allows deleting its reference branch, all the following ones do. Data can be deleted earlier
  than configured. Use per-project local variables. [S, behaviour]
- **`qaboard_clean` filters** (clean.py:263-266, 305-310): `bool(CiCommit.latest_output_datetime) and ...` is evaluated by Python, so the
  filter is only `latest_output_datetime < threshold`: commits that never got outputs are never cleaned. Use
  `func.coalesce(CiCommit.latest_output_datetime, CiCommit.authored_datetime) < threshold`.
  `if undeleted_commits_from_subprojects:` tests a `Query` object, always true: artifacts are never deleted, and the commit is skipped.
  The query also matches the commit itself; use `.filter(CiCommit.id != commit.id).first()`. [S, behaviour]
- **Batch POSTs overwrite the commit's config** (api/batch.py:50-58): `if attr not in ci_commit.data` checks `qaboard_config` but
  stores `qatools_config`, so it's always true: each `POST /api/v1/batch` (e.g. `qa --share` runs with a locally edited qaboard.yaml)
  replaces the commit's config and metrics, and per-batch overrides (58) are never saved. Check `attr_backward_compat`. [S, behaviour]
- **Tuning groups without `?commit=`** (api/tuning.py:179): `ci_commit` is only defined when a commit is given: `NameError` (500).
  The same line mutates the commit's JSON column in place. Use the project's config, and copy before changing it. [S, behaviour]
- **Tuning `qa batch --list`** (api/tuning.py:205-216): no `timeout` (a slow entrypoint holds a worker), and `process` is unbound in the
  `except` if `subprocess.run` raises (e.g. missing cwd): `UnboundLocalError`. [S, behaviour]
- **`commit_sha` without `git_commit_sha`** (api/commit.py:24, api/outputs.py:120,145): `data.get('commit_sha', data['git_commit_sha'])`
  evaluates the default first, so clients sending only `commit_sha` get a 400. Use `data.get('commit_sha') or data['git_commit_sha']`. [S, API]
- **`as_user` kills the worker** (fs_utils.py:111): when the forked child fails, the *parent* calls `os._exit(1)`, killing the uwsgi
  worker mid-request. Raise instead. It also leaks a temp file per call (77) and never closes the pickle files. [S, behaviour]
- **Process-wide umask** (models/Output.py:370): `update_manifest()` sets `os.umask(0)` for good, so every file the server creates
  afterwards is world-writable. `api/tuning.py:455,482`, `api/export_to_folder.py:207`, `models/Output.py:295` change it temporarily,
  racing with other threads. Use explicit `mode=`/`chmod` on what we create. [S, behaviour]
- **Process-wide `chdir` in the server** (qaboard/conventions.py:75, called by api/tuning.py:93-108 via `batches_files`): other threads
  see the cwd change, and it isn't restored if `iglob` raises. Use `glob(root_dir=...)` (Python ≥ 3.10). [S, no change]
- **Retry that can't work** (api/image.py:75-81): after a failed `json.load(f)`, the retry reads from the same exhausted file object. `f.seek(0)` or reopen. [S, behaviour]
- **Matching outputs by input id** (api/export_to_folder.py:104-110): `compatible()` returns `False` when both inputs have the same id, and
  `None` otherwise: probably meant `True`. [S, behaviour]
- **Deleting files of an output** (models/Output.py:330,341): `rm_empty_parents(output_dir)` after each file checks the output folder's
  parents (never empty), not the file's: empty sub-folders stay, and it costs `iterdir()` calls per file. Use `rm_empty_parents(output_file)`. [S, behaviour]
- **Duplicate outputs** (models/Output.py:187-208): on `MultipleResultsFound`, rows are deleted (their files stay) and a new output created. Keep the newest instead. [S, behaviour]
- **`hybrid_cache`** (hybrid_cache.py:33-35): the thread-local cache ignores `maxsize` and the TTL (grows for the worker's life), and keys
  only use the function name. Use `cachetools.TTLCache`, key with the module. [S, behaviour]
- **`QABOARD_DB_ECHO=0` / `QABOARD_LOGIN_RESTRICTED=false` enable the feature** (database.py:20, api/auth.py:25): `bool("false")` is true.
  The docs say "any non-empty value", so this is documented, but surprising. Parse booleans. [S, behaviour]
- **Dead psycopg2 JSON loaders** (database.py:25-26): `loads=lambda x: ujson.loads` returns the function, not the data. SQLAlchemy
  registers its own loaders per connection, so only raw psycopg2 connections would see it. Delete both lines. [S, no change]
- **`find_rois` ignores `threshold` and `diameter`** (api/image_diff.py:103): the request still sends them. Remove them from the API or implement them. [S, API]
- **Time zones**: `datetime.now()` (api/tuning.py:406) vs `utcnow()` elsewhere for `latest_output_datetime`; `utcnow()` is deprecated. [S, behaviour]
- `delete` of a milestone with an unknown key is a `KeyError` (500) (api/milestones.py:50); a body-less `GET` is a 400. [S, API]
- `clean_big_files.py` deletes every file > 1GB of the last 6 months' outputs **on import** and writes to a hardcoded home directory:
  move it to `scripts/` behind a `__main__` guard, or delete it. Same for `backend/restore_artifacts.py`. [S, no change]

## Backend: API conventions

- Errors come in many shapes: `{"error": ...}` JSON, plain text (`"404 ERROR:\n Not found"`, api/batch.py:121,133,173,191),
  JSON-looking strings with a `text/html` content type (`'{"status": "OK"}'`, api/batch.py:143,161,181; `json.dumps(...)`,
  api/export_to_folder.py), and bare strings (`jsonify("Sorry...")`, api/tuning.py:139,401). Return `jsonify({"error": ...})` everywhere,
  keeping the keys clients read. [M, API]
- Status codes: "not found" is 400 (api/outputs.py:21,36,82,99), "please wait" is 500 (api/outputs.py:63), a duplicate label is 403
  (api/batch.py:159), `except:` → 404 hides real errors (api/batch.py:33, api/commit.py:116-121). Use 404/409/400, and let 500s be 500s. [S, API]
- `GET` endpoints with side effects: `GET /api/v1/commit/<ref>` creates commits from git refs (api/commit.py:106-120),
  `GET .../manifest` writes manifests (api/outputs.py:103), `/api/v1/tests/group` creates projects (api/tuning.py:118). [M, API]
- `json.loads(request.args['metrics'])` returns 500 on bad input (api/commit.py:129). [S, API]
- `assert` used for control flow (api/commit.py:80,98, api/batch.py:157): it is skipped with `python -O`. [S, no change]
- `save-artifacts` matches projects with `startswith` (api/commit.py:150): `foo` also matches `foobar`. Compare path segments. [S, behaviour]

## CLI

- **`qa get` on Python ≥ 3.13** (qaboard/qa.py:170-179): PEP 667 makes `locals()` a snapshot, so
  `locals().update(...)` has no effect and `qa get commit_id` prints "Could not find commit_id". The backend image runs 3.13.
  Use an explicit dict. On 3.13, 6 tests of tests/test_cli*.py fail at master: 3 from this, 3 with a missing cwd (not investigated,
  maybe a consequence). All pass on 3.11. [S, behaviour]
- **`_Repo`/`_Commit` wrappers** (qaboard/git.py:141,155,171): `object.repo_root`/`object.commit_id` raise `AttributeError`
  instead of the intended `ValueError`, and `_Commit.init` uses `repo.commit(...)` when there is *no* commit id, `head.commit`
  otherwise (inverted). Careful: `__getattribute__` raising `AttributeError` makes `hasattr()` return False, callers may rely on it. [S, behaviour]
- **`git_head` in worktrees** (qaboard/git.py:83-114): it follows `.git` files for `HEAD`, but reads refs from `repo_root/.git`, so in
  a `git worktree` the commit id is the branch name. Use `git rev-parse HEAD`. [S, behaviour]
- **`RunContext.configs`** (qaboard/run.py:192) returns `self.extra_parameters` (still with `_configs`) instead of the popped copy. [S, behaviour]
- **XDG/Windows inverted** (qaboard/check_for_updates.py:47-53): Linux reads `%LOCALAPPDATA%`, Windows `$XDG_CONFIG_HOME`.
  `to_ints` (88) crashes on versions like `1.2.3rc1`. [S, behaviour]
- **`notify_qa_database` error path** (qaboard/api.py:176-200): if serialization fails, `json.loads(data)` gets a dict (TypeError).
  No request has a `timeout` (179,206,230): a hung server blocks CI jobs forever. [S, behaviour]
- `print('Called')` in every function decorated with `@on_branch` (qaboard/ci_helpers.py:56); `run_tests() -> int` returns a bool. [S, behaviour]
- `LocalRunner.stop_jobs` returns the `NotImplementedError` class instead of raising (qaboard/runners/local.py:54). [S, no change]
- Leaks: `yaml.load(open(...))` (qaboard/iterators.py:208), the `NamedTemporaryFile` in `file_info` on Windows (qaboard/utils.py:278-284),
  `RedirectStream.__del__` restores `sys.__stdout__` rather than the previous stream (qaboard/utils.py:78). [S, no change]
- `exit()` (the `site` builtin) instead of `sys.exit()` in library code (qaboard/utils.py, run.py, ci_helpers.py). [S, no change]
- `requires-python = ">=3.7"` (pyproject.toml:20) while the code uses `Path.is_relative_to` (3.9) and CI tests 3.11: see known-issues. Raise it. [S, behaviour]

## Webapp

- **Plotly "Send to Cloud" is still on in the tuning exploration** (webapp/src/components/tuning/TuningExploration.jsx:15-16):
  webapp/TODO.md's item was fixed for SlamOutputCard only. Set `showSendToCloud: false`, drop `plotlyServerURL`. [S, behaviour]
- `style={{dispay: "inline"}}` (webapp/src/viewers/images/images.jsx:980) is a typo, so the div is a block. Fix it and check the layout. [S, behaviour]
- 23 oxlint warnings left (`npx oxlint`): a11y (empty `<td>`/`<th>` in tables.jsx, captions in videos.jsx, clickable `div`s in images/tooltip.jsx and components/integrations.jsx, `role="img"` in App.jsx),
  `setState` in effects (releaseNotes/ReleaseNotes.jsx, images/roi_viewer.jsx) and missing hook deps (roi_viewer.jsx:69, tooltip.jsx:127).
  Then make `no-unused-vars` an error. [M, no change]
- Dead docs in src/: `src/todo.md`, `src/viewers/todo-image-viewers.md` (mentions internal hosts). Merge into webapp/TODO.md or delete. [S, no change]

## Deployments, services, charts

- **Exposed services** (docker-compose.yml): RabbitMQ (131-132) with `guest:guest`, whose workers run shell commands; Flower (147),
  which can revoke tasks and shut workers down; pgadmin (226) with a default password and a passfile for the database. Use `expose`
  or bind to `127.0.0.1` by default, and let overlays publish them. [S, behaviour]
- **nginx forwards no `X-Forwarded-*` headers to uwsgi** (services/nginx/conf.d/qaboard.conf:34-46): `proxy_set_header` doesn't apply to
  `uwsgi_pass`, so SAML's `prepare_flask_request` (api/auth.py:530) sees none. Use `uwsgi_param HTTP_X_FORWARDED_PROTO $scheme;` etc. [S, behaviour]
- Cantaloupe mounts `/` (docker-compose.yml:201, already flagged INSECURE): mount only the storage roots. [S, behaviour]
- The default database password is `password` (docker-compose.yml:59, database.py:16): read it from the env file like `SECRET_KEY`. [S, behaviour]
- Default celery broker URL with credentials in code (api/tuning.py:299). [S, no change]

## CI, tests, tooling

- **Test the CLI on the Python the images use** (3.13) in .github/workflows/ci.yaml, not only 3.11. [S, no change]
- flake8 only checks `E9,F63,F7,F82` (.flake8). After this pass, 57 F401/F811/F841 are left outside alembic and the `__init__` re-exports,
  clean them,
  then add `F401,F811,F841` (or use ruff with `F,B`). `ruff check --select B` also finds the issues above (B023 in clean.py:94,178). [S, no change]
- Mixed line endings: 69 files are CRLF (`git ls-files --eol | grep crlf`, e.g. api/export_to_folder.py, qaboard/run.py, AppSider.jsx).
  Normalize them with a `.gitattributes` (`* text=auto`) in one commit. [S, no change]
- tests/test_runners.py `TestCleanOutputDir.test_removes_everything_when_not_redirected` depends on how the runner captures stderr
  (it failed once locally with green, passed on a rerun). [S, no change]

## Docs

- website/docs/storage/deleting-old-data.mdx describes per-project `storage.garbage.after`, which `qaboard_clean` doesn't honour
  (see Backend), and says artifacts can be deleted (they never are). Update after fixing. [S, no change]
- website/docs/backend-admin/managing-users.mdx:59 overstates `QABOARD_LOGIN_REQUIRED` (see Security). [S, no change]
- backend/README.md:7, MIGRATION.md:9, drafts/ use internal git hosts; the public README should point to GitHub. [S, no change]

## Left after the git-hosts and performance changes

The git-hosts and performance changes (same PR) fixed: the broken `rmtree` import and unrepaired clones, tokens in clone URLs and logs,
non-JSON webhook answers and printed payloads, tag pushes, the hardcoded SIRC avatar host, gravatars from names, GitHub avatars from
a search by name, `with_outputs` being ignored, the per-batch N+1 queries, `latest_successful_commit` loading outputs, per-project
`is_authorized_user` lookups, the unreachable code in `Batch.stop`, the integrations.jsx lint warnings and the nested `<a>` in the
projects list. What's left:

### Git hosting
- **Project config flip-flops** (backend/backend/models/CiCommit.py:272): `is_initialization = not project.data or 'qatools_config' not in data`
  tests the request (which has `qaboard_config`), so it's always true: any `qa --share` run replaces the project's qaboard.yaml.
  Test `project.data`. [S, behaviour] Line 282: `data['project_root']` is a `KeyError` for old clients. [S]
- **SSRF** (backend/backend/api/integrations.py): `POST /api/v1/webhook/proxy` sends any method/URL/headers/body for a logged-in user,
  with `verify=False`, and copies back all response headers (incl. `Set-Cookie`); `GET /api/v1/git/proxy` (and its old name
  `/api/v1/gitlab/proxy`) fetches any URL. Allow-list hosts (configured git hosts, the project's integrations), drop hop-by-hop and
  cookie headers. [M, behaviour]
- `jenkins_build_trigger` (api/integrations.py:470) has no `@login_required`, and defaults the build token to `"qaboard"`. [S, API]
- `POST /api/v1/github/workflow` and `/api/v1/gitlab/job` (status) are unauthenticated and use the server's token: anyone who can reach
  the server can read CI job details of any repository the token sees. Require a login, or check the repo is a known project. [S, API]
- GitLab session cookies are fetched at import time (api/integrations.py, `GITLAB_AUTH`): a slow GitLab delays every worker start. [S]
- `delete_commit` (api/webhooks.py) returns after the first matching commit, so without `project_id` other projects' batches are kept;
  `except Exception` → 404 hides errors. [S, behaviour]
- Clones made before this change still have the token in their remote URL (`.git/config`): strip it with
  `git remote set-url origin <url without credentials>` once, e.g. in a one-off script over `QABOARD_DATA_GIT_DIR`. [S]
- Header authentication needs git ≥ 2.31 on the backend image (fine for the current images, check custom ones). [S]
- `milestone_commits` (models/Project.py:105) runs git commands on every access, and is used in loops (clean.py, webhooks). [M]
- Gitea's avatar URL, the Bitbucket signature header and the Gitea/Bitbucket payload fields were written from their docs and tested on
  sample payloads only: check them against real servers. [S]
- Project ids and clones are not qualified by host: two hosts with the same `group/repo` share a project. Tokens are shared by all
  users (no per-user OAuth). See docs/git-hosts-roadmap.md. [L, behaviour]
- If `QABOARD_GIT_HOSTS` points to a file the kubernetes migration Job doesn't mount, the backend fails to import, and `migrate.sh`'s
  fallback to `alembic stamp` silently skips the migrations (see docs/known-issues.md about that fallback). [S]
- qaboard/config.py:209 prints an internal Jenkins URL. [S]

### Performance
- **History page with outputs** is still ~2 s and ~19 MB for 25k outputs (backend/benchmarks/bench_api.py): building ORM objects and
  `Output.to_dict`. Serialize from SQL rows (no ORM), or paginate/stream outputs. [M]
- Commit search uses `ILIKE` over the project's commits (~40 ms for 5k commits). For projects with 100k+ commits, add `pg_trgm` GIN
  indexes on `message`/`branch` (needs `CREATE EXTENSION pg_trgm`). [S]
- `Output.metrics` is a JSON (text) column: aggregations parse it for every key. Converting it to JSONB (big table rewrite) would make
  aggregations and filters on metrics much cheaper. [L]
- `ix_ci_commits_project_id` is redundant with the new `(project_id, authored_datetime)` index: drop it in a later migration. [S]
- `GET /api/v1/project` with an unknown id is a 500 (`.one()`, api/api.py:338); invalid `metrics` JSON is a 500 in `/api/v1/commits`;
  `datetime.now()` localized as UTC is wrong on hosts not in UTC. [S, behaviour]
