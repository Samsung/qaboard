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

## What we already know about "mine" vs CI

No new data is needed to tell them apart; it's just scattered and not indexed for this:

| Signal | Where | Meaning |
|---|---|---|
| `Batch.label == 'default'`, `data.user == QABOARD_DEFAULT_USER` | `models/Batch.py` | CI batch |
| `Batch.data.submissions[*].user` | `submissions.py` (partial index `ix_batches_submissions`) | started from the web app (tuning, Run Tests, redo) and by whom |
| label `@user\| label`, or `data.type == 'local'` | `utils.js: pretty_label` | `qa batch` from someone's terminal |
| `data.submitted_by` (verified) / `data.user` (claimed) | batches and outputs | who sent it |
| `CiCommit.committer_name` | git display name, e.g. "Jane Doe" | who wrote the commit |
| name → email/username from webhooks | `git_hosts/committers.py` (redis) | maps committer names to accounts |

One weak link: `committer_name` is a git display name, while users sign in as `jdoe`. Matching has to go through
email/username (webhook data, LDAP email), plus aliases users can add themselves.

## Proposal

### 1. Backend: make "mine" and "where it came from" cheap to query

- **New `batches` columns**, backfilled by an Alembic migration from `data`:
  - `origin`: `ci` | `webapp` | `cli` (derived from the signals above),
  - `user_name` (who started it: submission user, else verified submitter, else claimed user), indexed,
  - `latest_output_datetime`, so "recent batches" doesn't scan outputs.

  Filtering JSONB on every page load works for one project, not for a home page that spans all of them.
- **User identities**: `User.git_identities` (emails, names), filled automatically from the account's email/username
  and the committers map, editable in Settings > Profile ("Commits by these names are yours"). One helper,
  `is_mine(commit)`, used everywhere.
- **APIs**
  - `/api/v1/commits?scope=mine|all&origin=webapp|cli|ci`: "mine" = I committed it **or** one of its batches is mine.
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
 │ master · CI  ✓ 1,204 runs  · 2h ago · psnr 41.2 (=)                                                           │  ← always: the reference
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 Showing your 12 batches of the last 30 days · 340 by everyone  →  Show everyone's
 ┌ Running ──────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ● denoise-sweep-3   on a1b2c3d  feature/denoise   web app   ▓▓▓▓▓▓░░ 312/480   ETA 14 min   [Logs] [Stop]   │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ┌ Yesterday ────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ☐ denoise-sweep-2   on a1b2c3d  feature/denoise   web app   ✓ 480   psnr 41.9 (+0.7 vs master)              │
 │ ☐ jane 🏠 local      on 9f8e7d6  feature/denoise   CLI       ✓ 20 ✗ 3                                         │
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
- **New "Batches" view** (default in "Yours"): the batches you started, newest first, with origin (web app, CLI,
  CI), status, live progress, and the key metric vs. the reference. Checkboxes → "Compare" opens the commit page
  with `batch`/`batch_ref` set. That's the tuning workflow: you want batches, not commits.
- **"Commits" view** stays for the CI and per-branch history. In "Yours" it lists your commits and the commits with
  your batches, and shows your batches before the CI's, instead of in the "N other batches" tooltip.
- **Origin filter** (`web app`, `CLI`, `CI`) as a chip next to the search, and `origin:` in the search syntax
  (`backend/search.py`).
- **The reference strip** stays at the top in every scope: focusing on your stuff must not hide that master broke.

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

1. **Backend**: `batches.origin`, `user_name`, `latest_output_datetime` + migration/backfill; identities;
   `scope`/`origin` on `/api/v1/commits` with the other scope's count. Tests on the classification, the backfill on
   a copy of production data first (how long does it take on the biggest projects?).
2. **Project page**: scope switch, the count, the reference strip, the Batches view, compare. (The part you'll feel most.)
3. **Home**: `/api/v1/me/home`, the three columns, the empty states. The current list moves to `/projects` ("Explore").
4. **Hierarchy**: tree in Explore, subprojects on root pages, breadcrumbs, `project_views`, quiet projects.
5. **Command palette.** Could come earlier: it only needs the endpoints we have, plus batches search.

## Risks and things I'm not sure about

- **"Mine" by default can hide what you need**: a regression on master, or a teammate's batch you should compare
  against. The reference strip and the visible "340 total" count are there for that; if users still miss things,
  default to "Everyone" on the reference branch and to "Yours" elsewhere.
- **Identity matching** will be wrong for some people (several git names, a personal email in the git config). The
  editable aliases fix it, but people have to discover them: show "Not you? These commits aren't counted as yours…"
  where it matters.
- **Unverified runs**: `data.user` can be claimed by anyone (`QA_USER`). "Mine" should include them (most runs are
  unverified today), and show the "unverified" tag as it does now.
- **"Needs attention" can turn into noise** quickly. It's the part that needs the most tuning with real users.
- **The backfill** touches every batch: run it as a background job (`backend/jobs`) rather than in the migration if it's slow.

## Questions

1. Do git committer names/emails match accounts at SIRC (LDAP email = git email)? It decides how much the aliases matter.
2. Should "Yours" include your team's batches (from groups, `admin/Groups.jsx`), or only your own?
3. "We lost tons of subprojects that nobody looks at": did you mean they clutter the list (this proposal hides them),
   or that they were deleted today and you want a way to archive projects explicitly?
4. Should Explore stay at `/` for signed-out users on SIRC, or should the instance require sign-in everywhere?
