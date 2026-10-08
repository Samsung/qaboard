# CLAUDE.md
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.


## QA-Board Architecture

QA-Board is an experiment tracking framework with advanced viewers for algorithm, ML, and performance engineers. It consists of:

- **`qaboard/`** - Python CLI package that wraps user code and manages experiments
- **`backend/`** - Flask API with PostgreSQL database for managing runs and data  
- **`webapp/`** - React.js frontend for visualizing and comparing results
- **`services/`** - Infrastructure services (nginx, databases, message queues)
- **`website/`** - Docusaurus documentation site

## Development Commands

### Environment Setup
```bash
# Start full development environment
docker compose -f docker-compose.yml -f development.yml up -d

# At SIRC, run this first to set proxies/dev settings and mount important folders
source deployments/sirc/.envrc
./at-sirc-before-up.py

# With SIRC-specific config
docker compose -f docker-compose.yml -f development.yml -f deployments/sirc/sirc.yml up -d
```

### Deploying
```bash
# Zero-downtime deploys, one env file per environment (compose files, project, replicas...)
deployments/deploy.py deployments/sirc/production.env up|status|rollback|restore-db|compose ...
docker compose --env-file deployments/sirc/production.env ps
# Kubernetes: helm chart in charts/qaboard, SIRC values in deployments/sirc/values.yaml
```
GitLab CI deploys master to staging then production automatically. Runbooks: `website/docs/backend-admin/`.

### Frontend Development (React)
```bash
cd webapp
npm install
npm start               # Vite dev server
npm run build           # Production build (Vite)
npm test                # Vitest (watch mode), `npm test -- --run` for a single run
npm run lint            # oxlint
npm run e2e             # Playwright smoke tests on the production build (after npm run build)
```

### Backend Development (Python Flask)
```bash
cd backend
# Backend runs in Docker, see docker-compose.yml
```

### Documentation Site
```bash
cd website  
yarn install
yarn start              # Start Docusaurus dev server
yarn build              # Build static site
```

### Python CLI Package
```bash
# Main qaboard package uses uv for dependencies
# Development dependencies include testing tools
uv sync --extra dev     # Install with dev dependencies
```

## Release notes and docs (communicating with users)

Users see the release notes in the web app's "What's new" panel: it pops up once when a period with notes
is over, and opens anytime from the sidebar's sparkles button, the footer, or `/#whats-new`. The docs
website shows them at `/release-notes` (with RSS/Atom feeds).

- **Source**: `website/release-notes/YYYY-MM.md`, one file per month (`YYYY-qN.md` or `YYYY.md` for quiet
  or old periods; periods can't overlap). The format is documented in `website/release-notes/_template.md`.
- **In the same PR as any user-visible change** (web app, `qa` CLI, qaboard.yaml, server/admin), add a
  bullet to the current month's note, under the right section: `## Web app`, `## CLI and project setup`,
  `## Server and administration`, `## Documentation`, `## Fixes`. If the month's file doesn't exist,
  create it as a draft: `website/release-notes/release_notes.py draft 2026-11 --write` (pre-filled from
  the git log, keeps `draft: true`). Skip refactors, CI-only and typo changes.
- **Write for the reader**: one change per bullet, starting with a verb, saying what they can now do.
  No commit shas, no names, no internal hostnames or ticket ids: the repo and website are public.
  Link docs as `[text](/docs/page-id)`.
- **Publishing** (maintainers, at the start of the next month or for a big release): curate the bullets,
  write `description` (1-2 sentences) and 2-4 `highlights` (title, `audience`: users | project-integration |
  admins, a Blueprint `icon` name, plain-text `description` (backticks for code), optional `link: /docs/...`), set `date`
  to the publication date, and remove `draft: true`. Until its period is over, a published note is a
  preview in the panel ("In progress"), so keep adding bullets as work lands: it pops up once, after the
  period's last day, with everything in it (notes whose period ended over 60 days ago don't pop up).
  "Seen" is remembered per period: later edits to a note don't notify again.
- **Nothing to generate or commit besides the `.md`**: vite reads the notes when it builds or serves the web
  app, or runs its tests (`webapp/releaseNotes.js`, imported as `virtual:release-notes`; the frontend image
  is built from the repo root for that, see `webapp/Dockerfile`). `npm start` reloads when a note changes;
  `QABOARD_RELEASE_NOTES_DRAFTS=1 npm start` also shows the drafts. `release_notes.py check` validates the
  frontmatter and the docs links: CI runs it.
- **Changelog from git**: `release_notes.py changelog 2026-09` (or `2026-q3`, `2026`) lists the period's
  commits grouped by the area they touch, as raw material for a note.
- Code: `webapp/src/releaseNotes/` (popup, panel, links), `website/src/components/ReleaseNoteHighlights.js`
  and `website/src/theme/BlogPostItem/Content/` (highlight cards on the website).

**Docs** (`website/docs/`) have one sidebar per audience (`website/sidebars.ts`): the **User guide**
(`user-guide/`, for people looking at results in the web app), **Project integration** (wrapping code with `qa`,
qaboard.yaml, runners, integrations), and **Admin** (`backend-admin/`, running the server). When a change
affects how people use the web app, update the user guide page too.

## Testing

### Python Tests
- **Framework**: `green` test runner (configured in pyproject.toml)
- **Backend tests**: `pytest` (in backend/pyproject.toml dev dependencies)
- **Type checking**: `mypy` 
- **Linting**: `flake8`
- **Test files**: Located in `tests/` directory

```bash
# Run Python tests (use green test runner)
green tests

# Type checking
mypy qaboard/

# Linting  
flake8 qaboard/
```

### Frontend Tests
```bash
cd webapp
npm test -- --run       # Vitest + Testing Library, jsdom
```

## Key Technologies

- **Backend**: Python 3.11+, Flask, PostgreSQL, SQLAlchemy, Celery, Redis
- **Frontend**: React 19, Redux, Blueprint UI 6, React Router 8, D3.js, Plotly.js 3, Monaco. Built with Vite 8, tested with Vitest, linted with oxlint
- **Infrastructure**: Docker Compose, nginx, RabbitMQ
- **CLI**: Python with Click framework
- **Package Management**: `uv` for Python, `npm` for JavaScript

## Development Workflow

1. **Environment**: Use Docker Compose for full stack development
2. **Database**: PostgreSQL with Alembic migrations
3. **Task Queue**: LSF or Celery with RabbitMQ for background jobs
4. **Image Serving**: Cantaloupe IIIF server for advanced image viewing
5. **Authentication**: Supports local, LDAP, and SAML authentication

## Special Features

- **LSF Integration**: High-performance computing cluster support for batch jobs
- **Advanced Visualizations**: Images, videos, plots, 3D point clouds, flame graphs
- **Git Integration**: Version control awareness and commit tracking
- **Parameter Tuning**: Built-in optimization workflows with scikit-optimize
- **Bit Accuracy Testing**: Automated regression testing for algorithm validation

## Architecture Notes

The system follows a microservices pattern with Docker containers. The CLI submits jobs and uploads results, the backend processes data and stores in PostgreSQL, and the frontend fetches data via REST API to render visualizations. Services provide infrastructure like reverse proxy, image serving, and task processing.

Main entry points:
- CLI: `qa` command (from qaboard package)
- Backend API: Flask application served via uWSGI
- Frontend: React SPA served by nginx
- Documentation: Static Docusaurus site