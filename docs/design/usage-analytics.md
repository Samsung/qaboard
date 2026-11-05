# Usage analytics: design and plan

Status: decided 2026-11-03, M1-M3 in progress. Section 12 has the contract as built.

## TL;DR

- **Own the events, in our PostgreSQL.** A single `usage_events` table, written by the backend, with a PostHog-shaped
  event (`event`, who, `properties`, `timestamp`). Two producers: the web app (page views and feature events) and the
  `qa` CLI (one event per invocation by a person, never from CI). The backend records nothing by itself: what the
  server sees also includes automation, we want what people do. ~100 users at SIRC: that's tens of thousands of rows a day at most, nothing
  to shard or stream.
- **Keep the door open to PostHog and friends** with a server-side *forwarder*: the backend can replay every event to
  a PostHog-compatible `capture` endpoint (or a Segment-compatible one) when a key is set. We don't take a dependency
  on their SDKs for the pipeline: `posthog-js` stays what it is today, optional in the browser when a key is set.
- **Admin → Usage**: value metrics, trends and leaderboards (users, groups, projects), and a per-project adoption
  ladder (CI sends runs → people look → people start tuning → milestones, exports, annotations). CSV export of every
  table, and two SQL views for Metabase, which already reads this database.
- **Admin → Overview** gets a "Get more from QA-Board" list next to the security checklist: what's not configured yet
  (notifications, SSO, webhooks, Sentry...) and what the usage data says (projects with CI runs nobody looks at, users
  who never used the CLI...).
- Why not the alternatives: a second PostHog instance is a ClickHouse + Kafka deployment for 100 users; Umami,
  Plausible and Matomo do page views, not feature events from a CLI with a verified user; RudderStack and Jitsu are
  event *routers*, not stores, and would still need a destination. Sentry is already there for errors and performance,
  not for "who uses what".

## 1. Where we are (verified)

- `webapp/src/analytics.js` has `track(event, properties)`, which only does something when `POSTHOG_API_KEY` is set:
  then `posthog-js` is downloaded and gets the events. Four events exist: `command_palette_open`, `command_palette_select`,
  `release_notes_popup`, `release_notes_open`. Nothing is tracked otherwise. Sentry (errors, traces, replays) is separate.
- The admin Overview counts users, admins, pending, disabled, active tokens, and "active in the last 30 days" from
  `User.last_login_at`. Sessions slide for `sessions.idle_days`, so that count is the people who *signed in* recently,
  not those who used QA-Board: it undercounts. The security checklist (`backend/api/admin.py`) is the only "what to fix"
  list.
- We already know a lot about *runs*: `Batch.origin` (`webapp`, `local`, `ci`), `Batch.user_id` (verified when a
  token or the web app sent it), `output.data.origin`, `run_context` (CI provider, who triggered it). The Activity
  page and the home page use them. What we don't know: who *looks* at results, and `qa` invocations that don't talk
  to the server (`qa run` and `qa batch` without `--share`, `qa get`, `qa sync`...).
- The audit log (`backend/audit.py`, `audit_events`) records security events in the request's transaction, with
  `actor_kind`, user, token, IP, user agent, `project_id`, `changes`, `meta`, and a retention setting. The usage
  pipeline copies its shape and style, but stays a separate table: different retention, volume, and readers.
- Users have groups (`groups`, `group_members`, synced from LDAP and OIDC claims daily): "usage by team" is a join away.
  Projects are strings with the subproject path (`repo/subproject`): "usage per product and subproject" is a `GROUP BY`.
- The jobs worker runs nightly maintenance (storage usage, groups): the place for retention and any rollup.
- Metabase at SIRC reads the QA-Board database directly (`deployments/sirc/metabase.yml`).
- The `qa` CLI knows if it runs in CI (`config.is_ci`, `run_context()`), has a server URL and a token from
  `qa auth login` (`api.headers_for`), an `--offline` flag, and already does one cheap network call a day
  (`check_for_updates`, PyPI, 1s timeout).

## 2. Principles

1. **Never in the way.** Events are batched and sent in the background, with `sendBeacon` when the page hides. The
   CLI sends its event from a daemon thread with a short timeout and never prints anything about it. A failed send is
   dropped silently. The endpoint does one `INSERT` with many rows, no ORM objects.
2. **Identity is the server's.** Who did it comes from the request's actor (session or token), never from the event's
   body. The only exception is the CLI without a token: it sends the user name it runs as, which is recorded as
   *unverified* (like results sent without a token, `ingest.auth`), and matched to accounts by `user_name`.
3. **Events say what people did, not what the page showed.** Named after user intents (`commit_compare`,
   `tuning_start`, `image_viewer_pixel_pin`), with a short allowlist of properties. No free-text, no URLs with query
   strings, no pixel values, no file paths beyond the project. Sizes are capped server-side.
4. **Producers record, the server stores.** The web app records views, interactions and the actions it starts
   (batches, exports, milestones); the CLI records its invocations. The backend doesn't add events of its own:
   server-side it can't tell people from automation. Nothing is recorded twice.
5. **Raw, kept forever.** The dashboard queries the raw table with the right indexes. At our volume a month is a
   few hundred thousand rows: no retention job and no rollups until a query is slow (M4).
6. **Everything is exportable.** CSV from every table of the dashboard, SQL views for Metabase, an admin CLI command.
   Admins own the data; it doesn't leave the server unless they configure a forwarder.
7. **Users see their own usage** (Settings → Activity). Admins see everyone's. Fair, and it makes "QA-Board records
   what you do" a feature rather than a surprise.

## 3. Data model

```sql
CREATE TABLE usage_events (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMP NOT NULL,            -- when it happened (the client's time, clamped to ±1 day of receipt)
  received_at   TIMESTAMP NOT NULL DEFAULT now(),
  source        TEXT NOT NULL,                 -- webapp | cli
  event         TEXT NOT NULL,                 -- snake_case, see the catalog
  user_id       INTEGER,                       -- no FK: events outlive accounts
  user_name     TEXT,                          -- as known at the time, or the CLI's unverified name
  verified      BOOLEAN NOT NULL DEFAULT true, -- false for CLI events sent without a token
  client_id     TEXT,                          -- the browser's random id, to count distinct anonymous visitors (the CLI sends none)
  project_id    TEXT,                          -- repo/subproject, when the event is about a project
  properties    JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_usage_events_created_at ON usage_events (created_at);
CREATE INDEX ix_usage_events_user_created ON usage_events (user_id, created_at);
CREATE INDEX ix_usage_events_project_created ON usage_events (project_id, created_at);
CREATE INDEX ix_usage_events_event_created ON usage_events (event, created_at);
```

Settings (`backend/settings.py`, overridable by the environment like the others):

| Setting | Default | |
|---|---|---|
| `analytics.enabled` | `true` | Off: the endpoint answers 204 and records nothing, the web app doesn't send (it reads `analytics_enabled` from `/api/v1/config`) |
| `analytics.forward_url`, `$ANALYTICS_FORWARD_KEY` | none | M4: a PostHog-compatible `capture` endpoint, or Segment-compatible, that gets a copy of every event |

No retention setting for now: the data is small, and we keep it all. One comes with the rollups if ever needed.

Views for Metabase and SQL users, created by the migration and documented in the admin docs:

- `usage_events_v`: events joined with the user's `user_name`, `full_name`, and the project's root (first path
  element) as `product`.
- `usage_daily_v`: `day, user_name, product, project_id, source, event, count(*)`.

## 4. The ingestion API

`POST /api/v1/events` with `{"events": [{event, properties, timestamp?, project_id?, client_id?}]}`, at most 100
events and 64 KiB per request, answered with 204. The actor gives `user_id`/`user_name`; `source` is what the body
says, `webapp` (default) or `cli`. With `auth.require_sign_in` off, anonymous page views are recorded with no user and
the browser's `client_id`.

From the CLI without a token, the body may carry `user_name`: recorded with `verified = false`. The endpoint is in
`INGEST_ENDPOINTS` so it follows `ingest.auth`: with `token`, unverified events are dropped (204 anyway).


## 5. Event catalog (first version)

Properties in parentheses. Every event also gets `project_id` when it's about a project, and from the web app the
`route` (the pattern of `route_paths`, e.g. `commit`, `history`, `dashboard`).

**Web app, views** (`webapp/src/analytics.js`, on `pathname` changes, not on every query-string change):

- `page_view` (route, project_id, commit_id, batch_label, has_reference, view: the commit page's tab)
  → active users, distinct commits looked at, which pages matter.

**Web app, interactions and actions** (where the feature is used; one event per feature per output opened, so
holding a zoom key doesn't send 200 events):

- `commit_compare` (same_branch) when a reference commit is chosen or changed
- `output_open` (viewer: images | video | plotly | text | html | pointcloud | flame_graph | junit | bit_accuracy | tof | slam | ...)
- `image_viewer_use` (feature: compare | pixel_pin | region | histogram | analysis | annotations | colormap | adjustments)
- `batch_start` (kind: tuning | automated_tuning | run_tests | redo, n_runs) when the web app starts one
- `batch_stop`, `batch_delete`, `export_start`, `milestone_save`
- kept: `command_palette_open`, `command_palette_select`, `release_notes_popup`, `release_notes_open`

**CLI** (`qaboard/analytics.py`, one per invocation, **only when not in CI**: `is_ci` is false, which also excludes
the runs QA-Board starts, they set `CI`):

- `cli_command` (command: run | batch | get | sync | wait | postprocess | save-artifacts | init | auth | optimize,
  version, python, os, runner, share, tuning: bool, dryrun, n_batches, duration_s, exit_code)

Not recorded: anything from `--offline` or `QA_NO_ANALYTICS=1`, Python API uses of `qaboard` without the CLI,
hostnames, paths, input names, metric values. `--share` is on by default in many repositories and semi-deprecated:
the CLI event is sent whether or not results are, it's the only trace of `qa run` and `qa batch` on people's machines.

## 6. The clients

**Web app.** `track()` keeps working as is for `posthog-js`, and also appends to a queue flushed every 10 s, at 20
events, and on `visibilitychange: hidden` / `pagehide` with `navigator.sendBeacon`. The `client_id` is a UUID in
`localStorage`. Page views come from a `useLocation` effect in `App.jsx`, with the route pattern already computed
for Sentry (`route_name`). Feature events are one-liners where the feature lives; the image viewer package stays
free of the app (its adapter in `viewers/images/` gets an `onUse(feature)` callback, the way it gets its providers).

**CLI.** `qa`'s group callback records the command and starts a timer; when the command ends (`main()` catches
`SystemExit` to know the exit code), the event is sent from a daemon thread with 1 s connect and 2 s read timeouts,
joined for at most 1 s so `qa` never hangs on a slow server. Nothing is printed, whatever happens. The sending reuses
`api.headers_for` (the token from `qa auth login`, `$QABOARD_TOKEN`...) and `api_verify`. It's skipped when `is_ci`,
`--offline`, `QA_NO_ANALYTICS`, or there is no server URL. The server drops the event when `analytics.enabled` is
off (204): no extra request to ask first.

**Forwarder (M4).** A worker-side loop (or the request's `after_request` with a bounded queue) POSTs batches to
`analytics.forward_url` in PostHog's `batch` format (`api_key`, `batch: [{event, distinct_id, properties, timestamp}]`),
with `$pageview`/`$current_url` mapping for `page_view`, or Segment's `track`/`page`/`identify`. Same identity rules:
`distinct_id` is the user name. One module per format, 50 lines each.

## 7. Admin → Usage

A new tab, `/admin/usage`, with a period selector (7 d, 30 d, 90 d, 12 months) and a product/project filter.

**Headline numbers** (tiles, with the previous period's value for the trend):

- People: active in the web app, active in the CLI, both; new users; of which unverified CLI users
- Looking: commits looked at (distinct), comparisons, outputs opened, image viewer sessions
- Doing: batches started from the web app (tuning, automated tuning, run tests, redo), `qa batch` from terminals,
  runs shared by people, exports, milestones saved

**Trends**: weekly active users (web, CLI) and weekly commits looked at, as lines; batches started by kind, as bars.
(The Activity page's timeline bars, `activity/format.jsx`, are the style to reuse for bars; Plotly is already in the bundle for the lines.)

**Leaderboards** (top 25, CSV of everything): users (active days, commits looked at, batches started, last seen),
groups (same, members active / members), projects and products (same, plus runs from CI for scale).

**Adoption per project** (the table for "is it used, and how much"):

| project | CI runs / week | people looking | commits looked at | tuning | milestones, exports, annotations | status |
|---|---|---|---|---|---|---|

with `status` ∈ {active, **CI only** (runs, no one looks in 90 d), **quiet** (no runs and no looks), new}.

**Per user** (`/admin/users/:id`, a Usage section): their last 30 days by event, and the projects they look at.
**For users** (Settings → Activity): the same, about themselves.

Everything is one API, `GET /api/v1/admin/usage/{summary,timeseries,users,groups,projects}?since=&until=&project=`,
plus `?format=csv`. Queries hit `usage_events` with the indexes above, plus `batches`/`outputs` for CI volume
(the `run_activity` indexes). `qaboard-admin usage export --since 2026-01-01 > usage.csv` for scripts.

## 8. Admin → Overview: "Get more from QA-Board"

A second list under the security checklist, same `item(id, ok, severity, title, detail)` shape, each linked to its
docs page or admin tab. First items (configuration, no usage data needed):

- Email notifications aren't configured (`email_enabled()`): users can't be told when their batches end.
- No single sign-on provider: everyone signs in with local accounts / LDAP only.
- No git host webhooks: commits appear only once runs arrive, branches and messages come late.
- Sentry isn't configured: errors in users' browsers and in `qa` go unreported.
- No annotation sources, no storage garbage-collection schedule, no image server for raw formats.
- Projects have no owners (M3 roles): nobody can add members or restrict access.

Then, from the usage data (M3):

- *N* projects get CI runs nobody looked at in 90 days: deprecate them, or show their teams around.
- *N* users active in the web app never used the CLI (`cli_command` or `qa auth login`): they only read results.
- *N* products use QA-Board without tuning: automated tuning isn't known there.

These are what an admin can act on; which of them we present as "upsell" (support, integrations) is a wording
question for the SIRC deployment, not a code one.

## 9. Privacy and security

- Admin-only reads; events of users are visible to them (Settings → Activity) and to admins.
- No IP addresses, user agents, or URLs in usage events (the audit log keeps those, for security events, with its
  own retention). Properties are an allowlist per event; unknown keys are dropped, strings cut at 200 chars.
- Anonymous web visitors (when sign-in isn't required) are a `client_id`, never resolved to a person.
- The endpoint is rate-limited per actor (1000 events / minute) and sized (100 events, 64 KiB per request).
- `analytics.enabled = false` stops everything; the docs say what's recorded, in the admin and user guides.

## 10. Milestones

**M1: the pipeline, and the web app** (backend + webapp, one PR each)
- Migration, `UsageEvent` model, `backend/usage.py` (validation, allowlists, inserts), `POST /api/v1/events`,
  the `analytics.enabled` setting, tests with the PostgreSQL fixtures.
- `webapp/src/analytics.js` queue + beacon, page views, the interaction events of section 5, `client_id`, tests.
- Docs: admin page "Usage analytics" (what's recorded, settings, Metabase views), release note.

**M2: the CLI** (qaboard, one PR)
- `qaboard/analytics.py`, hook in `qa.py`, `QA_NO_ANALYTICS`, nothing from the commands `qa batch` starts, tests (no
  network in tests: the sender is injected), docs in the CLI reference and in the admin page, release note.

**M3: Admin → Usage and the Overview list** (backend + webapp, two PRs)
- `GET /api/v1/admin/usage/*`, CSV, `qaboard-admin usage export`; the tab, tiles, charts, leaderboards, adoption
  table; per-user section; Settings → Activity for users; the "Get more from QA-Board" list; `active_30d` from usage.
- The user guide and admin docs pages, release note highlights.

**M4: later, as needed**
- Forwarders (PostHog-compatible, Segment-compatible), daily rollups and a retention setting if the dashboard is
  slow, more events.

Rough sizes: M1 is the largest (two days of work), M2 half a day, M3 two days, M4 a day. M1 and M2 can start together;
M3 needs a week of real data to tune what's shown, the tables come first.

## 11. Decisions (2026-11-03)

1. CLI: one event per invocation, sent without blocking the command.
2. CLI without a token: the user name it runs as, recorded unverified. A cloud version would require signing in anyway.
3. Leaderboards: admin-only. Users see their own numbers.
4. Image viewer and other feature events: the short list of section 5, no more for now.
5. Retention: none, keep everything. The data is small.
6. No server-side events: the producers (web app, CLI) send them. Server-side, people and automation look alike.

## 12. The contract, as built

**`POST /api/v1/events`** (and `/api/v1/events/`), JSON, also accepted as `text/plain` (what `sendBeacon` sends):

```json
{"source": "webapp", "events": [
  {"event": "page_view", "timestamp": "2026-11-03T10:00:00.000Z", "project_id": "repo/sub",
   "client_id": "9a1d…", "properties": {"route": "commit", "commit_id": "abc123", "has_reference": true}}
]}
```

- `source`: `webapp` (default) or `cli`. The CLI also sends a top-level `user_name`, used only when the request
  carries no session or token: the event is then `verified = false`, `user_id` is the account with that `user_name` if
  any. With `ingest.auth = token`, unverified events are dropped.
- Limits: 100 events and 64 KiB per request (413 above), 1000 events per minute per actor (429). Event names match
  `^[a-z][a-z0-9_]{0,63}$`, properties have at most 40 keys matching `^[a-z_][a-z0-9_]{0,63}$`, values are strings
  (cut at 200 chars), finite numbers, booleans, null, or lists of at most 20 of those. `project_id` is cut at 500
  chars, `client_id` at 64. `timestamp` is ISO 8601, clamped to [now − 1 day, now + 5 min], missing means now.
- Answers 204 when stored, or dropped (`analytics.enabled` off, unverified with `ingest.auth = token`); 400 when the
  body isn't a JSON object with an `events` list. Never an error for a bad event: it's dropped.
- The endpoint is in `INGEST_ENDPOINTS`: anonymous requests reach it when sign-in is required, like results do.

**`GET /api/v1/config`** gets `analytics_enabled`.

**Admin usage API** (admin only; `since`/`until` ISO dates, defaults: the last 30 days; `project` filters by project
id or by product, the first path element; `format=csv` on the tables):

- `GET /api/v1/admin/usage/summary` → `{since, until, counts, previous_counts}` with `users`, `web_users`,
  `cli_users`, `new_users`, `unverified_cli_users`, `commits_viewed` (distinct project + commit of `page_view`),
  `comparisons`, `outputs_opened`, `image_viewer_uses`, `batches_started` (web `batch_start` + CLI `batch` commands,
  not dry runs), `batches_started_by_kind` (tuning, automated_tuning, run_tests, redo, cli), `cli_commands`,
  `exports`, `milestones`, `ci_runs` (runs of batches with origin `ci`, from the `outputs` table).
- `GET /api/v1/admin/usage/timeseries?bucket=day|week` → `{buckets: [{start, web_users, cli_users, commits_viewed,
  outputs_opened, batches_started, cli_commands}]}`, weeks start on Monday.
- `GET /api/v1/admin/usage/users` → `{users: [{user_id, user_name, full_name, verified, active_days, web_events,
  cli_commands, commits_viewed, batches_started, last_seen_at, projects: [top 3 project ids]}]}`, most active first.
- `GET /api/v1/admin/usage/groups` → `{groups: [{group_id, name, members, active_members, active_days, commits_viewed,
  batches_started, cli_commands}]}`.
- `GET /api/v1/admin/usage/projects` → `{projects: [{project_id, product, people, commits_viewed, outputs_opened,
  batches_started, cli_commands, ci_runs, status}]}`, `status` ∈ `active` (people looked), `ci_only` (CI runs, nobody
  looked), `quiet` (neither, but activity in the previous period), `new` (first event ever in the period).
- `GET /api/v1/admin/usage/events?format=csv` → the raw events of the period, for spreadsheets.
- `GET /api/v1/admin/usage/users/<user_id>` and, for users about themselves, `GET /api/v1/user/usage` →
  `{since, until, total, active_days, first_seen_at, last_seen_at, by_event: [{event, count}],
  by_project: [{project_id, count}]}`.
- `GET /api/v1/admin/overview`: `counts.active_30d` becomes the users with a usage event or a sign-in in 30 days,
  and `value_checklist` lists what to configure or look at (section 8), in the security checklist's item shape.
- `qaboard-admin usage export --since --until [--format csv|json]` writes the raw events to stdout.

**Web app**: `webapp/src/analytics.js` keeps `track(event, properties, {project_id})`: it feeds `posthog-js` when
configured, and the queue to `/api/v1/events` when `analytics_enabled`. `/admin/usage` is the new admin tab,
`/settings/activity` shows users their usage above their sign-ins, `/admin/users/:id` gets a Usage section.

**CLI**: `qaboard/analytics.py`, `cli_command` with `command`, `version`, `python`, `os`, `share`, `tuning`,
`dryrun`, `runner`, `n_batches`, `duration_s`, `exit_code`; `project_id` as the server knows the project.
