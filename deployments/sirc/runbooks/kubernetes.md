# QA-Board on Kubernetes at SIRC (runbook)

Status: being migrated from docker compose (`deployments/sirc/production.env`). The generic docs, for any cluster:
`website/docs/backend-admin/kubernetes.mdx`. The chart: `charts/qaboard`. SIRC's values: `deployments/sirc/values.yaml`
(its `TODO(sirc)` mark what we still need).

## How it's deployed
- GitLab CI builds the images once per commit and pushes them to our registry,
  `gitlab-srv.transchip.com:4567/common-infrastructure/qaboard:<service>-<commit>` (`build:images`). We don't use the
  public images (ghcr.io/samsung/qaboard): ours have SIRC's build args (proxy, CA, `cde`).
- The `deploy:k8s` job (`.gitlab-ci.yml`) runs after `test:staging`, when the CI/CD variable `QABOARD_K8S_DEPLOY=1`
  (or `=manual`):
  ```bash
  helm upgrade --install qaboard charts/qaboard --namespace qaboard \
       -f deployments/sirc/values.yaml --set image.version="$QABOARD_VERSION" \
       --atomic --wait --timeout 15m
  ```
  `--atomic` rolls back automatically if the new pods don't become ready (helm 4 calls it `--rollback-on-failure`).
- By hand, from a checkout of the deployed commit: the same command with `--set image.version=<short commit>`.

## Storage
Users write outputs on the shared storage (`/algo`, `/stage`, `/sim`, `/data`, `/raid`, `/home`, `/net`), mounted
with autofs on the docker hosts. Since there are several roots, `deployments/sirc/values.yaml` mounts them with
`backend.extraVolumes`/`proxy.extraVolumes` (`hostPath` with `mountPropagation: HostToContainer`) rather than the
chart's single `results` volume, and sets `QABOARD_STORAGE_ROOTS` itself. Cantaloupe is hosted outside of QA-Board.

## Migrating from docker compose
What we need from IT:
1. A namespace, an ingress class, a DNS name. Keep `qa` working as an alias: users and the CLI use `https://qa`.
2. The shared storage: either nodes that mount `/algo`, `/stage`, `/sim`, `/data`, `/raid`, `/home`, `/net` with
   autofs like the docker hosts (`hostPath` above, and pods scheduled on those nodes with `nodeSelector`), or the NFS
   exports behind each path (`nfs: {server, path}` volumes).
3. A `ReadWriteMany` storage class for the application data (`backend.data`).
4. PostgreSQL: managed by IT, or the CloudNativePG operator installed in the cluster.
5. Network access from pods to `gitlab-srv`, LDAP, `ispq-vdi` (LSF bridge over ssh), Jenkins.
6. Permission to run the backend as root (it uses `sudo` to delete outputs as their owner): the *baseline* Pod
   Security Standard, not *restricted*.
7. For GitLab CI: `helm` on the runner and a kubeconfig (a CI/CD variable of type *File*), or the GitLab agent for
   Kubernetes.
8. A GitLab deploy token with `read_registry`, for `imagePullSecrets` (see `deployments/sirc/values.yaml`).

Then:
1. Create the secrets and config maps listed in `deployments/sirc/values.yaml` (registry credentials, `.env` secrets,
   `passwd`, LDAP restrictions, ssh key, TLS certificate). Keep the same `SECRET_KEY`, or everyone is logged out.
2. Port the site's nginx locations (`deployments/sirc/nginx/*.conf`) to `proxy.siteConfig`.
3. Install the chart with a copy of production's database: `pg_dump -Fc` on the qa host (or the latest backup),
   `pg_restore --no-owner -d qaboard` into the new database. Test it on its temporary hostname.
4. Switch: make the compose deployment read-only or stop it, restore a fresh dump, point the `qa` DNS name to the
   ingress. Keep the compose deployment around for a quick way back.
5. Enable automatic deploys: set the CI/CD variable `QABOARD_K8S_DEPLOY=1` (or `=manual` to start), and remove
   `deploy:production`.

Effort: the chart covers the generic parts. The work is mostly the storage mounts and IT's prerequisites; expect a
few days of iteration once they are available.

## Troubleshooting
```bash
kubectl -n qaboard get pods
kubectl -n qaboard get events --sort-by=.lastTimestamp
kubectl -n qaboard logs deploy/qaboard-backend          # one of the replicas
kubectl -n qaboard logs job/qaboard-migrations          # failed migrations
kubectl -n qaboard exec -it deploy/qaboard-backend -- bash
helm -n qaboard history qaboard
helm -n qaboard rollback qaboard                        # previous release
```
