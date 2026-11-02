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
  - **Done before M4** (2026-10), without namespaces: service accounts belong to the **instance** (admins manage them,
    `nightly[bot]`, optional instance role) or to a **project** (its owners manage them, `group/repo/ci[bot]`, a role
    on the project, tokens that can't reach outside of it). `users.owner_type` (`instance`/`project`) and `owner_id`
    stand in for `namespace_id`: M4 adds `namespace` owners, and can move instance accounts to org namespaces.
    API: `/api/v1/service-accounts` (backend/api/service_accounts.py).
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
| **M6** | **Enterprise and cloud**: SCIM, MFA/passkeys and email verification for local accounts, audit streaming and retention, admin "act as", git member import, account deletion and export | Ready for a public instance | ongoing |

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

## Appendix A: the M1 API
The contract the backend, the web app and the CLI implement. JSON everywhere. Edits use `POST` (some proxies drop the
body of other methods), `DELETE` only for bodiless revocations.

### A.1 Errors
401 and 403 bodies are `{"error": "<a sentence for people>", "reason": "<code>", ...}`.
| Status | `reason` | When |
|---|---|---|
| 401 | `sign_in_required` | no credentials, the server requires sign-in or the endpoint needs a user |
| 401 | `token_invalid`, `token_expired`, `token_idle_expired`, `token_revoked` | a bearer token was sent and can't be used (never ignored, in every mode) |
| 401 | `user_disabled`, `user_pending` | the session's or token's user can't use the server |
| 403 | `missing_scope` (+ `required`) | the token lacks a scope |
| 403 | `token_project` | the token is restricted to other projects |
| 403 | `forbidden_project` | the user can't access the project (today: `QABOARD_LOGIN_RESTRICTED_YAML`) |
| 403 | `session_required` | the action needs a browser session (minting tokens, approving devices) |
| 403 | `not_admin` | admin endpoints |
| 403 | `cross_site_write` | a cookie-authenticated write from another origin |
| 403 | `ingest_token_required` | `ingest.auth` is `token` and the run was sent without one |

### A.2 Who is calling
- `GET /api/v1/user/me/`: today's fields, plus `is_admin`, `status` (`active`/`pending`/`disabled`), `kind`
  (`human`/`service`), and when called with a token `token: {id, name, prefix, kind, scopes, projects, expires_at}`.
- Scopes: `read`, `ingest`, `act`, `manage`, `admin`. Sessions have every scope their user has. With a token,
  `GET` requests need `read`, `login_required` writes need `act`, ingest needs `ingest`, admin endpoints need `admin`.

### A.3 Tokens
`Token` objects: `{id, name, kind: personal|cli|legacy, prefix, scopes, projects, created_at, expires_at,
idle_expiry_days, last_used_at, last_used_ip, revoked_at, status: active|expired|idle_expired|revoked, data}`.
`data` holds e.g. `{"client": "qa CLI", "hostname": "host-12"}`.
- `GET /api/v1/user/tokens` → `{"tokens": [Token]}`, newest first, revoked ones included.
- `POST /api/v1/user/tokens` `{name, scopes, projects?: ["group/repo", "group/*"], expires_in_days?: int|null,
  idle_expiry_days?: int|null}` → `201 {...Token, "token": "qab_pat_…"}` (the only time the secret is returned).
  Needs a session. `expires_in_days` defaults to `tokens.default_lifetime_days` (90); `null` means no expiry,
  refused (400) when `tokens.max_lifetime_days` is set.
- `DELETE /api/v1/user/tokens/<id>` → `Token` (revoked). Works with the token itself (`qa auth logout`).
- `POST /api/v1/user/token/` (legacy) → `{token, created_at, expires_at}`, every scope, 365 days.
- Format: `qab_pat_` (personal, cli), then 40 base62 characters and a 6-character base62 checksum (crc32 of the
  random part). `prefix` is the first 12 characters. Legacy tokens (64 hex characters) still work.

### A.4 Device flow (RFC 8628), for `qa auth login`
- `POST /api/v1/auth/device/code` `{client_name: "qa CLI on host-12", hostname?}` → `{device_code, user_code:
  "WDJB-MJHT", verification_uri: "<QABOARD_URL>/device", verification_uri_complete: "<…>/device?code=WDJB-MJHT",
  expires_in: 900, interval: 5}`. No authentication.
- `POST /api/v1/auth/device/token` `{device_code}` → `200 {access_token, token_type: "Bearer", token_id, user_name,
  scopes, expires_at, idle_expiry_days}`, else `400 {error: authorization_pending|slow_down|access_denied|expired_token,
  error_description}` (RFC error codes here, the CLI maps them to sentences).
- `GET /api/v1/auth/device?code=WDJB-MJHT` (session) → `{client_name, hostname, scopes, created_at, expires_at, status:
  pending|approved|denied|expired}`; 404 if unknown.
- `POST /api/v1/auth/device` `{code, approve: true|false}` (session) → `{status}`. Approving creates a `cli` token for
  the user: scopes `read ingest act`, no expiry date, idle expiry `tokens.cli_idle_expiry_days` (180).

### A.5 Preferences
- `GET /api/v1/user/preferences` → `{preferences: {...}, updated_at}`.
- `POST /api/v1/user/preferences` `{preferences: {key: value|null}}`: merges top-level keys, `null` removes one,
  64 KiB max → same as `GET`.

### A.6 Admin (session of an admin, or a token with `admin` whose user is an admin)
`User` objects: `{id, user_name, full_name, email, kind, status, is_admin, is_admin_from_env, login_type,
created_date, last_login_at, active_tokens}`.
- `GET /api/v1/admin/overview` → `{counts: {users, active_30d, admins, pending, disabled, active_tokens},
  checklist: [{id, ok, severity: info|warning|danger, title, detail}]}`.
- `GET /api/v1/admin/users?search=&status=&admin=true&limit=50&offset=0` → `{users: [User], total}`.
- `GET /api/v1/admin/users/<id>` → `{user: User, tokens: [Token], audit: [AuditEvent]}` (the latest 50 events by or
  about them).
- `POST /api/v1/admin/users/<id>` `{status?: active|disabled, is_admin?: bool}` → `User`. You can't disable yourself
  or remove your own admin role, and admins from `QABOARD_ADMINS` can't be demoted (400 with a sentence).
- `POST /api/v1/admin/users/<id>/revoke-tokens` → `{revoked: n}`.
- `GET /api/v1/admin/tokens?user=<id>&status=active&limit=&offset=` → `{tokens: [Token + user: {id, user_name}], total}`.
- `DELETE /api/v1/admin/tokens/<id>` → `Token`.
- `GET /api/v1/admin/audit?action=&actor=<user_name>&target_type=&target_id=&before_id=&limit=100` →
  `{events: [AuditEvent], next_before_id}`. `GET /api/v1/admin/audit/actions` → `{actions: [...]}`.
- `GET /api/v1/admin/settings` → `{settings: [{key, value, default, source: env|database|default, env, description,
  editable}]}`. `POST /api/v1/admin/settings` `{key: value|null}` (`null` resets to the default) → same as `GET`.

`AuditEvent` objects: `{id, created_at, actor_kind: user|token|system|anonymous, actor_user_id, actor_label,
actor_token_id, ip, user_agent, action, target_type, target_id, target_label, project_id, changes, meta}`.
- `GET /api/v1/user/audit?before_id=&limit=` → the signed-in user's own events (sign-ins, tokens, devices).

### A.7 Settings in M1
| Key | Env | Default |
|---|---|---|
| `auth.require_sign_in` | `QABOARD_LOGIN_REQUIRED` | `false` |
| `auth.local_signup` | `QABOARD_DISABLE_SIGNUP` (inverted) | `true` only when the login type is `LOCAL` |
| `auth.allowed_origins` | `QABOARD_ALLOWED_ORIGINS` (comma-separated) | `[]` (the server's own origin is always allowed) |
| `ingest.auth` | `QABOARD_INGEST_AUTH` | `off` (`off`, `warn`, `token`) |
| `tokens.default_lifetime_days` | | `90` |
| `tokens.max_lifetime_days` | | `null` (no maximum) |
| `tokens.cli_idle_expiry_days` | | `180` |
| `audit.retention_days` | | `730` |

`QABOARD_ADMINS` (comma-separated user names or emails) are admins whatever the database says.
`/api/v1/config` adds `require_sign_in`, `ingest_auth`, `local_signup` (and keeps `login_required`).

### A.8 Ingest
`POST /api/v1/output/`, `/batch/`, `/commit/` record `data.submitted_by = {user_id, user_name, token_id, token_name,
via: token|session}` when the caller is authenticated (outputs: `Output.data`, batches: `Batch.data`, commits:
`CiCommit.data`). With `ingest.auth=warn` and no credentials, the answer has the header
`X-QABoard-Warning: <sentence>`, which the CLI prints. A valid token without access to the project: 403 in `token`
mode, else accepted as unverified, with the warning header.

## Appendix B: M1 as built (2026-10-20)
What differs from the plan above, and why:
- **CORS stays open, without credentials.** flask-cors doesn't send `Access-Control-Allow-Credentials`, so other
  origins can't read authenticated answers. Cookie writes from other origins are refused by the `Origin` check
  (`backend/actor.py`), so restricting CORS too would only break anonymous reads from dashboards.
- **No server-side sessions yet** (M2). Disabling a user takes effect at the next request anyway, because the actor
  re-reads the user each time. The flask-login remember cookie (180 days) stays until then.
- **`POST /api/v1/task/celery/<id>` stays anonymous**: WebCDE calls it, and we don't know yet if it can send a token.
  It's listed in `tests/test_security.py` and SECURITY.md.
- **The device flow mints the token when the CLI polls** after the approval, so the secret is never stored.
- **Ingest on missing projects** keeps today's errors (404 from the commit lookup) rather than a new 400.
- **LDAP's directory attributes** stay out of the per-request user info, as before: `QABOARD_LOGIN_RESTRICTED_YAML`'s
  `data:` rules only match SAML attributes at request time (LDAP's are checked at sign-in). M3's groups replace this.
- **Integration tests** (`backend/integration_tests/`) run the real app on a database they create, with
  `BACKEND_TEST_MODE=no-mock` and `QABOARD_TEST_DATABASE_URL`. GitHub CI runs them; the GitLab job (no database) skips them.
- **Review fixes** (after a 5-agent review):
  - `QABOARD_ADMINS` matches user names exactly, and emails only for directory accounts.
  - No `manage` scope until M3 enforces it. Legacy tokens get `read ingest act`.
  - The CLI has no daily nudge: the server's `X-QABoard-Warning` (warn mode) says it.
  - `qa auth logout` only revokes device-minted tokens (`minted_by` in hosts.yaml).
  - In CI, `qa run`/`qa batch` exit 1 when the server refuses results.
  - Server sentences say what's wrong; clients add what to do.

## Appendix C: M2, sign-in (plan and API)
Aligned with EMMA (`EMMA_Client/docs/SSO.md`): **OIDC, Authorization Code + PKCE, confidential client, handled by the
backend**. The browser never sees the IdP's tokens. On success the backend opens the same session a password sign-in
opens, so nothing downstream knows how users signed in. **The IdP says who you are**: its `groups` claim is recorded in
the sign-in audit event, never used for access (M3 decides with group rules).

### C.1 Providers
- A provider is `{id, type: local|ldap|saml|oidc, name, kind: password|redirect, enabled, position, recommended}`.
- **From the environment** (read-only in the admin panel):
  - `local`: always there, for local accounts and break-glass admins.
  - `ldap`/`saml`: from `QABOARD_LOGIN_TYPE` and today's variables.
  - `sso`: an OIDC provider from `QABOARD_OIDC_ISSUER`, `QABOARD_OIDC_CLIENT_ID`, `QABOARD_OIDC_CLIENT_SECRET`,
    `QABOARD_OIDC_SCOPES` (`openid profile email`), `QABOARD_OIDC_USERNAME_CLAIM` (`preferred_username`; SIRC:
    `samaccountname`), `QABOARD_OIDC_GROUPS_CLAIM` (`groups`), `QABOARD_OIDC_BUTTON_LABEL`, and
    `QABOARD_OIDC_MATCH_USERS` (`username`|`email`|`none`).
  - An empty issuer means no SSO: the one-variable rollback.
- **From the database** (`auth_providers`): more OIDC providers, created in **Admin → Sign-in**.
  - Their secret is a reference to an environment variable (`client_secret_env`), or is stored encrypted with
    `QABOARD_ENCRYPTION_KEY` (Fernet).
- **Redirect URI**: `{QABOARD_URL}/api/v1/auth/oidc/<provider>/callback`. The env provider also answers on
  `/api/v1/auth/oidc/callback`, so it can be registered with the IdP once.

### C.2 Identities and accounts
- `user_identities(user_id, provider_id, subject, email, claims, created_at, last_login_at)`, unique on
  (provider_id, subject). The migration backfills `ldap`/`saml`/`local` identities from `users.login_type`.
- **Signing in with OIDC**, in order:
  1. The identity (provider, `sub`), if it exists.
  2. Else, when the provider says `match_users: username` (the IdP is federated to the same directory, as at SIRC),
     the user whose `user_name` is the username claim. `email` matches verified emails (`email_verified`).
  3. Else a new user, if the access policy allows it.
- The LDAP attributes stay useful (`QABOARD_LOGIN_RESTRICTED_YAML` rules read `user.data`). With an LDAP service account,
  an SSO sign-in looks the user up in LDAP and refreshes them, as EMMA does.

### C.3 Sessions
- `user_sessions(id_hash, user_id, provider_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at)`.
  - The cookie holds an opaque id (`session['sid']`).
  - The actor checks the session at each request: revoked, expired, idle, or a disabled user means signed out.
  - `last_seen_at` is written at most every 5 minutes.
- **Settings**: `sessions.idle_days` (30), `sessions.max_days` (180).
- **Existing flask-login sessions** become rows at their next request: nobody is signed out by the upgrade.
- Users list and revoke their sessions in **Settings → Sessions** (with the CLI sign-ins). Admins revoke a user's
  sessions, and disabling a user revokes them.
- Signing out revokes the session.

### C.4 Who gets an account
- **`auth.access_policy`**:
  - `open`: new users are active. It's the default, and today's behaviour.
  - `domains`: active if their email is in `auth.allowed_email_domains`, else pending.
  - `approval`: every new user is pending.
- **Pending users** can sign in and see the pending page, with their access request and who reviews it. They can add
  a message.
- **`access_requests(id, user_id, kind, message, status, decided_by, decided_at, created_at)`**, kind `instance` in M2.
  Approving or denying a user, from the panel or the API, decides their request. The requester gets an email, if
  email is set up.
- **Notifications**: admins get an email (`notifications/mail.py`, when SMTP is configured), and a POST to
  `auth.access_request_webhook` (Slack/Teams/Mattermost incoming webhooks: `{"text": ...}`). The admin panel shows a
  badge with the pending count.

### C.5 Sign-in page and errors
- `GET /api/v1/auth/providers` → `{providers: [{id, type, kind, name, recommended, start_url}], local_signup, login_hint, auto_redirect}`.
- `/login?next=…`: SSO buttons first (the recommended one first), then "or", then one user name/password form for
  `ldap` and `local`.
- **Auto-redirect**: with `auth.sso_auto_redirect`, sign-in required and a single redirect provider, the page goes
  straight to it. `/login?local=1` is the escape hatch.
- **Errors**: the OIDC callback redirects to `/login?error=<code>&ref=<audit event id>`. The codes are
  `sso_unavailable`, `sso_expired` (state or nonce), `sso_failed` (IdP error), `sso_misconfigured` (missing claim,
  invalid token), `not_allowed`, `user_disabled` and `user_pending`. Details go to the audit log and the server log,
  never to users.
- `next` only goes to our own pages (`safe_redirect_url`).

### C.6 Doctor and admin panel
- **`qaboard-admin check-sign-in [--provider sso] [--user alice]`**, as EMMA's `sso:check`. It checks:
  - that the backend reaches the discovery document;
  - that `issuer` matches;
  - the redirect URI, by making the authorization request server-side: a login page means it's accepted, an error
    page means it's refused, and near-misses are probed (http/https, trailing slash);
  - the LDAP bind, and the lookup of `--user`.
- **Admin → Sign-in**: providers (env ones read-only, DB ones editable), *Test* (the same checks), the access policy,
  allowed domains, the webhook and session lifetimes.
- **Admin → Users**: the pending ones, with their message; approve and deny.

### C.7 Also in M2
- **LDAP**: `ldaps://` in `QABOARD_LDAP_HOST`, or `QABOARD_LDAP_START_TLS=true`. An unknown user is an error, not a 500.
- **Rate limits**: nginx `limit_req` on the sign-in, sign-up, device-code and OIDC endpoints, in the shipped config.
- **The groundwork for M3**, first:
  - one `check_access(actor, scope, project)` for `login_required`, `ingest_access` and `require_project_access`;
  - the 401/403 helpers in `actor.py`;
  - the providers under `backend/sign_in/` (`local.py`, `ldap.py`, `saml.py`, `oidc.py`, `sessions.py`), leaving
    `api/auth.py` with the routes and decorators.
- **Tests**:
  - A throwaway IdP: an RSA key, discovery and JWKS served through `responses`.
  - What it checks: a valid sign-in, `alg: none`, bad signatures, wrong `aud`/`iss`, expired tokens, nonce replay,
    state mismatch, missing claims, linking rules.
  - Sessions: idle, max, revocation, the conversion of flask-login sessions.
  - The access policy and requests, notifications (mocked), the doctor.

### C.8 As built (2026-10-20)
- **Code layout**: the new code is in `backend/sign_in/` (`providers.py`, `oidc.py`, `accounts.py`, `identities.py`,
  `sessions.py`, `access.py`, `doctor.py`, `crypto.py`), with the routes in `api/sign_in.py` and `api/admin_sign_in.py`.
  LDAP and SAML stayed in `api/auth.py`: moving them was churn without a user-visible gain.
- **Not done, moved to the start of M3**: the single `check_access(actor, scope, project)`. M3's project roles are what
  it's for, and they'll shape its signature.
- **OIDC**: authlib's dependency joserfc checks the ID token (signature from the JWKS, `alg` from an asymmetric
  allow-list, `iss`, `aud`/`azp`, `exp` with 60 s of leeway, `nonce`); the HTTP calls are plain `requests`. Discovery
  and JWKS are cached for an hour, the JWKS refetched once on an unknown key (rotation). Userinfo fills missing claims,
  only when its `sub` is the ID token's.
- **Errors** are codes (`SignInError(code, detail)`): users see the code's message and the audit event id, admins the
  detail in the audit log and the server's log.
- **Proxies**: QA-Board's nginx talks uwsgi and passes `X-Forwarded-For` as the client sent it, so
  `QABOARD_TRUSTED_PROXY_HOPS` defaults to 0 (the address nginx sees). Set 1 behind an ingress.
- **TLS to the IdP**: the backend image sets `REQUESTS_CA_BUNDLE` to the system bundle, which has the CA of
  `CA_CERT_URL`: certifi's doesn't.
- **Docs**: [Sign-in and single sign-on](/docs/backend-admin/sign-in) on the website, `deployments/sirc/runbooks/sso.md`
  for SIRC's Keycloak.

## Appendix D: M3, authorization (plan and API)
Owners decide who can see a project and who can upload or act on its runs, from the web app. **Nothing changes on
upgrade**: today's behaviour is what the defaults say (projects public unless the YAML restricts them, everyone signed
in is a developer everywhere), and admins tighten it when owners are in place.

### D.1 Roles and permissions
One table in code, `backend/access/policy.py`:

| Permission | viewer | developer | owner | token scope |
|---|:-:|:-:|:-:|---|
| `project.read` | ✓ | ✓ | ✓ | read |
| `runs.ingest` | | ✓ | ✓ | ingest |
| `runs.act` (redo, stop, rename, move, delete batches and runs, tuning, exports, save artifacts) | | ✓ | ✓ | act |
| `milestones.write` | | ✓ | ✓ | act |
| `project.access` (visibility, members, requests) | | | ✓ | act |

Instance admins are owners everywhere (the API says `"via": "admin"`). Roles are ordered levels: `maintainer` can be
added between developer and owner later without a migration.

### D.2 Who has which role on `a/b/c`
The highest of:
- **Grants**, `role_grants(subject_type user|group, subject_id, resource_type instance|project, resource_id, role,
  source, granted_by_id, granted_at, expires_at)`. A project grant's `resource_id` is a project id **or a prefix**,
  matched by path segments: a grant on `a/b` applies to `a/b` and `a/b/c`, not to `a/bc`. That covers GitLab groups
  before M4's namespaces. Expired grants are ignored.
- **Groups** the user is in.
- **Visibility**: `public` projects give viewer to anyone (anonymous too, when the server lets anonymous users in),
  `internal` ones nothing to anonymous users; both give signed-in users `projects.signed_in_role` (setting: viewer or
  developer, default developer: today, any signed-in user can redo or delete). `private` projects give nothing: only
  grants count. A project's effective visibility is the most restrictive of the rules on it and on its prefixes
  (`project_visibility(path, visibility)`); without any, `projects.default_visibility` (setting, default `public`:
  today's behaviour).
- **The YAML file**, while it's there: a project matched by `projects:` in `QABOARD_LOGIN_RESTRICTED_YAML` is
  private, and the users its rules match are developers on it. Exactly today's behaviour; grants add to it.
- Tokens never have more than their user, their scopes and their project patterns allow.

No seed rows: the defaults are settings. The admin overview recommends `projects.signed_in_role: viewer` once
projects have owners. (A seeded instance grant `everyone → developer` would have overridden `private`.)

### D.3 Groups and rules
- No built-in groups: "everyone signed in" is `projects.signed_in_role`.
- `groups(id, name, description, created_at)`, `group_members(group_id, user_id, source manual|rule, added_by_id,
  added_at)`, `group_rules(group_id, provider_id or null for any, claim, values)`.
- **Rules are evaluated at each sign-in** from the identity's claims: an OIDC claim (`groups`), an LDAP attribute
  (`memberOf`), a SAML attribute, or `email_domain`. Values match case-insensitively; a list claim matches when any
  element does. The sign-in replaces the user's `rule` memberships; `manual` ones are kept.
- Memberships from rules are updated at sign-in, when rules change, and daily (LDAP lookups, OIDC refresh tokens). Disabling a user is immediate.

### D.4 Enforcement
- `access.authorize(actor, permission, project_id) -> Decision(allowed, role, via, reason, required)` is the only
  check. `require_project_access`, `is_authorized_user(..., project)` and `ingest_access` call it.
- **403 body** (`reason: missing_role`): `{"error", "reason", "required": "developer", "project", "owners": [...],
  "can_request": true}`. Owners are listed only to signed-in users.
- **Ingest** (`qa run`, `qa batch`): a signed-in sender without `runs.ingest` is refused with `ingest.auth=token`, and
  saved as unverified otherwise (as today for anonymous senders). Per-project ingest policies are M5.
- **Files** under `/s/`: the storage folders of projects that aren't public are protected like the YAML's restricted
  projects (`restricted_project_dirs`), and readers need `project.read`. Tokens' project patterns apply to files too.
- **Holes closed**: `GET /output/<id>` and `/manifest` (no check, and the manifest wrote on GET), `GET /tests/groups`,
  milestone references in comparisons, Jenkins triggers (no auth).
- **Tests**: an integration matrix runs every project endpoint as an outsider, a viewer and a developer on a private
  project, and `test_security.py` checks every route declares a policy.

### D.5 API
Project access (`project` is an id or a prefix; managing needs `project.access`):
- `GET /api/v1/project/access?project=a/b` → `{project, my_role, via, can_manage, visibility: {own, effective,
  inherited_from, default}, owners: [{type, id, name}], grants: [{id, subject: {type, id, name, full_name},
  role, resource_id, inherited, source, expires_at, granted_by, granted_at}], requests: [...] (managers)}`.
  Non-managers see their role and the owners, not the grants.
- `POST /api/v1/project/access/visibility` `{project, visibility: public|internal|private|null}` (null: inherit).
- `POST /api/v1/project/access/grants` `{project, subject: {type: user|group, id}, role, expires_at?}` → the grant.
  Same subject and resource: updates the role.
- `DELETE /api/v1/project/access/grants/<id>`. An owner can't remove the last owner grant of a project (unless admin).
- `POST /api/v1/project/access/requests` `{project, role, message}` (signed in) → the request; one pending per user
  and project. Owners get an email, the user an email when decided.
- `POST /api/v1/project/access/requests/<id>` `{decision: approve|deny, role?}` (managers): approving grants the role.
- `GET /api/v1/directory?q=` (signed in) → `{users: [{id, user_name, full_name}], groups: [{id, name}]}`, 10 each,
  for the member picker.

Admin (`/api/v1/admin/...`, admins):
- `groups` GET (with member and rule counts), POST `{name, description}`; `groups/<id>` GET (members, rules),
  POST, DELETE; `groups/<id>/members` POST `{user_id}`, `groups/<id>/members/<user_id>` DELETE;
  `groups/<id>/rules` POST `{provider_id?, claim, values}`, `groups/<id>/rules/<rule_id>` DELETE.
- `grants?resource_type=instance` GET, POST `{subject, role}`, `grants/<id>` DELETE: roles on all projects for a user
  or a group (e.g. the QA team as viewers), private ones included.
- The overview's checklist flags `projects.signed_in_role: developer` and projects without owners.

Audit: `grant.create|update|delete`, `visibility.update`, `group.*`, `group_member.*`, `group_rule.*`,
`access_request.*` with the project.

### D.6 Web app
- **Project → Access** (`/<project>/access`, in the project's sidebar): visibility (managers change it, inherited
  values say from where), members with role, source, inherited-from and expiry, add a user or group, pending requests.
  Others see their role, the owners, and **Request access**.
- **403 on a project page**: "You don't have access to a/b", the owners, and Request access.
- **Admin → Groups**: groups, members, rules (with the claims of recent sign-ins as hints). **Admin → Overview**:
  the roles on all projects, `projects.signed_in_role`, and the recommendations.
- The CLI's 403s say whom to ask: "Ask an owner of a/b for the developer role: <url>/a/b/access".

### D.7 Later in M3
- **YAML import** (`qaboard-admin import-restrictions`): `projects:` keys become private visibility and grants,
  `data:` rules become groups with rules, `login:` stays a sign-in rule.
- `auth.reauthenticate_after` for SSO sessions.

### D.8 As built (2026-10-21)
- **No seed grant**: an instance grant `everyone → developer` would have overridden `private`. The baseline is
  `projects.signed_in_role` instead, which only applies to public and internal projects. No built-in groups.
- **Files**: every project's storage folders are mapped (cached 5 minutes, for new projects); visibility and roles
  are checked live, so making a project private protects its files at once. Public projects read without a token
  skip loading grants: nginx asks for each file.
- **Checks**: `login_required`'s `?project=` needs `project.read`; endpoints that change runs call
  `require_project_access`, which defaults to `runs.act`. `test_security.py` fails for a route that loads projects,
  runs, batches, commits or milestones without a check (an allow-list says why for the others).
- **Found on the way**: changing, deleting or redoing a run only checked that the user could see the project, tuning
  and exports needed nothing more than reading, the run and manifest GETs had no check (the manifest one wrote a file).
- **Jenkins**: the CLI's Jenkins runner triggers builds without a user, so `jenkins/build/trigger` stays as it was
  without a project; the web app sends the project, and then needs a developer.
- **Groups' updates** (`jobs/groups.py`, the *Users' groups* schedule): daily and when rules change. LDAP: one lookup
  per account on one connection (not a scan of the groups: it works with any user filter, and reads names and emails
  too), `memberOf` or `QABOARD_LDAP_GROUP_ATTRIBUTES`, AD nested groups on request; over 20% of accounts not found
  changes nothing. OIDC, opt-in per provider (`refresh_groups`): `offline_access`, refresh tokens encrypted on
  `user_identities`, `invalid_grant` forgets the identity's claims and revokes its sessions. Rules read each sign-in
  method's last claims (`identity.claims`, the directory's under `ldap`): one method doesn't undo another's groups.
  The LDAP search only fetched `cn` and `mail` before: `memberOf` rules could never match.
- **Not yet** (D.7): the YAML import (left to admins), `auth.reauthenticate_after`, the GitLab job endpoints' mapping
  to projects, SCIM (M6: push-based, instead of daily pulls).
