# website/CLAUDE.md
The Docusaurus docs site and the release notes. Writing style, page structure, positioning: `STYLE.md`.
The site is public: no internal hostnames, paths, emails or people in `docs/` (root `CLAUDE.md`).

## Commands and deploy
```bash
yarn install && yarn start   # dev server
yarn build                   # static site; fails on broken links
uv run release-notes/release_notes.py check   # notes' frontmatter, docs links, length (CI: --strict)
```
- The Website workflow (`.github/workflows/website.yml`) deploys `master` to GitHub Pages, then starts an Algolia
  crawl to update the search index. The crawler's config lives in the Algolia dashboard (`README.md`); it skips
  elements marked `data-nosearch`.
- When you move or remove a page, add a redirect in `docusaurus.config.ts`.

## Docs structure
- `docs/` has one sidebar per audience (`sidebars.ts`): **User guide** (`docs/user-guide/`, people looking at
  results in the web app), **Project integration** (wrapping code with `qa`, qaboard.yaml, runners, integrations),
  **Admin** (`docs/backend-admin/`, running the server).
- A change to how people use the web app updates its user-guide page: one page per task; the viewers have their own
  (`user-guide/image-viewer`, `video-viewer`, `other-viewers`; their formats for integrators in `docs/viewers`).
- Pages start with the task and keep details collapsed: "Page structure" in `STYLE.md`.
- A page with sub-pages becomes a sidebar category whose `link` is that page (no file moves, URLs stay). Sidebar
  labels come from the pages' front matter `sidebar_label`: a `label` in `sidebars.ts` is ignored for docs.
- Entry points by audience: `docs/get-started/overview.mdx` ("Where to start") and the homepage's "Where to start"
  section (`src/pages/`): update both when a new audience-level entry point appears.
- Without access to the media host, build with `QABOARD_MEDIA=remote yarn build` (CI builds with the media).
- Pages for one site's users: `site-docs/<site>/`, built only into that site's web app (`QABOARD_SITE`). Internal
  runbooks: `deployments/<site>/runbooks/`, not here.

## Release notes
Shown in the web app's "What's new" panel (pops up once when a period with notes is over; also the sidebar's sparkles
button, the footer, `/#whats-new`) and on the site at `/release-notes` (RSS/Atom feeds).
- **Source**: `release-notes/YYYY-MM.md`, one per month (`YYYY-qN.md` or `YYYY.md` for quiet or old periods; periods
  can't overlap). Format: `release-notes/_template.md`. Missing month: `release_notes.py draft 2026-11 --write`
  (pre-filled from the git log, `draft: true`). Raw material: `release_notes.py changelog 2026-09` (or `2026-q3`,
  `2026`) lists the period's commits by area.
- **Sections**, each once, in the template's order (`check` fails on duplicates): `## Web app`,
  `## CLI and project setup`, `## Server and administration`, `## Documentation`, `## Performance`, `## Fixes`.
  Past ~6 bullets, group a section by theme under `###` headings named like the app's areas (*Automated tuning*,
  *Image viewer*, *Storage usage*), biggest first; put a new bullet under its theme.
- **Update, don't append**: one bullet per feature, not per commit or PR (two or three for a big one); edit the
  feature's bullet if it has one. Polish and fixes of something added in the same period aren't bullets, not even
  under Fixes: `## Fixes` is for what shipped before the period. Skip refactors, CI-only and typo changes.
- **Split by audience, not by commit**: what people see under Web app; what integrators write (qaboard.yaml, `qa`
  flags, code) under CLI and project setup; what admins install, configure or migrate under Server and
  administration. A change for several audiences gets one short bullet each, saying only what that audience does.
- **Write for the reader**: one change per bullet, starting with a verb, what they can now do, 1-3 sentences, details
  linked as `[text](/docs/page-id)`. No implementation details (endpoints the web app calls, packages the image
  installs, every variable's name); keep what readers must act on (renames, upgrade steps, security caveats).
  No commit shas, names, internal hostnames or ticket ids.
- **Length** (`check` warns, `--strict` fails, on notes being written: a draft or a period not over): ≤40 bullets,
  ≤6 per `###` theme (or per section without themes), ≤400 characters per bullet (links count for their text).
  Merge bullets on the same feature, cut polish, shorten and link the docs. Never move bullets to another period to
  get under the limits: the note says when things shipped.
- **Publishing** (maintainers, start of the next month or for a big release): curate; write `description` (1-2
  sentences) and 2-4 `highlights` (up to 8 for a big release: title, `audience`: users | project-integration |
  admins, a Blueprint `icon` name, plain-text `description` with backticks for code, optional `link: /docs/...`); set
  `date` to the publication date; remove `draft: true`. A published note whose period isn't over is a preview
  ("In progress"): keep adding bullets. It pops up once, after the period's last day (not when the period ended over
  60 days ago). "Seen" is per period: later edits don't notify again.
- **Nothing to generate or commit besides the `.md`**: the web app reads the notes at build/serve/test time
  (`webapp/CLAUDE.md`).
- Code here: `src/components/ReleaseNoteHighlights.js`, `src/theme/BlogPostItem/Content/` (highlight cards),
  `plugins/latest-release-note/` (landing page).
