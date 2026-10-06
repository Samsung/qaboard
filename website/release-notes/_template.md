---
# Files starting with _ are ignored. Copy this file to YYYY-MM.md (a month), YYYY-qN.md (a quarter) or YYYY.md (a year),
# or generate a draft from git: ./release_notes.py draft 2026-10 --write
title: October 2026        # optional, defaults to the period ("October 2026", "Q2 2025", "2019")
date: 2026-10-31           # publication date. The web app pops a note up once its period is over.
draft: true                # drafts are hidden in the app and on the website. Remove it to publish.
version: 1.1.0             # optional: the `qaboard` package version released in the period
description: >-
  One or two sentences for busy readers: what changed for them. Shown first, in the app and on the website.
highlights:                # 0 to 4, the changes worth a card. Most important first.
  - title: Release notes in the web app
    audience: users        # users (use the web app/CLI) | project-integration (integrate a project: qaboard.yaml, runners, CI) | admins (run the server)
    icon: notifications    # a Blueprint icon name: https://blueprintjs.com/docs/#icons/icons-list
    description: >-
      What it is and why it matters, in 1-3 plain-text sentences. No markdown here, except `code`.
    link: /docs/user-guide/whats-new   # optional: /docs/..., /release-notes/... or https://...
---
<!-- truncate -->

<!-- The body has the details, as bullets, under these sections in this order. Skip the empty ones.
     Write for the reader, not the committer: what they can now do, what changed for them.
     One bullet per change, starting with a verb. Link to the docs as [text](/docs/page-id). -->

## Web app
- Added ... You can now ...

## CLI and project setup
- `qa batch` now ...

## Server and administration
- ...

## Documentation
- New [user guide](/docs/user-guide/overview) ...

## Fixes
- Fixed ...
