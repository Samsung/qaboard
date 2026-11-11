# RFC: a project's Admin pages, with the gate's and alerts' settings

Status: accepted for a first step, November 2026. Step 1 ships with this RFC, steps 2 and 3 are designed here and
not built. Related: `docs/quality-ledger-plan.md` (the project admin page, items 3, 4 and C),
`docs/design/user-management.md` (roles and the Access page), `website/docs/quality-gate.mdx`.

## Why
A project's owners can change one thing from the web app: who has access. Everything else about how QA-Board
judges a project is in *qaboard.yaml*, which is right for what belongs with the code, and wrong for two things:

1. **Rules that a commit must not be able to change.** The gate's rules are in the commit it checks. A person or a
   coding agent can loosen a rule in the same commit that breaks it. `qa gate` now says so (`rules_changes`), but
   it's information: nothing holds.
2. **Things that aren't about one commit.** Who is told when quality regresses, and where (emails, a chat
   channel), is the team's business, changes without a commit, and has secrets (webhook URLs) that can't be in a
   repository.

## What owners get
A project's sidebar has **Admin** where it had **Access**, with three pages. Each page starts with the same tabs, so
they also work as one place: *Access*, *Quality gate*, *Alerts*.

| Page | URL | Who sees it | Step |
|---|---|---|---|
| **Access** | `/<project>/access` (unchanged) | everyone, to see the owners or ask for access; owners manage | exists |
| **Quality gate** | `/<project>/admin/gate` | viewers read, owners change | 1 |
| **Alerts** | `/<project>/admin/alerts` | owners | 2 |

"Owners" means the `project.access` permission: the project's owners, and the server's admins. The same permission
guards the new settings: someone who can decide who writes to a project can decide its rules. We don't add a role.

### Quality gate page (step 1)
- **The rules in *qaboard.yaml***, read-only: the `gate:` section of the reference branch's latest configuration,
  as a table, with a link to the docs. This is what a commit is checked against unless it changes them.
- **Project rules**, edited here: rules in the same vocabulary (a metric, `max_regression`,
  `per_test_max_regression`, `min` or `max`, an aggregate), a limit on failed runs, and whether outputs must be
  bit-accurate. They apply to every commit of the project, on top of the commit's own rules, and no commit can
  change them. In the gate's table they're marked *project rule*.
- **When a commit loosens its rules**: *say so* (default, what `qa gate` does today) or *fail the gate*. With
  *fail*, a commit whose `gate:` section is looser than the reference's fails, until an owner makes the change
  themselves: the looser rules become the reference's when the commit is merged by people who decided to.

The page says who changed the project rules last, and when. Changes are in the audit log.

### Alerts page (step 2, not built)
- Who is told: email addresses, and a chat webhook (Slack, Teams, Mattermost), stored encrypted, shown masked.
- About what: *the gate failed* on the reference branch, or on any branch. Later: a metric stepped on the reference
  branch (the plan's regression alerts), a batch has failed runs.
- A **Send a test alert** button.

Alerts need the server to know the gate's verdict: see step 2 below.

## Design

### Where settings are kept
A table, `project_settings`: one row per project, `data` (JSONB), `updated_at`, `updated_by_id`. Not
`projects.data`: any viewer reads it through the API, and pushes to the reference branch replace parts of it.

```json
{"gate": {"rules": [{"metric": "latency_p99", "max_regression": "10%"}], "max_failed_runs": 0,
          "require_bit_accuracy": false, "on_looser_rules": "warn"}}
```

- The gate's settings are stored as written, in *qaboard.yaml*'s format, and validated when saved with the CLI's
  own parser (`qaboard.gate.parse_config`): one vocabulary, one validation.
- Settings are per project, not inherited from parent folders like access is. Subprojects of a monorepo are
  projects of their own, with their own rules.
- Step 2 adds a `secrets` column for the webhook URL, encrypted like the server's settings
  (`backend/encryption.py`), and registers it for key rotation.

### API
| Call | Needs | |
|---|---|---|
| `GET /api/v1/project/settings?project=` | `project.read` | The project's gate settings, `can_manage`, who changed them, and the reference branch's `gate:` section. |
| `POST /api/v1/project/settings/gate` `{project, gate}` | `project.access` | Validates, saves, audits `project_settings.update` with what changed. `gate: null` removes them. |

`GET /api/v1/commit/<sha>/compare` gains `project_gate`: the project's gate settings, or `null`. That's how
`qa gate` learns them, with the numbers, in the request it already makes.

### What `qa gate` does with them
- **Project rules are checked like the commit's**, after them, and marked `source: project` in the JSON, *project
  rule* in the tables. A rule that is in both is checked twice, each with its limit: no merging to explain.
- `max_failed_runs` and `require_bit_accuracy`: the stricter of the commit's and the project's applies.
- `on_looser_rules: fail` adds a check, *gate rules*, that fails when `rules_changes` has a looser rule. Without the
  reference's configuration on the server, it can't decide: the check is `unknown`, and the gate undecidable.
- An older `qa` ignores `project_gate`: project rules need the version that reads them. The page says which version.
- Offline, or with a server that doesn't answer, `qa gate` is undecidable, as today.

Trust: `qa gate` runs in the project's CI, which a commit can also change. Project rules don't make the gate
tamper-proof; they make loosening it a visible act in a place commits don't reach. The verdict recorded by the
server (step 2) is what closes more of the gap.

### Navigation
- `AppSider`: **Admin** (`cog`), a link to the Access page with a submenu: Access, Quality gate, Alerts (step 2).
  It's where Access was, on the same pages.
- Routes: `/:project_id+/admin/:section(gate|alerts)`, before the project's catch-all, like `/access`. A project
  whose id ends in `/admin/gate` would collide, as one ending in `/access` does today.
- `ProjectAdminTabs` at the top of each page, the navbar blanked like on the Access page.

## Steps
1. **This RFC's implementation**: the table and its migration, the API, the Quality gate page, the Admin menu and
   tabs, `qa gate` reading project rules and `on_looser_rules`, docs, tests.
2. **The verdict on the server, and alerts.** `qa gate` reports its result (`POST /api/v1/commit/<sha>/gate`, with the
   `runs.ingest` permission); the server keeps it with the batch, shows it on the commit, and sends the project's
   alerts. This is the ledger's second column (`docs/quality-ledger-plan.md`).
3. **Regression alerts** on the reference branch, configured on the same page (the plan's item 4).

## Not doing
- **Editing *qaboard.yaml*'s rules from the web app.** They belong to the commit. The page shows them.
- **A new role** between developer and owner.
- **Rules inherited from parent folders.** Possible later, like access: needs "which rule came from where" in the page.
- **Approvals** ("an owner accepted these looser rules"): the plan's item D, "record the decision".

## Open questions
1. Should *fail* be the default for `on_looser_rules` on new projects? It's safer, and it surprises the first person
   who tunes a threshold on a branch.
2. Project rules per batch? Today they apply to every batch `qa gate` checks.
3. Should developers see who gets alerts (step 2)? Today's answer: owners only, like members' emails.
