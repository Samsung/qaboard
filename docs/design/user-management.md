# User management: design and plan

Status: proposal v1 (2026-10-20), for review. Scope: sign-in, users, groups, organizations, project access,
tokens, the `qa` CLI login, CI ingest, audit, admin panel, user preferences.
Builds on [http-upload.md](http-upload.md) §6 (token model, `QABOARD_INGEST_AUTH`) and supersedes it where they differ.
Line references are to this branch's tree.

## TL;DR
- **One request, one actor.** A `before_request` hook resolves who is calling (session cookie, API token, or
  nobody) once. Every endpoint then asks one function, `authorize(actor, permission, project)`. Default-deny when
  sign-in is required, with an explicit allow-list. Today each endpoint checks (or forgets to check) on its own.
- **Several sign-in methods at once**: local passwords, LDAP, SAML (kept), and **OIDC** (new: Entra ID/ADFS, Keycloak,
  Okta, Google, GitLab). Each method is a *provider* stored in the database. An account has several *identities*
  (provider + subject), so accounts are no longer keyed on user names: that fixes user-name squatting.
- **Settings live in the database, bootstrapped from the environment** (the Metabase model): env > database > default,
  and the admin panel shows where each value comes from. Today's env vars keep working.
- **Roles per project: `viewer`, `developer`, `owner`**, plus instance **admins**. Roles are granted to users, groups
  or service accounts, on a namespace or a project, and **inherited by sub-projects**. **Visibility**
  (`private` / `internal` / `public`) says what people without a grant get.
- **Groups** come from LDAP or SSO attributes through mapping rules, synced at sign-in (and on a schedule for LDAP).
  This replaces `QABOARD_LOGIN_RESTRICTED_YAML`, which we import once and keep reading until then.
- **Namespaces**: every user gets one, and **organizations** are namespaces with members. Projects belong to a
  namespace. Existing projects keep their ids. Their first path segment becomes an organization, and new projects
  can live under the user's or an org's namespace, decoupled from git paths.
- **Tokens done properly**: prefixed (`qab_pat_…`), hashed (sha256), shown once, with name, **scopes**
  (`read`, `ingest`, `act`, `manage`, `admin`), **project restrictions**, expiry (long-lived allowed by policy),
  idle expiry, last-used, revocation. A token never has more rights than its owner has *now*.
  **Service accounts** (bot users owned by an org) carry CI tokens.
- **`qa auth login`**: the OAuth device flow (like `gh`, `az`, `gcloud`). It works over SSH on compute servers. It
  stores a token **per server, in the user's config dir** (`~/.config/qaboard/hosts.yaml`), never in the project.
  `QABOARD_TOKEN` in the environment for CI.
- **Ingest stays open by default**, but every run records **who really sent it** (a verified token) next to **who it
  claims to be** (`QA_USER`). `QABOARD_INGEST_AUTH=off|warn|token` per instance, stricter per project. Later,
  GitHub/GitLab **OIDC tokens** let CI upload without any stored secret.
- **Access requests** with notifications (email, in-app, optional chat webhook), from the sign-in page, a 403 page or a
  project. **Audit log** of security events. **Admin panel**: users, requests, groups, sign-in, tokens, audit, settings.
- **User preferences** move to the server (`users.preferences`), synced with the web app's local store.
- **Plan**: six milestones (§13). **M1** (3-4 intense sessions) lays the foundations every later step needs: actor
  and default-deny, the token rework, audit, bootstrap admins, settings, preferences, admin panel v1, and `qa auth login`.

---

## 1. Where we are (verified)
I ran the backend test suite (516 passed, 1 skipped) and booted the real app against PostgreSQL 16. Signup, login and
`/user/me` work, and so do milestones (create, favorite, list, delete, anonymous create refused with 401) and API
tokens (`POST /user/token/` → `Authorization: Bearer` → `/user/me`). I also migrated down past the milestones
migrations (`downgrade e7f3b2a91c40`) and back up to head (`f2c8d4a6b1e9`). **Users and milestones work.** What's
missing is the model around them:

- **Identity**: `users` has `user_name` (unique), `email`, `password`, `login_type` (one per user) and raw
  LDAP/SAML attributes in `data` (models/User.py:13-53). There are no admins, roles, groups or status. One login type per
  server (`QABOARD_LOGIN_TYPE`). Accounts are matched by user name, so a local signup can take an LDAP user's name
  (TODO_WARTS.md:50).
- **Sessions**: flask-login with a 180-day remember cookie (api/auth.py:143). No cookie flags (`Secure`, `SameSite`).
  `CORS(app)` is open (backend/\_\_init\_\_.py:81). No server-side sessions, so sessions can't be revoked.
- **Authorization**: `QABOARD_LOGIN_REQUIRED` is only enforced by the web app (TODO_WARTS.md:40). Project rules come
  from a YAML file read at startup (`login:`, `projects:` by id prefix, `paths:`; api/auth.py:34-43, 315-380). They're
  checked on some reads only (TODO_WARTS.md:48). Every signed-in user can do everything else (redo, delete batches...).
- **Tokens**: stored in clear, accepted in `?token=`, never expire, no scopes. A token request also opens a session
  (models/User.py:56-91, api/auth.py:248-264).
- **Ingest** (`POST /output`, `/batch`, `/commit`) is anonymous. The CLI sends `user = $QA_USER or getpass.getuser()`
  (qaboard/config.py:157) and `QA_TOKEN` if set (qaboard/api.py:51-55).
- **User names are strings across the data**: `Output.data.user`, `CiCommit.committer_name`, `Batch.data.commands[].user`,
  `BatchNotification.user_name`, storage `{user}` placeholders. At SIRC, `user_name` *is* the Unix login: LSF jobs,
  storage paths and the file browser's Unix permissions depend on it.
- **Projects**: string ids (`group/repo[/subproject]`), created on the first ingest or push webhook. Sub-projects
  relate to their parent by string prefix only (models/Project.py:57-85). There are no owners.
- **Web app**: one login dialog per login type (components/authentication/Auth.jsx), preferences in localStorage
  (`qaboard-prefs`, stores/prefs.js). No settings page, no admin page.
- **EMMA** (our other app, `backend_v2/`) has OIDC + LDAP, default-deny with an allow-list, hashed prefixed tokens with
  live roles, LDAP group → role sync at login and daily, an audit log, an admin panel and preferences on the server.
  It has no access requests, no settings in the database, and no first-admin bootstrap. We reuse its lessons (§12).

## 2. Principles
1. **Default deny, one place.** Resolve the actor once and authorize through one function. A test fails if a route
   declares no access policy.
2. **Credentials carry identity, not rights.** Sessions and tokens point to a user. Rights are computed live from
   grants, so revoking a grant or disabling a user takes effect at the next request. Token scopes can only narrow.
3. **The identity provider says who you are. Group mappings, which admins see and edit, say what you may do.**
   Directory groups and SSO attributes feed groups through explicit rules. Nobody gets rights from a claim by surprise.
4. **Nothing silent.** Every refusal says why and what to do ("Ask an owner: Alice, Bob. [Request access]"). Every
   security change is audited.
5. **Compatible by default.** Existing deployments keep today's behaviour after the migration (internal projects,
   signed-in users can work, open ingest). Admins tighten it when they're ready, from the web app.
6. **Simple enough to audit.** Three roles, five token scopes, a short permission table in code. Grants are rows
   anyone can list. No custom role editor, no ABAC language.
7. **Don't block the cloud.** Namespaces own projects, so quotas, plans and billing can attach to them later.
   Nothing in the core assumes users are Unix accounts.

## 3. Concepts
| Concept | What it is |
|---|---|
| **User** | A person (`kind=human`) or a **service account** (`kind=service`, a bot owned by a namespace, signs in with tokens only). Status: `active`, `pending`, `disabled`. |
| **Identity** | A way a user signs in: (provider, subject). A user can have several, e.g. LDAP and OIDC. |
| **Provider** | A configured sign-in method: `local`, `ldap`, `oidc`, `saml` (later `github`). Several can be enabled. |
| **Group** | A set of users. Membership is manual, or synced from a provider through rules (LDAP group, OIDC `groups` claim, email domain...). Built-in: `everyone` (all active signed-in users). |
| **Namespace** | A path that owns projects: a user's (`alice`) or an **organization**'s (`camera-algo`). Users and orgs share one path space, like GitHub. |
| **Project** | Today's projects. Sub-projects (`group/repo/sub`) inherit their parent's access. |
| **Role** | `viewer` < `developer` < `owner`, on a namespace or a project. Instance **admins** are implicitly owners everywhere. |
| **Grant** | (subject: user / group / service account) has (role) on (instance / namespace / project), from (source: manual, sync, import). |
| **Visibility** | Per namespace or project: `private` (grants only), `internal` (every signed-in user is a viewer), `public` (anonymous viewers too, needs an instance setting). |
| **Token** | A credential for a user or service account: scopes, project restrictions, expiry. |
| **Access request** | "Let me in" (instance), "give me a role" (project or namespace), "create this namespace". Reviewed by admins or owners. |
| **Audit event** | Who did what to whom, when, from where. |
| **Setting** | A key with a value from env, the database or a default. |

## 4. Sign-in

### 4.1 Providers
- Stored in a `auth_providers` table: `id` (slug, used in URLs), `type`, `name` shown on the button, `icon`, `enabled`,
  `position`, `config` (JSON, no secrets), `secrets`. Each provider also has its own access policy (§4.4) and claim mapping.
- **OIDC is the recommended SSO.** Authorization Code + PKCE + nonce, handled by the backend (the browser never sees
  provider tokens). One generic type with presets that pre-fill the discovery URL and claim names: Microsoft Entra ID
  and ADFS (Samsung), Keycloak, Okta, Google, GitLab. Library: **Authlib** (maintained, does discovery, JWKS caching,
  PKCE). EMMA wrote its own on `node:crypto`; in Python, Authlib is the safer choice.
- **SAML stays** (SIRC uses it), moved into a provider row. Its settings directory becomes the provider's config.
  New installs should prefer OIDC.
- **LDAP**: fix the open items (LDAPS/StartTLS, no `IndexError` on unknown users, attributes namespaced in
  `identities.claims`, not top-level `users.data`). It's a password provider, like `local`.
- **Local passwords**: kept for small installs and break-glass admins. Self-signup is **off by default as soon as
  another provider is enabled** (fixes squatting). Hashes move to scrypt (werkzeug's default) and are upgraded on login.
  Email verification, password reset and MFA (TOTP, passkeys) are for the cloud milestone (M6): they need outbound email.

### 4.2 Identities and account linking
- `user_identities(user_id, provider_id, subject, …)`, unique on (provider_id, subject). For OIDC the subject is
  `sub`, for SAML the NameID, for LDAP the `entryUUID`/`objectGUID` (or the DN when the server doesn't have one).
- A **new identity links to an existing account only** when (a) the user is signed in and adds it from
  *Settings → Sign-in methods*, or (b) the provider is marked `trust_email` and its verified email matches. **Never by
  user name alone.**
- **Migration**: today's users get an identity from their `login_type`, marked `legacy`. Its subject is the user name.
  At their next sign-in through that provider it's upgraded to the stable subject.
- **User names** are picked from a claim (`preferred_username`, `sAMAccountName`, or the email's local part), must be
  unique, and can't be changed by users for now: at SIRC they are Unix logins (storage `{user}`, LSF, file permissions).
  A provider can say `username_is_posix: true`. For the cloud we add a separate `posix_name` later, and nothing
  else in the core depends on it.

### 4.3 The sign-in page
- `GET /api/v1/auth/providers` lists the enabled providers: id, type, name, icon, `recommended`.
- **SSO buttons first**, the recommended one highlighted. Then "or", then **one username/password form** for all the
  password providers: it tries the provider the account is linked to, else the password providers in order.
- **Auto-redirect** (setting): with sign-in required and a single SSO provider, `/login` goes straight to the IdP.
  `/login?local=1` is the break-glass escape hatch.
- **Return to where you were**: `?next=` is validated against our own origin, which fixes the SAML open redirects
  (TODO_WARTS.md:53).
- **Errors are codes plus sentences**, shown on the page:
  - `invalid_credentials`: "Wrong user name or password." Don't say which: on the internet that reveals user names.
    The `QABOARD_LOGIN_HINT` stays.
  - `pending_approval`: "Your account is waiting for an admin. We told them (Alice, Bob)." It links to the request.
  - `not_allowed`: "Your account can't use this server." The page offers *Request access*.
  - `disabled`, `provider_unavailable` ("SSO is down, sign in with your password"), `sso_expired` ("try again").
  - `sso_misconfigured`: "Ask an admin, reference 7f3a2c." The details go to the logs and the audit, under the same
    reference. Users never see claims or attributes (TODO_WARTS.md:55).

### 4.4 Who can get an account
An instance-wide `access.policy` setting, which each provider can override:
- **`open`**: any identity from an enabled provider gets an active account. This is today's behaviour and the default
  for existing installs.
- **`rules`**: active if a rule matches (email domain, group mapping, claim value), else `pending`. This is the
  default for new installs that set up SSO, e.g. "`@samsung.com` emails are in".
- **`approval`**: every new account starts `pending`.

Pending users can sign in. They see the pending page, with their request and who reviews it. Admins approve or deny
it in the admin panel or from the email link.

### 4.5 Settings: environment, then database
- A `settings(key, value JSONB, updated_by, updated_at)` table, read through `setting(key)`, which checks
  **env > database > default**. Values are cached for a few seconds per process, so every replica sees a change.
- The admin panel shows each setting with its source, and greys out the ones set by the environment.
- **Bootstrap variables**, which only come from the environment: the database settings, `SECRET_KEY`, `QABOARD_URL`,
  `QABOARD_ENCRYPTION_KEY`, and `QABOARD_ADMINS` (user names or emails that are always admins, the break-glass list).
- **Today's variables keep working.** `QABOARD_LOGIN_TYPE`, the `QABOARD_LDAP_*` and `QABOARD_SAML_*` variables
  appear as a read-only provider labelled "from the environment". `QABOARD_LOGIN_REQUIRED`,
  `QABOARD_DISABLE_SIGNUP` and `QABOARD_LOGIN_RESTRICTED_YAML` map to settings.
- **Secrets** (OIDC client secret, LDAP bind password):
  - Always possible as a reference to an environment variable (`client_secret_env: OIDC_SECRET`), which suits
    Kubernetes secrets.
  - Stored in the database only when `QABOARD_ENCRYPTION_KEY` is set, encrypted with Fernet. They are write-only in
    the UI ("set, last changed by X").
- **The first admin**:
  - `QABOARD_ADMINS`.
  - Or `qaboard-admin create-admin <user>` (a Flask CLI command run in the container).
  - Or, on a fresh install with no admin at all, a one-time setup link printed in the backend logs (like Jupyter).
    Never "the first user to sign up becomes admin": on the internet, that's a race.

## 5. Authorization

### 5.1 Roles and permissions
The permissions live in code, in one table, so a reviewer reads them in one place:

| Permission | viewer | developer | owner | Examples |
|---|:-:|:-:|:-:|---|
| `project.read` | ✓ | ✓ | ✓ | commits, runs, files, metrics, personal favorites |
| `runs.ingest` | | ✓ | ✓ | `qa run`/`qa batch` uploads, save-artifacts |
| `runs.act` | | ✓ | ✓ | redo, start batches or tuning from the web app, stop, rename, move or delete batches |
| `milestones.write` | | ✓ | ✓ | create milestones (they protect results from the cleanup), share them |
| `project.settings` | | | ✓ | metrics definitions, reference branch, retention (later, from the web app) |
| `project.access` | | | ✓ | grants, visibility, access requests, service accounts of the namespace |
| `project.delete` | | | ✓ | |

- **Three roles.** A `maintainer` (settings without access control) slots between developer and owner when someone
  needs it: roles are ordered levels in code, so adding one is a code change, not a migration.
- **Instance admins** are implicitly owners everywhere, plus the admin panel. It's simpler than EMMA's "no bypass",
  and fine for an on-prem support team. The UI says "as admin" and the audit records it.
- **Personal things don't need roles**: favorites, personal preferences, your own tokens.

### 5.2 Grants and inheritance
- `role_grants(subject_type, subject_id, resource_type, resource_id, role, source, granted_by, granted_at, expires_at)`.
  - `subject_type`: `user` or `group` (service accounts are users).
  - `resource_type`: `instance`, `namespace` or `project`.
  - `source`: `manual`, `sync:<provider>`, `import:yaml`.
  - `expires_at` allows temporary access, e.g. for contractors.
- **Effective role** of a user on project `a/b/c` is the highest of:
  - their grants and their groups' grants on `a/b/c`, `a/b` and `a`;
  - their grants on the namespace that owns the project (and its parent namespace, once namespaces nest);
  - their instance grants;
  - what visibility gives them.
- **Visibility is inherited too.** A project's effective visibility is the most restrictive of its own and its
  ancestors'. A sub-project can be more private than its parent, never more public.
- **Groups**: `groups(id, name, description, source)`, `group_members(group_id, user_id, source)` and
  `group_rules(group_id, provider_id, claim, values)`.
  - Rules are evaluated **at sign-in** from the identity's claims, e.g. `memberOf` contains
    `CN=camera-algo,OU=Groups,…`, or the OIDC `groups` claim, or the email domain.
  - The sync only adds and removes rows with `source=sync:*`. Manual memberships win.
  - LDAP can also re-sync on a schedule, to remove people who left. A failed lookup never removes anything.
  - IdP group claims are recorded in the sign-in audit event, so admins see what they could map.
- **Groups make revocation lag**: until the next sign-in or sync, a user keeps the memberships of their last sign-in.
  So SSO sessions are re-validated after `auth.reauthenticate_after` (default 7 days, sliding), and disabling a user
  is immediate.

### 5.3 Enforcement
- **`before_request`** resolves `g.actor`: a bearer token, else a session, else anonymous. It refuses disabled users
  and revoked or expired tokens with a 401 that says why. Token requests never open a session.
- When **sign-in is required**, `/api/` answers 401 except an explicit allow-list: health, config, auth endpoints,
  signed git webhooks, `files/authorize` (it does its own checks), and ingest when `QABOARD_INGEST_AUTH=off`.
  `/s/` is already behind nginx `auth_request`: we extend that check to project visibility.
- **`authorize(actor, permission, project_id)`** is the only check. It returns the decision and a reason, which the
  403 body carries along with the owners, so the web app can offer a request:
  `{"error": "...", "reason": "missing_role", "required": "developer", "owners": [...], "can_request": true}`.
- **Every route declares a policy**: `@requires("runs.act", project=from_batch)`, `@signed_in`, or `@public`.
  `tests/test_security.py` today only sees `app.route` (TODO_WARTS.md:40). It will check every
  `app.route/get/post/put/delete` for a declared policy.
- `login_required`, `require_project_access` and `is_authorized_user` stay as thin wrappers over `authorize` during
  the transition, so endpoints move one file at a time.
- **CSRF**: cookie-authenticated writes must have an `Origin` or `Referer` from our own origin (or a configured list).
  `CORS` is limited to that list too. Bearer requests are exempt. No CSRF tokens are needed, as in EMMA.

### 5.4 Compatibility with today
- The migration gives **every existing project `internal` visibility**. It also adds **one instance grant:
  `everyone → developer`**, which is today's behaviour: any signed-in user can redo or delete. Admins remove that
  grant when owners are in place. The admin panel's overview shows it as a recommendation.
- **`QABOARD_LOGIN_RESTRICTED_YAML`**:
  - Read as before until an admin runs **Import** (admin panel, or `qaboard-admin import-restrictions`).
  - The import turns `projects:` keys into `private` projects or namespaces with grants. Its `user_name`/`email`
    rules become user grants, and its `data.<attr>` rules become groups with rules.
  - `login:` becomes the `rules` access policy.
  - `paths:` stays a file setting (folders aren't projects) and is read through the same groups.
- **Projects without owners**: admins assign owners, or users ask "Request ownership" (§8). The first person who
  creates a *new* project (§6) becomes its owner.

## 6. Namespaces, organizations and project identity
- `namespaces(id, path unique, kind user|org, display_name, visibility, created_by, data)`.
  - Each user gets a personal namespace (`path = user_name`), created when it's first needed.
  - Org members are grants on the namespace: org owners manage it, developers can create projects in it.
- `projects` gets a `namespace_id`. **Project ids don't change**: they're foreign keys everywhere and part of storage
  paths.
  - The migration creates an **organization for each first path segment** of the existing project ids
    (`camera-algo/isp` → org `camera-algo`), flagged `legacy`, with no members.
  - When a first segment matches a user name, the namespace is still created as an org, and that user's personal
    namespace waits for an admin to rename one of them. The admin panel lists these collisions.
- **New projects** (setting `projects.create`):
  - `anywhere`: today's behaviour, the first ingest creates any project.
  - `own-namespaces` (recommended): the first ingest by user U to `ns/p` creates it only if U is a developer of
    `ns`, or `ns` is U's own namespace. Otherwise the error says how to ask for the namespace.
  - `admins`: only admins create projects.
- **Decoupled from git**:
  - `project_repos(project_id, git_host, repo_path, subdir)` links projects to repositories. A project can have
    several repositories, and git links are no longer encoded in the id.
  - `qaboard.yaml` keeps `project.name`. When it has no namespace (`name: isp`), the CLI uses the namespace from
    `project.namespace`, `$QABOARD_NAMESPACE` or the signed-in user, so a new user's first runs land in `alice/isp`.
  - Existing repos keep `group/repo`.
- **Request a namespace**: "Create an organization" is an access request reviewed by admins. With the
  `namespaces.create: anyone` setting, it's created right away.
- **Renames** (later): a `project_redirects` table, so old links keep working.
- **Aligning with GitLab/GitHub permissions**: I recommend **not** making the git host the source of truth.
  - With several hosts and repositories per project, one path no longer means one permission set.
  - Reading per-user permissions needs per-user OAuth, or an admin token and many API calls.
  - Git groups and QA-Board namespaces will diverge on purpose.
  - The valuable alignments are (a) CI OIDC trust (M5): whoever can run CI on `group/repo` can upload to the
    projects linked to it; and (b) an optional "import members from GitLab/GitHub" helper, mapped by email (M6).

## 7. Tokens
- **Format**: `qab_pat_` (personal), `qab_svc_` (service accounts), or `qab_tmp_` (short-lived tokens the server
  issues: CI exchange, server-started runs), followed by 40 base62 characters and a 6-character checksum (GitHub
  style).
  - The checksum lets the CLI reject typos offline.
  - The prefix lets secret scanners find leaked tokens, including GitHub's partner program once we're public.
- **Storage**: `sha256(token)` (fine for 238-bit random secrets: one indexed lookup, no salt needed) and a display
  prefix (`qab_pat_Xk3f…`). A token is shown once.
  - The migration **hashes existing tokens in place**, so today's `QA_TOKEN` values keep working.
  - Those legacy tokens are listed as "legacy, all scopes, no expiry", with a nudge to replace them.
- **Fields**: `name`, `kind`, `user_id` (owner), `created_by`, `scopes`, `projects` (patterns: `group/repo`,
  `group/*`; empty means everything the owner can access), `expires_at`, `idle_expiry_days`, `last_used_at`,
  `last_used_ip`, `revoked_at`, `revoked_by`, `data` (e.g. "qa CLI on host X").
- **Scopes**, aligned with http-upload.md §6.1:

  | Scope | Allows |
  |---|---|
  | `read` | `project.read` |
  | `ingest` | `runs.ingest` |
  | `act` | `runs.act`, `milestones.write` |
  | `manage` | `project.settings`, `project.access` |
  | `admin` | admin endpoints (admins only) |

- **Effective rights** = what the owner may do *now* ∩ scopes ∩ project patterns. Disabling a user kills their
  tokens. A token can't mint tokens (the CLI device flow is approved in a browser session). Admin endpoints accept a
  session, or a token with `admin`.
- **Lifetimes**, so long-lived tokens stay sane:
  - Each token has an expiry (UI default 90 days) and/or an **idle expiry** (CLI tokens: 180 days without use).
  - "No expiry" is allowed unless the admin sets `tokens.max_lifetime_days`.
  - Email reminders go out 7 days before expiry (M5).
  - `last_used_at` is written at most every 5 minutes.
- **`?token=` is accepted only for GET**, and is deprecated (it ends up in access logs). Bearer only for writes.
- **Service accounts**: an org owner creates `camera-algo/ci-bot`, grants it `developer` on the org or on some
  projects, and mints `qab_svc_` tokens for it. Runs show "ci-bot (camera-algo)". This is the
  "organization-level token" for CI.
- **API**: `GET/POST /api/v1/user/tokens`, `DELETE /api/v1/user/tokens/<id>`, the same under
  `/namespaces/<ns>/service-accounts/<id>/tokens` and for admins `/admin/tokens`. `POST /api/v1/user/token/` stays as
  a legacy alias (all scopes, 1-year expiry). `GET /api/v1/user/me` with a token also says which token and its scopes.

## 8. Access requests and notifications
- `access_requests(id, user_id, kind, target_type, target_id, role, message, status, reviewer_note, decided_by,
  decided_at, created_at)`.
  - `kind` is `instance`, `role` or `namespace_create`.
  - `status` is `pending`, `approved`, `denied`, `cancelled` or `expired`.
  - A user has at most one pending request per target.
- **Reviewers**: admins for `instance` and `namespace_create`. For a project role: the project's owners, else the
  namespace's, else admins.
- **Where users ask**:
  - the pending page;
  - the 403 page and empty states ("You don't have access to `camera-algo/isp`. Owners: Alice, Bob.
    [Request developer access]");
  - the project's Access tab;
  - "Create an organization".
- **Notifications**:
  - Email to the reviewers through the existing mailer (notifications/mail.py), when email is configured. It links
    to approve or deny.
  - An in-app badge on the sidebar for reviewers.
  - An optional chat webhook (Slack, Teams, Mattermost incoming webhook URL) per instance and per namespace.
  - The requester gets an email when the request is decided.
- **Approving** a request creates the grant (`source=manual`, `granted_by` the reviewer). Both steps are audited.

## 9. Audit log
- `audit_events(id bigserial, created_at, actor_kind, actor_user_id, actor_token_id, actor_label, ip, user_agent,
  action, target_type, target_id, project_id, changes JSONB {field: {from, to}}, meta JSONB, request_id)`.
  - Written in the same transaction as the change, by one helper, `audit(action, target, changes=..., meta=...)`.
  - The IP honours `X-Forwarded-For` up to `QABOARD_TRUSTED_PROXY_HOPS`.
- **Actions**:
  - Sign-in (success, failure, with provider and IdP groups) and sign-out.
  - Sessions revoked.
  - Tokens created, revoked or expired. A token's first use from a new IP (cheap anomaly signal).
  - Users approved, disabled, made admin.
  - Grants added or removed, visibility changed.
  - Groups and their rules changed.
  - Providers and settings changed (secret values never logged, only "changed").
  - Access requests created or decided.
  - Projects created or deleted, namespaces created.
  - Admin "act as" (later).
  - Batch deletions (already a destructive action people ask about).
- **Reading it**:
  - Admins see everything in Admin → Audit, with filters and CSV export.
  - Owners see their project's events in its Access tab.
  - Users see their own sign-ins and tokens in Settings.
- **Retention**: `audit.retention_days` (default 730). A test checks that no event contains a secret.

## 10. Sessions and web security
- **Server-side sessions**: `user_sessions(id_hash, user_id, provider_id, created_at, last_seen_at, expires_at, ip,
  user_agent, revoked_at)`. The cookie holds an opaque id.
  - Idle timeout 30 days, sliding; absolute 180 days (both settings).
  - Users see and revoke their sessions; admins revoke all of a user's.
  - This replaces flask-login's remember cookie. EMMA's lesson applies: a short fixed lifetime logs active users
    out, so slide it.
- **Cookies**: `HttpOnly`, `SameSite=Lax`, and `Secure` when `QABOARD_URL` is https.
- **Logout** is always allowed: an authenticated-only logout loops with the 401 handler (EMMA's lesson).
- **Rate limits** on the password login, device code and token exchange endpoints (per IP and per user name):
  in-process to start, and nginx `limit_req` in the shipped config.

## 11. The `qa` CLI and CI

### 11.1 `qa auth`
What good CLIs do today (`gh`, `glab`, `az`, `gcloud`, `huggingface-cli`, `vercel`): a browser-approved login that
saves a token **per server, in the user's config directory**, plus an environment variable for CI.
- **`qa auth login [--server URL]`** runs the **OAuth 2.0 device authorization flow** (RFC 8628):
  1. The CLI gets a code: `POST /api/v1/auth/device/code` →
     `{device_code, user_code: "WDJB-MJHT", verification_uri, interval, expires_in}`.
  2. It prints "Open https://qa.example/device and enter WDJB-MJHT", and opens the browser when there is a display.
  3. In the web app, the user signs in (any provider, SSO included) and confirms "Authorize *qa CLI on
     host-12* to read and upload runs as alice?".
  4. The CLI polls and receives a `qab_pat_` token named after the host, with scopes `read ingest act` and a
     180-day idle expiry.
  - **The device flow is the default** because at SIRC people run `qa` over SSH on compute servers without a
    browser. A loopback-redirect variant (`--web`) can come later for laptops.
- **`qa auth login --with-token`** reads a token from stdin (for scripts and CI).
- **`qa auth status`**: the server, the user, the token's name, scopes and expiry. It checks them with `/user/me`.
- **`qa auth logout`**: revokes the token on the server and forgets it.
- **`qa auth token`**: prints the token, e.g. for `curl`.
- **Where it's stored**: `~/.config/qaboard/hosts.yaml` (`%APPDATA%\qaboard` on Windows), mode 0600, keyed by
  server URL: `{"https://qa.sirc": {user: alice, token: qab_pat_…, token_id: 12}}`.
  - It's **global, not per project**: one login serves every worktree and checkout, and secrets stay away from
    files that might be committed. The project only says *which server* (qaboard.yaml or the site package).
  - The OS keyring can come later, as an optional backend: on headless Linux it's often unavailable.
- **Precedence**: `QABOARD_TOKEN` (new name, with `QA_TOKEN` as an alias), then `hosts.yaml` for the server, then the
  legacy `~/.qaboard/secrets.yaml`.
- **Nudges**:
  - Outside CI, when `qa` uploads without a token, it prints once a day: "Runs are saved as unverified `alice`. Run
    `qa auth login` to sign them."
  - On a 401 it says exactly what to do: "Your token expired on 2026-09-01: run `qa auth login`."

### 11.2 Ingest trust
- Every run, batch and commit records the **verified submitter**: `data.submitted_by = {user_id, user_name,
  token_id, via}`, from the token. The **claimed user** (`QA_USER`) stays in `data.user`. The web app shows a small
  "unverified" mark when there's no verified submitter, and "via ci-bot" when they differ.
- **`QABOARD_INGEST_AUTH`** (a setting, per instance; projects can only be stricter):
  - `off`: accepts anonymous ingest, as today.
  - `warn`: accepts it, but marks the run and logs it. The CLI prints the nudge.
  - `token`: requires a token with `ingest` on the project.
- **In every mode**, an invalid, expired or revoked token gets a 401: silently ignoring a broken credential hides
  misconfiguration. A valid token without permission gets a 403 in `token` mode. In `off`/`warn` it's recorded as
  unverified and a warning header tells the CLI to print it.
- **Why open stays the default on-prem**: the writer already needs write access to shared storage, and you said
  metadata spam isn't a concern. The cloud defaults to `token`.

### 11.3 CI without stored secrets (M5)
- GitHub Actions and GitLab CI issue **OIDC ID tokens** that describe the job: repository, ref, workflow, pipeline
  source. PyPI's "trusted publishing", AWS and GCP all use them. QA-Board can too:
  - `POST /api/v1/auth/token-exchange` (RFC 8693) takes the CI's ID token and returns a `qab_tmp_` token valid for
    the job, with `ingest` on the matching projects.
  - **Trust policies** belong to projects: `ci_trust(project_id, issuer, conditions)`, e.g.
    `project_path == camera-algo/isp && ref_protected == true`. Only owners edit them.
  - The CLI does the exchange by itself: when `ACTIONS_ID_TOKEN_REQUEST_URL` is set (GitHub), or when
    `QABOARD_ID_TOKEN` is set (GitLab `id_tokens:`).
  - Runs show "GitHub Actions: camera-algo/isp@main".
- **Jenkins and LSF** have no such tokens: use service-account tokens.
- **Runs QA-Board starts itself** (redo, tuning) get a short-lived `qab_tmp_` token through the process environment,
  never written to scripts (http-upload.md §6.2).

## 12. Web app

### 12.1 From sign-in to your projects
1. Anonymous users on a server that requires sign-in go to `/login`, which lists the providers (§4.3). After signing
   in they return to the page they asked for.
2. Pending users see the pending page.
3. **Home: "Your projects"**: favorites, projects where you have a role, recently visited (from preferences), projects
   where you submitted runs recently, then "All projects you can see".
   - The empty state shows the three steps: `pip install qaboard`, `qa auth login`, `qa init`.
4. **403 page** with the reason, the owners and *Request access*. A 404 for private projects you can't see:
   don't leak their names.

### 12.2 Settings (user menu → Settings, `/settings`)
- **Profile**: name, email, avatar, the groups you're in and where they come from, your roles.
- **Preferences**: theme, density, notifications ("email me when my batches end"), default project.
- **Access tokens**: create (name, scopes, projects, expiry with presets), shown once with copy and usage snippets
  (`QABOARD_TOKEN=… qa batch`, curl). List with last used. Revoke.
- **Sign-in methods**: linked identities, link another.
- **Sessions**: devices, last seen, revoke. CLI logins appear here too.

### 12.3 Project → Access tab (owners; everyone sees who the owners are)
- Visibility, inherited or overridden.
- Members: grants for users, groups and service accounts, with role, source and expiry.
- Pending requests, with approve and deny.
- Service accounts and their tokens (namespace level).
- CI trust policies (M5).
- The project's audit events.

### 12.4 Admin panel (`/admin`, admins only)
- **Overview**:
  - Counts: users, pending requests, active tokens.
  - Provider status.
  - **Security checklist**: ingest is open; `everyone → developer` is still granted; cookies aren't `Secure`;
    `SECRET_KEY` was generated; no admin email configured.
- **Users**:
  - Search and filters (status, provider, admin, group). Columns: last sign-in, created.
  - The detail page shows identities, groups with their source, grants, tokens, sessions and an audit timeline.
  - Actions: approve, disable, make admin, revoke sessions and tokens.
- **Access requests**.
- **Groups**: members, rules, and *test a rule against a user*.
- **Sign-in**:
  - Providers (create, edit, order, enable), with *Test*: OIDC discovery, LDAP bind and search for a user name,
    SAML metadata.
  - Access policy, session lifetimes.
- **Organizations & projects**: owners, visibility, namespace collisions, YAML import.
- **Tokens**: all tokens, filters, revoke. Token policy.
- **Audit**.
- **Settings**: every setting with its source.
- As in EMMA, the frontend never decides: it reads `GET /api/v1/user/me` (roles, admin, permissions per project).

## 13. Data model (migrations)
All additive. They keep the conventions: one alembic revision per milestone step, a docstring header, and
`has_table` guards (the app's `create_all` may create the tables first). Defaults preserve today's behaviour.

| Table | Change | Milestone |
|---|---|---|
| `users` | + `kind` (human/service), `status` (active/pending/disabled), `is_admin`, `last_login_at`, `preferences` JSONB, `preferences_updated_at`, `namespace_id` (service accounts) | M1 |
| `tokens` | + `token_hash` (filled by hashing `token`, then `token` dropped in a later release), `prefix`, `kind`, `name`, `scopes`, `projects`, `idle_expiry_days`, `last_used_at`, `last_used_ip`, `created_by`, `revoked_at`, `revoked_by` (`revoked` kept and synced one release) | M1 |
| `audit_events` | new | M1 |
| `settings` | new | M1 |
| `device_authorizations` | new: `device_code_hash`, `user_code`, `client_name`, `scopes`, `expires_at`, `approved_by`, `token_id`, `status` | M1 |
| `auth_providers`, `user_identities` | new; identities backfilled from `login_type` | M2 |
| `user_sessions` | new | M2 |
| `access_requests` | new | M2 (instance), M3 (roles) |
| `groups`, `group_members`, `group_rules` | new; built-in `everyone` | M3 |
| `role_grants` | new; seeded with `everyone → developer` on the instance | M3 |
| `projects` | + `visibility` (default `internal`), `namespace_id` | M3 / M4 |
| `namespaces`, `project_repos` | new; backfilled from project ids and `data.git` | M4 |
| `ci_trust` | new | M5 |

`users.data` keeps the raw directory attributes until M2 moves them to `user_identities.claims`.

## 14. Milestones

| | Milestone | What users get | Size |
|---|---|---|---|
| **M1** | **Foundations**: actor and default-deny, tokens, audit, settings, admins, preferences, admin panel v1, `qa auth` | Tokens page, `qa auth login`, verified runs, sign-in really required when configured, users list for admins, preferences that follow you | 3-4 intense sessions |
| **M2** | **Sign-in**: providers in the database, OIDC, several at once, identities, server-side sessions, access policy and instance access requests | SSO with Entra/Keycloak next to LDAP, a clear sign-in page, "request access", admins notified | 3 sessions |
| **M3** | **Authorization**: roles, grants, groups and rules (LDAP and SSO), visibility with inheritance, `authorize()` on every endpoint, Access tab, YAML import, project access requests | Owners manage who can see or upload, from the web app | 3-4 sessions |
| **M4** | **Namespaces and organizations**: personal namespaces, orgs, service accounts, project creation policy, repository links | "Create an organization", your first runs land under your name, org CI tokens | 2-3 sessions |
| **M5** | **CI and ingest trust**: `QABOARD_INGEST_AUTH` per project, OIDC token exchange for GitHub and GitLab, token expiry emails, rate limits | CI uploads with no secret, owners can require verified runs | 2 sessions |
| **M6** | **Enterprise and cloud**: SCIM, scheduled LDAP sync, MFA/passkeys and email verification for local accounts, audit streaming and retention, admin "act as", git member import, account deletion and export | Ready for a public instance | ongoing |

Plans and billing stay out of scope. Namespaces (M4) are where they would attach (`namespaces.data.entitlements`),
and nothing above assumes one tenant per server.

### 14.1 M1 in detail
**Session 1: the harness and the core**
- **Integration tests on a real PostgreSQL.** The mocked tests (`backend/conftest.py`) can't catch SQL, migrations
  or the order of hooks.
  - A new `backend/integration_tests/` folder boots the real app against `QABOARD_TEST_DATABASE_URL`. Each test
    module gets a fresh database, built by `alembic upgrade head` on top of `create_all`, as in production.
  - Tests use the Flask test client. They're skipped when the variable isn't set, and the CI job that already has a
    database runs them.
  - The first tests are what I checked by hand for this document: signup, login, `/me`, milestones, tokens, and
    migrating down and up.
- **The migration**: `users` and `tokens` columns, `audit_events`, `settings`, `device_authorizations`. Existing
  tokens are hashed.
- **`g.actor`, resolved in `before_request`**:
  - Bearer tokens (hash lookup, expiry, idle expiry, revoked, user disabled).
  - Token requests no longer open a session.
  - `?token=` only for GET.
- **Sign-in required for real**: the `/api/` allow-list (TODO_WARTS.md:40). Cookie flags, the `Origin` check on
  writes, CORS limited to known origins.
- **`settings` with env overrides**; `QABOARD_ADMINS`; `qaboard-admin create-admin`.
- **`test_security.py`** sees every route decorator and requires a declared policy.

**Session 2: tokens, audit, ingest provenance**
- The tokens API: create (scopes, projects, expiry, idle expiry), list, revoke. Admins list and revoke all.
- **Scopes enforced** on today's checks: ingest needs `ingest`, `login_required` writes need `act`, admin needs
  `admin`. Project patterns too.
- The `audit()` helper and the M1 events: sign-in success and failure, sign-out, tokens, admin changes, settings,
  batch deletions.
- `submitted_by` on runs, batches and commits. `QABOARD_INGEST_AUTH=off|warn|token` at the instance level. The
  "unverified" mark in the web app.
- `GET/PATCH /api/v1/user/preferences`.

**Session 3: web app**
- `/settings`: Profile, Preferences, Access tokens, Sessions (CLI logins).
- **Preferences synced**: `theme`, `commitListDensity`, `favorites`, `milestoneGroupsCollapsed`, `imagePixelValues`,
  `tuning`. Device-only: `siderCollapsed`.
  - At sign-in the server's values win; local keys the server doesn't have yet are pushed once.
  - Writes are debounced PATCHes.
- **Admin panel v1**: Overview with the checklist, Users (list, detail, disable, make admin, revoke), Tokens, Audit,
  Settings (read-only list with sources).
- **Better sign-in errors** (codes and sentences, §4.3) on today's providers. The 401/403 bodies carry `reason`, and
  the toasts say what to do.
- `/device`, the device-flow approval page.

**Session 4: CLI and docs**
- `qa auth login|status|logout|token`, device flow, `hosts.yaml`, `QABOARD_TOKEN`, the nudges.
- An end-to-end test: a real backend, `qa auth login --with-token`, `qa run` against a project, then
  `submitted_by` is checked.
- Python tests for the CLI's token resolution and storage permissions.
- **Docs**:
  - User guide: tokens, `qa auth`, settings.
  - Project integration: CI with `QABOARD_TOKEN`.
  - Admin: bootstrap admins, settings, requiring sign-in, the ingest modes, the security checklist.
  - Update `managing-users.mdx` (it overstates `QABOARD_LOGIN_REQUIRED` today), `SECURITY.md` (line 91 is out of
    date: milestones need a login now) and `roadmap.mdx`.
- Release notes in `website/release-notes/2026-10.md` (or 11) for each user-visible change.

**M1 is done when:**
- With sign-in required, every `/api/` route except the allow-list answers 401 to anonymous requests (an integration
  test walks the URL map).
- No token is stored in clear.
- A user creates a token in the web app, uses it from `qa`, sees "last used", revokes it, and the next `qa` call
  fails with a sentence telling them what to do.
- `qa auth login` works over SSH.
- Admins list and disable users. A disabled user's sessions and tokens stop working at the next request.
- Every security action in M1 appears in the audit log.
- Preferences follow the user to another browser.
- Existing deployments see no change in behaviour until an admin changes a setting.

## 15. Tests
- **Unit tests** (mocked, `backend/tests/`), as today: the permission table, the effective-role computation
  (inheritance, visibility, groups, expired grants), token format and checksum, claim → group rules, the settings
  precedence, `next=` validation, error messages that never leak secrets or attributes.
- **Integration tests** (real PostgreSQL, `backend/integration_tests/`):
  - Every flow end to end through HTTP.
  - The URL-map walk for default-deny.
  - Migrations up and down from the previous head, on a database with data.
  - Concurrent `last_used_at` updates.
- **OIDC**: a throwaway IdP in the tests (Authlib can sign JWTs with a test key) to check `alg: none`, bad signature,
  wrong audience, nonce replay and state mismatch (as EMMA's `oidc.test.ts`). LDAP and SAML keep their unit tests.
- **Web app**: Vitest for the settings, tokens, admin and login pages and the preference sync. Playwright smoke: sign
  in, create a token, see the admin users list.
- **CLI**: green tests for `qa auth` (token precedence, file mode 0600, device-flow polling with a fake server).

## 16. Decisions for you
Each comes with my recommendation; the plan above assumes it.
1. **Roles**: `viewer`/`developer`/`owner` + admins, with `maintainer` only when someone needs it. *Recommended.*
2. **Admins bypass project permissions** (implicit owner everywhere, audited), rather than EMMA's "no bypass".
   *Recommended for on-prem; revisit for the cloud.*
3. **Compatibility grant `everyone → developer`** after the migration, removed by admins when they're ready, rather
   than switching every signed-in user to viewer on upgrade. *Recommended: no surprise for SIRC users.*
4. **Project ids stay as they are**, with namespaces added beside them and organizations created from first path
   segments, rather than renaming projects. *Recommended.*
5. **OIDC with Authlib** (a new dependency), rather than writing our own client. *Recommended.*
6. **The CLI token is global per server** (`~/.config/qaboard/hosts.yaml`), not per project. *Recommended.*
7. **Ingest stays open by default on-prem** (`off`), with verified submitters recorded; new installs and the cloud
   default to `token`. *Recommended.*
8. **No git-host permission sync**: CI OIDC trust and an optional member import instead. *Recommended.*
9. **What does Samsung's IdP speak?** Entra ID (OIDC) or ADFS (OIDC and SAML), and which claim carries the AD groups?
   This decides the M2 presets and how group rules match. *I need this from you, or from IT.*
