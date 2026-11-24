# charts/CLAUDE.md
The Helm chart, `charts/qaboard/`. Images and compose deployments: `deployments/CLAUDE.md`. Docs:
`website/docs/backend-admin/kubernetes.mdx`.

- Laptop quickstart: `qaboard/quickstart.yaml` on a kind cluster from `qaboard/kind.yaml` (commands at the top of
  `quickstart.yaml`). Not for production: see `values.yaml`.
- CI (`.github/workflows/ci.yaml`): the `helm` job lints and validates `ci/*.yaml` and `quickstart.yaml`
  (`helm lint`, kubeconform); `helm-e2e` installs the quickstart and runs `.github/scripts/helm_e2e.py`, with
  `--kubernetes` for batches the server starts without a shared storage.
- Published to `oci://ghcr.io/<owner>/charts/qaboard`; `image.repository` overrides the default images.
- Site values: `deployments/<site>/values.yaml`.
