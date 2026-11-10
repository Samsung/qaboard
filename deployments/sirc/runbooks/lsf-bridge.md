# LSF bridge at SIRC

The server runs in a container without LSF. To start, redo and stop batches on LSF from the web app, it runs LSF
commands on a bridge host, over ssh, as the user who started the runs. Generic docs:
`website/docs/backend-admin/runners.mdx` (On LSF) and `website/docs/lsf-cluster-integration.mdx` (bridge host).

## What's configured
In `deployments/sirc/sirc.yml` (docker compose) and `deployments/sirc/values.yaml` (kubernetes):
```bash
QABOARD_TUNING_RUNNER=lsf
QA_RUNNERS_LSF_BRIDGE=ssh ispq@ispq-vdi 'bsub_su {user} -I {bsub_command}'
```
- `ispq@ispq-vdi`: the bridge host and account. The backend needs an ssh key accepted by `ispq@ispq-vdi`, and
  `ispq-vdi` in its `known_hosts`: in the `~/.ssh` of the backend's user with docker compose (TODO: say where it is
  mounted from, `sirc.yml` doesn't), in the `qaboard-ssh` secret on kubernetes (`values.yaml`).
- `bsub_su`: a wrapper installed on `ispq-vdi` by IT. It runs the rest of the command line as `{user}`. It is not
  in this repo.
- `{bsub_command}`: what QA-Board runs: `bsub ... << "EOF" <script> EOF`, `bwait`, `bkill -J "<prefix>*"`, or
  `bash <script>` for redo.

## Check it
From the backend's container (`dc exec backend bash`):
```bash
ssh ispq@ispq-vdi 'bsub_su <your-user> -I bjobs -w'
```
It should list your jobs. Then start a batch from the web app: its **Logs** show the `bsub` command and LSF's answer.
`qa doctor --runner lsf --test-job` with the same `QA_RUNNERS_LSF_BRIDGE` checks the whole path.

## TODO
- Copy `bsub_su`'s source from `ispq-vdi` here (or its owner in IT), so it can be rebuilt if the host is
  reinstalled, and document what the `-I` flag does there.
- The template wraps `{bsub_command}` in single quotes: a job script that contains a single quote breaks the
  quoting on the bridge host. It hasn't been seen in practice; the fix is to send the script through stdin of ssh.
