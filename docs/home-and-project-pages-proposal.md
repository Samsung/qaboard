# Proposal: a home page and project pages centered on the user

Status: proposal, nothing implemented. October 2026.

## The problem

- **Home** (`webapp/src/ProjectsList.jsx`) is a flat list of every project you can see, sorted by latest run. With
  hundreds of projects (subprojects included), most of what it shows belongs to other people, or is CI that nobody looks
  at. Pins are the only personal thing on it, and you have to set them yourself.
- **Project page** (`webapp/src/CiCommitList.jsx`) shows every commit with results, grouped by day. For each commit
  it shows the `default` batch (the CI's) first, and your tuning batches end up as "N other batches" in a tooltip.
  That's backwards for people who use the web app to tune: their experiments are what they came for.
- What we built recently (What's new, `/activity`, `/storage`, the user guide) can only be found through navbar
  buttons and the sidebar.

## Telling "mine", local runs and CI apart

What we have today isn't enough:

| Signal | Where | Why it's not enough |
|---|---|---|
| `Batch.label == 'default'` | `models/Batch.py` | many CI jobs use a custom `--label` |
| `job_type: ci\|local`, from `CI`/`GIT_COMMIT` in the env (`qaboard/config.py: is_ci`) | `batch.data.type`, `output.data.ci` | runs started from the web app export `CI=true` (`api/tuning.py`), so they look like CI; the last upload overwrites `batch.data.type` |
| `Batch.data.submissions[*].user` | `submissions.py` (partial index `ix_batches_submissions`) | reliable for the web app, but JSONB, and only in batches started from it |
| `data.submitted_by` (verified) / `data.user` (claimed) | batches and outputs | reliable when the run was sent with a token; service accounts (`User.kind == 'service'`, `qab_svc_` tokens) are CI by definition |
| `CiCommit.committer_name` | git display name | doesn't match user names; the CLI already sends `commit_committer_email`, but the server only keeps it in the committers map (redis), not on the commit |

So we record more, at ingest:

- **The CLI sends where it runs**, `run_context`:
  - `origin`: `webapp` when the server started it (the generated `qa_batch.sh` exports `QABOARD_SUBMISSION_ID`,
    which also links the runs to their submission), `ci` when a CI provider's variables are set (`GITLAB_CI`,
    `GITHUB_ACTIONS`, `JENKINS_URL`, `BUILDKITE`, `TF_BUILD`…, then plain `CI`), else `local`.
  - for CI: provider, pipeline/job URLs, and who triggered it (`GITLAB_USER_EMAIL`, `GITHUB_ACTOR`) when available.
- **The server decides**, in this order: a submission id → `webapp`; a service account token → `ci`; else what the
  CLI says; old clients: `job_type` + submissions, as today. Stored per run and per batch (`mixed` when its runs disagree).
- **Commits keep `committer_email`** (a column, from what the CLI already sends).
- **"Mine" uses verified emails**: the account's email from the sign-in provider (LDAP, SAML, OIDC) matches
  `committer_email`; batches are mine when their verified submitter or submission user is me. Claimed users
  (`QA_USER`, no token) count too, marked "unverified" as today. Users can add other git emails in their profile.

## Proposal

### 1. Backend: make "mine" and "where it came from" cheap to query

- **New columns**, filled at ingest (see above), backfilled from `data` as well as we can for old batches:
  - `batches.origin` (`webapp` | `local` | `ci` | `mixed`), `batches.user_id` (verified) and `user_name`, indexed,
  - `batches.latest_output_datetime`, so "recent batches" doesn't scan outputs,
  - `ci_commits.committer_email`, indexed.

  Filtering JSONB on every page load works for one project, not for a home page that spans all of them.
- **User identities**: the verified email from sign-in, plus git emails users add in Settings > Profile ("Commits
  with these emails are yours"). One helper, `is_mine(commit)`, used everywhere.
- **APIs**
  - `/api/v1/commits?scope=mine|all&origin=webapp,local,ci`: "mine" = I committed it **or** one of its batches is mine.
    The response also gives the count in the other scope, so the page can say "12 yours, 340 in total".
  - `/api/v1/me/home`: everything home needs in one query: my running/pending batches, my recently finished batches
    (status, failures, key metric vs its reference), my projects (by my recent activity, then pins), and the latest
    CI result on the reference branch of those projects.
  - `/api/v1/projects`: add `root` (top-level project), `subprojects` count, `my_latest_activity`, and runs per day
    over 30 days (a sparkline, from the `batches` table, cheap once indexed).

### 2. Project page: your experiments first, everyone one click away

```
 kitefin/k3                                          [ Yours ▾ | Everyone ]  [ branch: all ▾ ]  [ Batches | Commits ]
 ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ master @ e4f5a6b (bob) · CI  ✓ 1,204 runs  · 2h ago · psnr 41.2 (=)                                           │  ← always: head of the reference
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 Showing your 12 batches of the last 30 days · 340 by everyone  →  Show everyone's
 ┌ Running ──────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ● denoise-sweep-3   on a1b2c3d  feature/denoise   web app   ▓▓▓▓▓▓░░ 312/480   ETA 14 min   [Logs] [Stop]   │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ┌ Yesterday ────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ☐ denoise-sweep-2   on a1b2c3d  feature/denoise   web app   ✓ 480   psnr 41.9 (+0.7 vs master)              │
 │ ☐ jane 🏠 local      on 9f8e7d6  feature/denoise   local     ✓ 20 ✗ 3                                         │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                     [ Compare selected (2) ]
```

- **Scope switch, defaulting to "Yours"** when you're signed in and have commits or batches in the project in the
  last 90 days. Otherwise it falls back to "Everyone" and says why ("You have nothing here yet: showing everyone's").
  It never shows an empty page because of a default.
- **The count is always visible** ("12 yours · 340 total → Show everyone's"): clicking it switches scope. That's
  what makes "show all" obvious, more than the toggle itself.
- **The scope is in the URL** (`?scope=all`): a link you copy shows what you saw. The default only applies to
  links without it. The last choice is remembered per project (`stores/prefs.js`, already synced to the server).
- **New "Batches" view** (default in "Yours"): the batches you started, from the web app **and** from your
  terminal (local runs), newest first, with their origin, status, live progress, and the key metric vs. the reference. Checkboxes → "Compare" opens the commit page
  with `batch`/`batch_ref` set. That's the tuning workflow: you want batches, not commits.
- **"Commits" view** stays for the CI and per-branch history. In "Yours" it lists your commits and the commits with
  your batches, and shows your batches before the CI's, instead of in the "N other batches" tooltip.
- **Origin filter**, in "Everyone" too: `web app`, `local`, `CI` chips next to the search, and `origin:` /
  `-origin:ci` in the search syntax (`backend/search.py`). "Everyone, without CI" is how you look at other people's
  work: they don't need to do anything to share it. The same filter on `/activity` and `/storage`, so every index
  page can hide the CI.
- **The reference strip** stays at the top in every scope: the head of the reference branch, whoever committed it.
  Focusing on your stuff must not hide that master broke.
- **The search box only filters**: Enter no longer jumps to the branch or commit you typed (fixed along with this
  proposal); you go there by picking it with the arrow keys or the mouse.

### 3. Home: a dashboard about you, like GitHub's

```
 ┌ QA-Board  [ Search projects, branches, commits, batches…  Ctrl+K ]                       What's new ✦  🌓  jane ▾ ┐
 ├──────────────────────┬──────────────────────────────────────────────────────────────┬────────────────────────┤
 │ Your projects        │ Running now                                                  │ What's new (October)   │
 │ ★ kitefin/k3    ▁▃▅▇ │  ● denoise-sweep-3 · kitefin/k3 · 312/480 · 14 min      [→]  │  • Image viewer …      │
 │ ★ hdr/tonemap   ▁▁▃▂ │ Needs attention                                              │  • Storage rules …     │
 │   kitefin/k5    ▂▁▁▁ │  ✗ 3 runs failed in "jane 🏠 local" · kitefin/k3        [→]  │  See all →             │
 │   + 4 more           │  ↓ psnr −1.2 on master since yesterday · hdr/tonemap    [→]  │────────────────────────│
 │──────────────────────│ Recent                                                       │ Your storage           │
 │ Groups               │  ✓ denoise-sweep-2 · +0.7 psnr vs master · yesterday         │  1.4 TB · 600 GB older │
 │ ▸ kitefin  (14)      │  ✓ hdr-tuning-v4 · 2 days ago                                │  than 90 days → Clean  │
 │ ▸ hdr      (6)       │ From your projects (teammates, CI)                           │────────────────────────│
 │ Explore all →        │  bob ran "tonemap-gamma" on hdr/tonemap · 3h ago             │ Learn                  │
 │                      │  master CI ✓ on kitefin/k5 · 5h ago                          │  Tuning from the web → │
 └──────────────────────┴──────────────────────────────────────────────────────────────┴────────────────────────┘
```

- **Left: your projects**, automatic (where you committed or ran in the last 90 days) plus your pins, with a
  30-day activity sparkline. Then **groups** (see 4), then "Explore all".
- **Center: your feed**, in priority order:
  1. *Running now*: your batches waiting or running, live progress, ETA, link to logs (reuses `/activity` data
     filtered to you).
  2. *Needs attention*: your batches with failures, and regressions of the key metric on the reference branch of
     your projects. It must stay short: one line per batch, not per run, and dismissable.
  3. *Recent*: your finished batches, with the key metric vs the reference.
  4. *From your projects*: teammates' web-app batches and the reference branch's CI, collapsed by default.
- **Right: the things we built recently**: the What's new highlights (`releaseNotes/`), your storage with a
  clean-up call to action (`/storage`), and "Learn" links to the user-guide pages for the features you haven't used
  yet (e.g. no web-app batch yet → "Tuning from the web app").
- **Empty states** that teach: a new user sees "Sign your runs: `qa auth login`", "Run your first batch", and the
  explore list, instead of an empty feed.
- **Global search / command palette** (Ctrl+K, in every page's navbar): projects, branches, recent commits, your
  batches, and app pages ("Storage", "Settings > Tokens"). This is the biggest win for discovery and orientation,
  and it makes the home page's lists less critical.

### 4. Use the project hierarchy: group, and let quiet projects fade

Project ids are already paths (`repo/sub/sub`, see `website/docs/monorepo-support.mdx`), but every page treats them
as flat names.

- **Explore** (`/projects`, today's list, redone): a tree by root, one card per repository with its subprojects
  rolled up: count, latest activity, sparkline, latest CI status. Expand to see subprojects.
- **Quiet projects fade**: subprojects without human activity (no web-app or CLI batch, no page views) in 90 days
  are collapsed under "14 quiet subprojects", still searchable. "Quiet" must not mean "CI stopped": CI-only projects
  that run but nobody looks at are exactly the ones to fade.
  - We don't record page views today (PostHog is optional). A cheap `project_views(user_id, project_id, last_viewed_at)`
    upsert, at most once per hour per user, is enough. It also powers "recently viewed".
- **Root project pages list their subprojects** with their status, so a repository has one landing page.
- **Breadcrumbs** in the navbar (`kitefin / k3 / denoise`), each segment a link: the hierarchy becomes navigation.

### 5. A public instance, later

- Signed-out visitors get Explore with **featured projects** (chosen by admins in Admin > Settings) instead of the
  feed. No "From your projects" activity for projects they can't read: every endpoint above filters with
  `is_authorized_user`, like `/api/v1/projects` does.
- Feeds only show user names that the viewer could already see on the project pages.
- No internal links in the "Learn" card: it links to the docs site (`docs_root`).

## Plan

Each step can ship on its own, and each adds a release-notes bullet.

1. **CLI + backend**: `run_context` from the CLI (`QABOARD_SUBMISSION_ID` in the web app's scripts), the origin
   decided at ingest, the new columns + backfill, `committer_email`, identities, `scope`/`origin` on
   `/api/v1/commits` with the other scope's count. Tests on the classification; the backfill on a copy of production
   data first (how long does it take on the biggest projects?). Old CLIs keep working, classified as today.
2. **Project page**: scope switch, the count, the reference strip, the Batches view, compare. (The part you'll feel most.)
3. **Home**: `/api/v1/me/home`, the three columns, the empty states. The current list moves to `/projects` ("Explore").
4. **Hierarchy**: tree in Explore, subprojects on root pages, breadcrumbs, `project_views`, quiet projects.
5. **Command palette.** Could come earlier: it only needs the endpoints we have, plus batches search.

## Risks and things I'm not sure about

- **"Mine" by default can hide what you need**: a regression on master, or a teammate's batch you should compare
  against. The reference strip and the visible "340 total" count are there for that; if users still miss things,
  default to "Everyone" on the reference branch and to "Yours" elsewhere.
- **Identity matching** will be wrong for some people (a personal or old email in their git config). The
  git emails they add in their profile fix it, but people have to discover them: show "Not you? These commits aren't counted as yours…"
  where it matters.
- **Unverified runs**: `data.user` can be claimed by anyone (`QA_USER`). "Mine" includes them (many runs are
  unverified today), with the "unverified" tag as now. It's a view filter, not access control, so that's fine.
- **Old batches** get a best-effort origin from the backfill: some CI batches with custom labels will look local
  until they run again with a new CLI.
- **"Needs attention" can turn into noise** quickly. It's the part that needs the most tuning with real users.
- **The backfill** touches every batch: run it as a background job (`backend/jobs`) rather than in the migration if it's slow.

## Questions

Answered:
- "Yours" is only yours, no teams: others' work is one click away with "Everyone, without CI".
- Labels and the env aren't enough to spot CI: the CLI sends its `run_context`, and verified emails identify people.
- Local runs count as yours, like the web app's. Only the CI gets hidden, except the reference branch's head.
- Subprojects nobody looks at are clutter: fading quiet projects (4) is the answer, nothing gets deleted.
- Signed-out visitors get Explore, showing only the projects their visibility lets them read (public projects,
  `access/`): on an instance that requires signing in, that's nothing until they sign in.
