# GitHub Support Roadmap

## Implemented
- GitHub webhook endpoint (`/webhook/github`) for push events
- GitHub repo cloning with `x-access-token` authentication
- GitHub avatar resolution via GitHub API with Redis caching
- GitHub Enterprise support (auto-detected from repository URL)
- Frontend avatar proxying for all hosting types

## Deferred Items

### CLI GitHub Integration
- Create `qaboard/github.py` parallel to `gitlab.py`
- Commit status reporting to GitHub (pending/success/failure checks)
- CI pipeline checks for GitHub Actions

### GitHub Actions Integration
- Equivalent of `/api/v1/gitlab/job` and `/api/v1/gitlab/job/play` for GitHub Actions workflow dispatch
- Workflow run status tracking

### Webhook Signature Verification
- Validate `X-Hub-Signature-256` header using `GITHUB_WEBHOOK_SECRET` env var
- Reject unsigned or incorrectly signed payloads

### GitHub App Authentication
- Use GitHub App installation tokens instead of PATs
- Better org-level access control
- Automatic token rotation

### Default GitHub Actions Integration Badges
- Frontend `default_github_integrations` with Actions badge URLs
- Display workflow status badges in project views

### Multi-Token Support
- Per-instance token configuration for orgs with multiple GitHub Enterprise instances
- Token routing based on repository URL host
