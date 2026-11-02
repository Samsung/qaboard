# Kubernetes runner, pluggable Dask clusters, `qa doctor`: design

Status: implemented on this branch (2026-11). Goal: anyone can run batches with QA-Board on the compute they have,
and when it doesn't work, `qa doctor` tells them why and what to do.

## Scope
1. A `kubernetes` runner: each run is a pod of an Indexed Job. Optionally several runs per pod (`runs_per_pod`), for
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
    image_pull_secrets: [registry-creds]
    queue: algo-gpu             # Kueue LocalQueue
    priority_class: batch-low
    concurrency: 50             # pods at the same time, for a `qa batch` (Job parallelism). 0: all
    runs_per_pod: 1             # >1: each pod does several runs, one after the other
    timeout: 3600               # seconds, per pod (activeDeadlineSeconds). 0: none
    resources: {cpu: 4, memory: 16Gi, nvidia.com/gpu: 1}   # requests; memory and extended resources also as limits
    node_selector: {pool: gpu}
    tolerations: [{key: nvidia.com/gpu, operator: Exists, effect: NoSchedule}]
    run_as: user                # user (default): your UID/GID and groups | image | {uid: 1000, gid: 1000}
    mounts:                     # the shared filesystem, at the same paths in the pods
      - path: /algo
        pvc: algo-nfs           # a PersistentVolumeClaim (works with the "restricted" Pod Security Standard)
      - path: /home
        nfs: {server: nas1, path: /export/home}    # "baseline"
      - path: /data
        host_path: /data        # needs "privileged" or an exemption: avoid
    env: {OMP_NUM_THREADS: "4"}
    forward_env: true           # forward qa's environment (minus secrets and host-specific variables)
    job_template: k8s/qa-job.yaml   # optional, a batch/v1 Job merged under what QA-Board generates
    ttl_seconds_after_finished: 86400
```

### How runs start
- `JobGroup` groups (`group_options = ('concurrency', 'runs_per_pod', 'timeout')`) become one Indexed Job each
  (`completionMode: Indexed`, `completions` = number of pods, `parallelism` = concurrency, `backoffLimitPerIndex: 0`,
  `maxFailedIndexes` = completions, `podFailurePolicy` ignoring disruptions so evicted pods are retried).
  Large groups are split in several Jobs so that each ConfigMap stays under ~900 KiB.
- The commands go in a ConfigMap owned by the Job (deleted with it): `run-<index>.sh` per pod, and `env.sh`. The pod
  runs `sh /etc/qaboard/run-$JOB_COMPLETION_INDEX.sh`: no Python needed in the entrypoint. Each run's script `cd`s
  where `qa batch` runs, sends its output live to `<output_dir>/log.k8s.txt` (pod logs vanish with the pod, like
  LSF's `log.lsf.txt`), and runs the `qa run` command.
- Names and labels: Job `qa-<command_id[:8]>-<group>-<chunk>` (driver: `qa-<command_id[:8]>-<suffix>`), labels
  `app.kubernetes.io/managed-by: qaboard`, `qaboard.io/command-id: <command_id>`, `qaboard.io/user`,
  `qaboard.io/project` (sanitized to label values). Stopping a batch deletes the Jobs with its `command-id`
  (propagation `Background`), like `bkill -J "<prefix>*"`.
- Blocking: we watch the Jobs (re-reading the kubeconfig on 401: OIDC tokens expire during long batches) until they
  are Complete or Failed, and print progress. A run's success comes from `qa run` (QA-Board), not from Kubernetes.
- **Help when it's stuck**: pods that stay Pending are the usual problem, not errors. We read their events and print
  them once (FailedScheduling, quota exceeded, ImagePullBackOff, admission refused, missing ConfigMap/PVC...) with what
  to do, and write them in the pending runs' `log.k8s.txt` so they show in QA-Board. Errors that won't fix themselves
  (ErrImagePull for 5 minutes, InvalidImageName, CreateContainerConfigError, a forbidden pod) fail the batch.
  Waiting on a Kueue queue is normal and only reported.
- SIGINT/SIGTERM deletes the batch's Jobs, then exits (JobGroup marks the stopped runs as failed).
- `submit_detached()` starts one pod (a 1-completion Job) running a bash script: used by the dask driver and by the
  server for batches started from the web app.

### Run-as and permissions
- `run_as: user` sets `runAsUser`/`runAsGroup` to the submitter's (`os.getuid()`/`os.getgid()`), and
  `supplementalGroups` to `os.getgroups()`. The server uses the UID/GID of the logged-in user, from its accounts
  (`backend/backend/accounts.py`). `fsGroup` is never set (it would chown shared volumes).
- The admins decide what is allowed: the namespace's Pod Security Standard, a ValidatingAdmissionPolicy that ties
  `runAsUser` to the `qaboard.io/user` label's account or to a UID range, Kueue/ResourceQuota for quotas. The docs give
  examples. QA-Board never needs cluster-wide permissions.
- What the submitter needs, in the namespace (`qa doctor` checks it with SelfSubjectAccessReviews and prints this Role):
  `jobs`: create, get, list, watch, delete; `configmaps`: create, get, patch, delete; `pods`, `events`: get, list,
  watch; `pods/log`: get. With a queue: `localqueues.kueue.x-k8s.io`: get.

## Dask clusters
`runners.dask.cluster.type` picks the class; the rest of `cluster` are its kwargs, as today for LSF.
- dask-jobqueue: `lsf` (default, and the LSF defaults from `runners.lsf` as today), `slurm`, `pbs`, `sge`,
  `htcondor`, `oar`, `moab`. Workers are named `<command_id[:8]>_dask` on every scheduler.
- `kubernetes`: `dask_kubernetes.operator.KubeCluster` (needs the Dask operator in the cluster). Image, namespace,
  resources and run-as default from `runners.kubernetes`.
- `local`: `distributed.LocalCluster`, for tests and big machines.
- The `--no-wait` driver is sent with the matching runner's `submit_detached()` when it has one (`lsf`, `kubernetes`),
  otherwise with the scheduler's own submit command via dask-jobqueue's job class (`sbatch`, `qsub`...).
- Stopping: the scheduler's cancel command by job name (`bkill -J`, `scancel --name`, ...), or deleting the
  `DaskCluster` and driver Job on Kubernetes.

## `qa doctor`
`qa doctor [--runner X] [--test-job]`. Prints each check (ok / warning / error / skipped) with how to fix it, exits 1
if one failed. Checks, in order: qaboard.yaml (found, valid), project and git, the QA-Board server (reachable,
version, signed in / token), storage (outputs root exists or can be created, writable; inputs database readable),
then the runner's `doctor()`: local (concurrency), LSF (`bsub` or the bridge, queue exists), Celery (broker reachable,
workers answer), Dask (packages, scheduler reachable or cluster class), Jenkins (URL, credentials), Kubernetes
(client installed, kubeconfig and context, auth plugin on PATH, API reachable, namespace, permissions, Kueue queue,
image pull secret, mounts' PVCs exist). `--test-job` runs a pod/job that prints its user, checks that the mounts and
the outputs directory are there and writable as that user, and that `qa --version` works in the image.
