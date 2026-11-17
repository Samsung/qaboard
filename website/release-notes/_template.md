---
# Files starting with _ are ignored. Copy this file to YYYY-MM.md (a month), YYYY-qN.md (a quarter) or YYYY.md (a year),
# or generate a draft from git: ./release_notes.py draft 2026-10 --write
title: October 2026        # optional, defaults to the period ("October 2026", "Q2 2025", "2019")
date: 2026-10-31           # publication date. The web app pops a note up once its period is over.
draft: true                # drafts are hidden in the app and on the website. Remove it to publish.
version: 1.1.0             # optional: the `qaboard` package version released in the period
description: >-
  One or two sentences for busy readers: what changed for them. Shown first, in the app and on the website.
highlights:                # 0 to 4 (up to 8 for a big release), the changes worth a card. Most important first.
  - title: Release notes in the web app
    audience: users        # users (use the web app/CLI) | project-integration (integrate a project: qaboard.yaml, runners, CI) | admins (run the server)
    icon: notifications    # a Blueprint icon name: https://blueprintjs.com/docs/#icons/icons-list
    description: >-
      What it is and why it matters, in 1-3 plain-text sentences. No markdown here, except `code`.
    link: /docs/user-guide/whats-new   # optional: /docs/..., /release-notes/... or https://...
---
<!-- truncate -->

<!-- The body has the details, as bullets, under these sections in this order, each once. Skip the empty ones.
     Write for the reader, not the committer: what they can now do, what changed for them.
     One bullet per feature, not per commit or PR: 1-3 sentences, starting with a verb; the details are in the docs,
     linked as [text](/docs/page-id). Before adding a bullet, read the section: if the period already has one on that
     feature, edit it. `release_notes.py check` warns past 40 bullets per note, 6 per theme and 400 characters per
     bullet: merge and cut, don't move bullets to another period. Polish and fixes of something added in the same period aren't bullets (readers never saw the old
     behavior), and don't go under Fixes either: Fixes is for what shipped before the period.
     Past ~6 bullets, group a section by theme under ### headings named like the app's areas (### Image viewer,
     ### Automated tuning, ### Logs), the biggest themes first; put a new bullet under its theme. -->

## Web app
- Added ... You can now ...

## CLI and project setup
- `qa batch` now ...

## Server and administration
- ...

## Documentation
- New [user guide](/docs/user-guide/overview) ...

## Performance
- Open ... in 0.5 s instead of 5 s ...

## Fixes
<!-- Only for behavior that shipped before this period. With many fixes, group them by area under ### headings
     (e.g. ### Commit page and viewers, ### CLI, ### Server). -->
- Fixed ...
