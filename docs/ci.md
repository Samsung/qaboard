# CI: which jobs run, and the end-to-end tests on your computer

`.github/workflows/ci.yaml` starts with a `changes` job: `.github/scripts/ci_changes.py` decides which jobs the
change needs, and the run's summary says why. The mapping of files to jobs is in that script, nowhere else.

| Event | Jobs |
|---|---|
| push to `master`, release, `workflow_dispatch` | every job (a push to master with only docs: none, as before) |
| push to another branch, pull request from a fork | the jobs whose inputs changed since the branch left master |
| a change to `ci.yaml` or `ci_changes.py` | every job |
| docs only (`docs/`, `drafts/`, `*.md`, but not `website/release-notes/`) | none |

The end-to-end jobs (`quickstart`, `helm-e2e`, `kubernetes-runner-e2e`) run on branches only for changes to the
systems they protect (the chart, the Dockerfiles, the Kubernetes runner, the demo data...), or with the **`run-e2e`**
label on the pull request. A push reads the label when it starts: after adding it, re-run the CI workflow, or
push again. To run everything on a branch: Actions > CI > Run workflow.

To see what your branch needs (commits and uncommitted files, compared with `origin/master`):

```bash
uv run .github/scripts/ci_changes.py
```

**When your change can break what an end-to-end job protects, and it didn't run, run it on your computer or add the
`run-e2e` label.** Master runs them all before it publishes images: a failure there blocks the next release.

## Required check

Branch protection requires one check, **`ci-ok`**: it passes when every job passed or wasn't needed, and fails
when one failed or was cancelled. Don't require the other jobs: a job that doesn't run never reports, and its check
would wait forever. Our branches' pull requests get CI from the push; their `pull_request` run reports
`ci-ok (CI runs on push)`, which isn't required.

## Running the jobs locally

From the repository's root. The end-to-end jobs need docker, and kind, kubectl and helm for Kubernetes.

- **python**: `uv sync --extra dev`, then `green tests`, `uv run flake8 backend qaboard`, `uv run mypy -p qaboard --ignore-missing-imports`,
  `uv run website/release-notes/release_notes.py check --strict`
  To find tests that depend on each other or on time: `uv run python .github/scripts/shuffled_tests.py --repeat 3`
  (`--load 4` alongside busy processes; a failure prints the seed to run again with `--seed`)
- **webapp**: `cd webapp && npm ci && npm run lint && npm run typecheck && npm test -- --run && npm run build && npm run e2e`
  (the first time: `npx playwright install chromium`)
- **helm**: `helm lint charts/qaboard -f charts/qaboard/quickstart.yaml`, and `helm template` piped to `kubeconform`, as in the job
- **docker**: `QABOARD_VERSION=dev docker compose build`, `./deployments/deploy.py deployments/production.env up --no-pull --init`,
  then `uv run --frozen python .github/scripts/uploads_e2e.py http://localhost:5151 --create-admin '...'` (the command is in its docstring)
- **kubernetes-runner-e2e** (creates and deletes its own kind cluster):
  ```bash
  uv sync --locked --extra kubernetes
  python3 .github/scripts/kubernetes_runner_e2e.py --python "$PWD/.venv/bin/python"
  ```
- **helm-e2e**: the chart's quickstart on kind with images of your checkout (the job's `Quickstart` step), then the
  commands in the docstring of `.github/scripts/helm_e2e.py`:
  ```bash
  kubectl port-forward svc/qaboard-proxy 5151:80 &
  uv run --frozen python .github/scripts/helm_e2e.py http://localhost:5151
  uv run --frozen python .github/scripts/helm_e2e.py http://localhost:5151 --kubernetes  # after the helm upgrade it shows
  ```
- **quickstart**: with images of your checkout (`QABOARD_IMAGE`, `QABOARD_VERSION`) and a demo-data image
  (`.github/scripts/demo_data_fixture.sh "$QABOARD_IMAGE:demo-data-$QABOARD_VERSION"`), start
  `deployments/quickstart/compose.yml`, then `uv run .github/scripts/demo_data_e2e.py http://localhost:5151`

## Changing the mapping

Edit `JOBS` in `.github/scripts/ci_changes.py`, and its cases in `tests/test_ci_changes.py`. When in doubt, run the
job: a file the mapping doesn't know runs the Python tests. A new job in `ci.yaml` needs an output of `changes`,
an `if:` on it, and a place in `ci-ok`'s `needs` (the test checks it).

GitLab (`.gitlab-ci.yml`): merge requests skip `lint`, `type-check` and `webapp-tests` when they don't change their
inputs; master, which deploys, runs everything.
