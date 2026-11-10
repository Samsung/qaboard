# Kubernetes runner, pluggable Dask clusters, `qa doctor`: design

Status: implemented on this branch (2026-11). Goal: anyone can run batches with QA-Board on the compute they have,
and when it doesn't work, `qa doctor` tells them why and what to do.

## Scope
1. A `kubernetes` runner (Kubernetes 1.29+: `backoffLimitPerIndex`): each run is a pod of an Indexed Job. Optionally several runs per pod (`runs_per_pod`), for
   short runs or when getting a node is the expensive part (GPUs: fast-ish inference/evals).
2. Dask workers on any scheduler Dask supports: `runners.dask.cluster.type`: `lsf` (default, as today), `slurm`,
   `pbs`, `sge`, `htcondor`, `oar`, `moab` (dask-jobqueue), `kubernetes` (dask-kubernetes operator), `local`.
3. `qa doctor`: checks everything needed to run batches, from qaboard.yaml to the runner's permissions, and says how
   to fix each problem. `--test-job` also starts a small job.
4. The server: stop Kubernetes batches, start batches from the web app on Kubernetes
   (`QABOARD_TUNING_RUNNER=kubernetes`), RBAC in the helm chart.
5. Docs: choosing a runner, "coming from MLflow / W&B Launch / ClearML / Slurm...", one page per runner, `qa doctor`.

Out of scope for now: clusters without a shared filesystem. We assume the pods see the code, the inputs and the
outputs at the same paths as the machine that runs `qa batch`. Later, HTTP upload (`docs/design/http-upload.md`) will
remove the need for shared outputs, and an image per commit the need for shared code.

## Prior art (what we compete with)
| Tool | Submits | Template | Identity in the pod | Quotas |
|---|---|---|---|---|
| MLflow Projects (`kubernetes` backend) | a Job, from the client's kubeconfig | user's Job template YAML | whatever the template says | none (cluster's) |
| W&B Launch | an agent in the cluster creates Jobs from a queue | admin's queue config (a Job spec) | the template's, agent's ServiceAccount | per queue, Kueue |
| ClearML Agent (k8s glue) | an agent turns queued tasks into pods | admin's pod template | template's | per queue |
| Run:ai | CLI / API | project | **UID/GID from the user's SSO identity** (or the image's) | per project (fair-share) |
| JupyterHub KubeSpawner (HPC sites) | the hub | admin's | **the user's UID/GID from the directory**, for NFS homes | profiles |
| Kubeflow | per-user namespaces (Profiles) | | namespace's | ResourceQuota per namespace |

What they converge on, and what we do:
- **A Job template owned by whoever owns the cluster**, patched by the tool: we take `job_template` (a YAML file,
  merged under our spec) and the common fields as plain options.
- **Queues and quotas are the cluster's job**: Kueue (`kueue.x-k8s.io/queue-name` label) or ResourceQuota per
  namespace. We set the label and resource requests, and label every object with the user and project, so quotas and
  dashboards can be per user/team.
- **Identity**: tools on shared filesystems (Run:ai, JupyterHub) run pods as the user's UID/GID, so files are owned by
  them. We do the same by default (`run_as: user`), and admins enforce it with a ValidatingAdmissionPolicy (built in
  since Kubernetes 1.30, example in the docs). `run_as: image` keeps the image's user.

## The kubernetes runner
`qaboard/runners/kubernetes.py`, `type = "kubernetes"`, optional dependency `qaboard[kubernetes]` (the `kubernetes`
Python client). We talk to the API with the Python client, not `kubectl`.

### Options (`runners.kubernetes` in qaboard.yaml, also per input type like other runners)
```yaml
runners:
  default: kubernetes
  kubernetes:
    namespace: algo-qa          # default: the kubeconfig context's namespace, else "default"
    context: my-cluster         # kubeconfig context, default: current. In a pod: the in-cluster ServiceAccount
    image: registry.example.com/algo/qa-env:2026.11   # must have `qa` and your code's dependencies
    image_pull_secrets: [registry-creds]   # or one, as a string
    queue: algo-gpu             # Kueue LocalQueue
    priority_class: batch-low
    concurrency: 50             # pods at the same time, for a `qa batch` (Job parallelism). 0: all
    runs_per_pod: 1             # >1: each pod does several runs, one after the other
    timeout: 600                # seconds, per run (`timeout -k 60` of GNU coreutils, in the pods' script). 0: none
    pod_timeout: 3600           # seconds, per pod, for all its runs (activeDeadlineSeconds). 0: none
    resources: {cpu: 4, memory: 16Gi, nvidia.com/gpu: 1}   # requests; memory and extended resources also as limits
    # or exactly: {requests: {...}, limits: {...}}. Both forms in one mapping are refused.
    node_selector: {pool: gpu}
    tolerations: [{key: nvidia.com/gpu, operator: Exists, effect: NoSchedule}]
    run_as: user                # user (default): your UID/GID and groups | image | {uid: 1000, gid: 1000, groups: [...]}
    run_as_non_root: false      # with run_as: image, refuse images that run as root
    service_account: qa-runs
    mounts:                     # the shared filesystem, at the same paths in the pods. Also: read_only, sub_path
      - path: /algo
        pvc: algo-nfs           # a PersistentVolumeClaim (works with the "restricted" Pod Security Standard)
      - path: /home
        nfs: {server: nas1, path: /export/home}    # "baseline"
      - path: /data
        host_path: /data        # needs "privileged" or an exemption: avoid
    env: {OMP_NUM_THREADS: "4"}
    forward_env: true           # forward qa's environment (minus secrets and host-specific variables, see below)
    job_template: k8s/qa-job.yaml   # optional, a batch/v1 Job merged under what QA-Board generates
    ttl_seconds_after_finished: 86400
    api_retry_seconds: 300      # how long API calls are retried (429, 5xx, network). The server passes 15
```
The options' types are checked (`option_errors`) before anything is created, and by `qa doctor`. Empty keys
(`runners.kubernetes:`, `runners.dask:`) are empty settings.

### How runs start
- `JobGroup` groups (`group_options = ('concurrency', 'runs_per_pod', 'pod_timeout')`) become one Indexed Job each
  (`completionMode: Indexed`, `completions` = number of pods, `parallelism` = concurrency, `backoffLimitPerIndex: 0`,
  `maxFailedIndexes` = completions, `podFailurePolicy` ignoring disruptions so evicted pods are retried).
  Large groups are split in several Jobs so that each ConfigMap stays under ~900 KiB.
- The commands go in a ConfigMap owned by the Job (deleted with it): `run-<index>.sh` per pod, and `env.sh`. The pod
  runs `sh /etc/qaboard/run-$JOB_COMPLETION_INDEX.sh`: no Python needed in the entrypoint, only a POSIX `sh`. Each
  run's script checks it can write `<output_dir>/log.k8s.txt`, else fails the run at once saying why on stderr (in
  the pod's logs; a failed `exec >` exits sh but not bash), sends its output there live (pod logs vanish with the
  pod, like LSF's `log.lsf.txt`), deletes `log.pending.txt`, `cd`s where `qa batch` runs, and runs the `qa run`
  command, under `timeout -k 60 <timeout> sh -c ...` with a per-run `timeout` (it signals the process group; no
  portable fallback: the image needs GNU coreutils, `qa doctor --test-job` checks it).
- Names and labels: Job `qa-<command_id[:8]>-<rand12>-<group>-<chunk>`, with 48 random bits per `qa batch`:
  `qa optimize`'s iterations reuse command ids, and finished Jobs are kept a day. Each create_job call puts a nonce
  in the Job's and ConfigMap's `qaboard.io/invocation` annotation: a 409 AlreadyExists (a retried create whose
  response was lost) is ours only with this nonce, otherwise we fail without touching the object (an old Job with
  the same name would run its old scripts). Detached
  Jobs: `qa-<name>-<rand12>` (server driver `qa-<id8>-driver-<rand12>`, Dask driver `qa-<id8>-dask-driver-<rand12>`,
  doctor `qa-<id8>-doctor-<rand12>`). Labels `app.kubernetes.io/managed-by: qaboard`, `qaboard.io/command-id`,
  `qaboard.io/user`, `qaboard.io/project` (`qaboard/runners/labels.py`, shared with the server). Stopping a batch
  deletes the Jobs with its `command-id` (and project, from the server), propagation `Background`.
- The runs' environment (`run_env`): qa's, minus secrets (`runners/env.py`: the ConfigMap is readable by the
  namespace), host-specific variables (PATH, HOME, locale, LD_LIBRARY_PATH, VIRTUAL_ENV, KUBECONFIG, `LC_*`, `XDG_*`,
  `SSH_*`, `CONDA_*`...), `PYTHONPATH` and CA bundles unless under `mounts`, proxies on localhost. Pods get
  USER/LOGNAME, HOME (ours if under `mounts`, else /tmp), `LANG=LC_ALL=C.UTF-8`, `MPLBACKEND=agg`, then `env`. Tokens
  reach runs through a Secret in `job_template` or a shared HOME after `qa auth login`.
- Default pod security context: restricted-compatible (seccomp RuntimeDefault, no privilege escalation, drop ALL,
  `runAsNonRoot` with a UID). Precedence: defaults < `job_template` < options < what QA-Board controls.
- Blocking: we watch the Jobs (re-reading the kubeconfig on 401: OIDC tokens expire during long batches) until they
  are Complete or Failed, and print progress. A run's success comes from `qa run` (QA-Board), not from Kubernetes.
- **Help when it's stuck**: pods that stay Pending are the usual problem, not errors. We read their events and print
  them once (FailedScheduling, quota exceeded, ImagePullBackOff, admission refused, missing ConfigMap/PVC...) with what
  to do, and write them in the pending runs' `log.pending.txt` so they show in QA-Board: not in `log.k8s.txt`, which
  the pods replace, maybe as another user than `qa batch` (a file we create with our umask, they couldn't). We only
  create output directories when the pods run as us. Errors that won't fix themselves (ErrImagePull for 5 minutes
  for a pod, unless pods of its Job run or ran; InvalidImageName, CreateContainerConfigError, a quota the pod can
  never fit, a FailedCreate refused by admission 3 times and again since we last looked, by the events' server
  timestamps) fail the batch, and delete all its Jobs, also the healthy groups': like Ctrl-C, the batch fails as a
  whole. Waiting on a Kueue queue or for nodes is never fatal.
- SIGINT/SIGTERM deletes the batch's Jobs, then exits (JobGroup marks the stopped runs as failed). While cleaning up,
  API calls are retried 15s, not 300s, and a second signal exits at once, printing the `kubectl delete` command.
- `submit_detached()` starts one pod (a 1-completion Job) running a script with `sh`, or with the interpreter of its
  `#!` line (the server's: bash): used by the dask driver and by the server for batches started from the web app. It
  watches the pod ~20s: it writes why it's pending in `pending_log(log_file)` (`log.txt` -> `log.pending.txt`), deletes
  it if it can never start, raises with its logs if it fails right away (e.g. it can't write its log file), and
  returns once it ran for 2 polls.
- Clusters that drop `backoffLimitPerIndex` (<1.29): `create_job` deletes the Job and fails; `qa doctor` checks the
  version.

### Run-as and permissions
- `run_as: user` sets `runAsUser`/`runAsGroup` to the submitter's (`os.getuid()`/`os.getgid()`), and
  `supplementalGroups` to `os.getgroups()`. The server uses the UID/GID of the logged-in user, from its accounts
  (`backend/backend/accounts.py`). `fsGroup` is never set (it would chown shared volumes).
- The admins decide what is allowed: the namespace's Pod Security Standard, a ValidatingAdmissionPolicy that ties
  `runAsUser` to the `qaboard.io/user` label's account or to a UID range, Kueue/ResourceQuota for quotas. The docs give
  examples. QA-Board never needs cluster-wide permissions.
- What the submitter needs, in the namespace (`qa doctor` checks it with SelfSubjectAccessReviews and prints this Role):
  `jobs`: create, get, list, watch, delete; `configmaps`: create, get, delete (created immutable, with their Job as owner); `pods`, `events`: get, list,
  watch; `pods/log`: get. With a queue: `localqueues.kueue.x-k8s.io`: get.

## Dask clusters
`runners.dask.cluster.type` picks the class; the rest of `cluster` are its kwargs, as today for LSF.
- dask-jobqueue: `lsf` (default, and the LSF defaults from `runners.lsf` as today), `slurm`, `pbs`, `sge`,
  `htcondor`, `oar`, `moab`. Workers/driver are `<id8>_dask`/`<id8>_dask_driver` on LSF, `qa<id8>_dask`/`qa<id8>_drv`
  elsewhere (SGE and Torque want a letter first, Torque keeps 15 characters). Jobqueue defaults: 1 core, 4GB, no
  walltime directive (except OAR: 30 minutes, doctor warns). `worker_start_timeout`: 900s on kubernetes/local, else 0.
- `kubernetes`: `dask_kubernetes.operator.KubeCluster` (needs the Dask operator, `qaboard[dask-kubernetes]`, Python
  3.10+). Pods default from `runners.kubernetes`, with its security context; DaskCluster `qa-<id8>-dask-<rand6>`,
  labeled like the runner's Jobs (command id, user, project: the operator copies them to the pods), `idle_timeout`
  600s; only the current kubeconfig context; secrets are forwarded (they go through Dask, not a ConfigMap). Tasks
  and the driver use `logical_path`s, like the runner. The scheduler is unauthenticated: the docs give a
  NetworkPolicy that only lets QA-Board's pods (and the operator) reach the DaskClusters' pods.
- `local`: `distributed.LocalCluster`, for tests and big machines.
- The `--no-wait` driver is sent with the matching runner's `submit_detached()` when it has one (`lsf`, `kubernetes`),
  otherwise with the scheduler's own submit command via dask-jobqueue's job class (`sbatch`, `qsub`...).
- Stopping: the scheduler's cancel command by job name, and by user from the server (`bkill -J`, `scancel --name`,
  `qselect`+`qdel`, `oardel --sql`, `condor_rm -constraint`), or deleting the `DaskCluster`s and driver Job on
  Kubernetes, selected by labels: command id, and project when the server gives it (`kubernetes.project`), never by
  name. The backend image doesn't ship the HPC commands.

## `qa doctor`
`qa doctor [--runner X] [--test-job]`. Prints each check (ok / warning / error / skipped) with how to fix it, exits 1
if one failed. Checks, in order: qaboard.yaml (found, valid, schema), project and git, the QA-Board server (reachable,
signed in / token, role; no version check yet), storage (outputs root exists or can be created, writable; inputs database readable),
then the runner's `doctor()`: local (concurrency), LSF (`bsub` or the bridge, queue exists), Celery (broker reachable,
workers answer), Dask (packages, scheduler reachable or cluster class), Jenkins (URL, credentials), Kubernetes
(client installed, kubeconfig and context, auth plugin on PATH, API reachable and >= 1.29, namespace, permissions,
Kueue queue, image, image pull secret, mounts' PVCs and coverage of the project/outputs, run-as vs Pod Security; first, the
options' types). `--test-job` runs a pod/job that prints its user, checks that the mounts and
the outputs directory are there and writable as that user, that `qa --version` works in the image, and with a
`timeout`, that `timeout -k` works.

## The server: batches started from the web app
`QABOARD_TUNING_RUNNER=kubernetes`: the server starts `qa batch` in a driver pod (`submit_detached`), as the signed-in
user, with the commit's `runners.kubernetes` as far as the server allows it (`backend/backend/runner_jobs.py`). The
driver's `qa batch` creates the runs' Jobs with the namespace's runs ServiceAccount
(`QABOARD_KUBERNETES_SERVICE_ACCOUNT`). The driver gets no `job_template`, `forward_env`, host_path (unless
`QABOARD_KUBERNETES_ALLOW_HOST_PATH`), nor env that changes bash/Python/qa; its resources are
`QABOARD_KUBERNETES_DRIVER_RESOURCES`. The helm chart's `runners.kubernetes` creates the Role, the runs
ServiceAccount and RoleBindings per namespace, and sets the env.

**Trust model: a namespace is a trust domain.** The driver runs the commit's code with a ServiceAccount that can create
Jobs, so it can create pods as any UID the namespace accepts: everyone who can start batches from the web app in a
namespace can act as anyone else in it. A ValidatingAdmissionPolicy keyed on the `qaboard.io/user` label can't tell
them apart, since they share the ServiceAccount. Like W&B Launch or ClearML queues, the namespace (one per team) is the
boundary. `QABOARD_KUBERNETES_RUN_AS=<uid>:<gid>` runs all of a deployment's batches as a team account: with a policy
that pins `runAsUser` for the runs ServiceAccount, they're isolated from other namespaces' users.

## Follow-ups
### Real isolation between the users of a namespace
Make the backend the only creator of run Jobs: the driver pod gets no Kubernetes permissions (no ServiceAccount
token), and asks the server to start its runs instead.
- When it starts the driver, the server mints a credential for this batch only: a short-lived token bound to the
  command id, the project, the namespace and the user's UID/GID (stored hashed, revoked when the batch ends or is
  stopped), mounted in the driver pod.
- The driver's `qa batch` (the kubernetes runner, when it finds that credential instead of a kubeconfig or a
  ServiceAccount token) sends the runs' commands and job options to `POST /api/v1/batch/<command_id>/jobs`.
- The server validates them like the driver's options (image, mounts, env, resources; `run_as` is always the batch's
  user), creates the ConfigMaps and Jobs itself, with its own ServiceAccount, labeled with the batch's command id, user
  and project, and answers the driver's status questions (`GET .../jobs`) from the Jobs and their pods' events.
- Then only the backend's ServiceAccount can create pods in the namespaces, and a ValidatingAdmissionPolicy can check
  that the pods' `runAsUser` matches their `qaboard.io/user` label's account: users can't act as each other.
- Batches started outside the web app (`qa batch` on a laptop or in CI) keep using their own credentials, in their own
  namespaces.
