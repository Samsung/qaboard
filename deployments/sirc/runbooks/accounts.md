# Users' Unix accounts and groups (SIRC)

QA-Board acts as users on the shared storage: **export copies** are made by a child process with the user's uid and
groups (`backend/backend/fs_utils.py`, `as_user`), so that users own them. Links are made by the server.
It needs each user's account (uid, primary gid) and their other groups. The container's `/etc/passwd` is a partial
file from this repo (`services/backend/passwd`) and `/etc/group` isn't mounted, so `sirc.yml` sets:

```
QABOARD_ACCOUNTS_COMMAND=ssh ispq@ispq-vdi getent passwd
QABOARD_GROUPS_COMMAND=ssh ispq@ispq-vdi getent group
```

They run in the background, once a day, from the same ssh access as the LSF bridge ([lsf-bridge.md](lsf-bridge.md)).
Their output is saved in the shared data folder (`<qaboard_data_shared_dir>/accounts/passwd` and `group`). If a command
fails or prints much less than last time, QA-Board keeps the previous output.

## Symptoms when they're wrong
- The export preview says *QA-Board can't copy files as X: it doesn't know their Unix account*: X isn't in the
  accounts.
- The export preview, for copies, says *QA-Board only knows your account's primary group*, and copies of files that
  users read through a project group fail: the groups are missing.
- Failed exports have a reference: `grep 'export <reference>'` in the backend's logs, or search Sentry for
  `export.reference:<reference>`. The event's `copies_as` has the uid and groups QA-Board used.

## Check
```bash
# how many accounts and groups the commands list: thousands of users, not a handful
# (with SSSD, getent only lists all of them if enumeration is enabled on ispq-vdi)
docker compose --env-file deployments/sirc/production.env exec backend ssh ispq@ispq-vdi getent passwd | wc -l
docker compose --env-file deployments/sirc/production.env exec backend ssh ispq@ispq-vdi getent group | wc -l

# what QA-Board uses for a user, compared with `id <user>` on ispq-vdi
docker compose --env-file deployments/sirc/production.env exec backend python -c "
from backend import accounts
a = accounts.account('arthurf'); print(a, accounts.groups_known(a.name), sorted(accounts.group_ids(a.name, a.gid)))"
ssh ispq@ispq-vdi id arthurf

# refresh now, instead of waiting for the daily refresh
docker compose --env-file deployments/sirc/production.env exec backend python -c "from backend import accounts; print(accounts.refresh(force=True))"
```

If `getent` lists only a few users (no enumeration), ask IT to enable it on `ispq-vdi`, or point the commands at a
host that has it.
