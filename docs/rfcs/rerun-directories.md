# RFC: reruns get their own directory

Status: accepted, November 2026. Implemented with this RFC: see "What ships" at the end. A second step made it
a ledger: the earlier attempts' logs, status and metrics are kept.
Related: `docs/rfcs/python-sdk-runs.md` (open question 3, "replace or keep attempts"), the roadmap's "Agents" section.

## Why
A run is `(commit, batch, input, configurations, tuning parameters, platform)`, and its files are saved in a
directory computed from those. When a run is done again, `qa run` empties that directory and writes the new files
at the same paths. Three problems come from reusing the paths:

1. **Stale images in the web app.** The image server (Cantaloupe) and browsers cache what they read at a path, for
   up to 30 days. After a rerun, people can see the previous run's image next to the new run's metrics.
2. **Two results mixed in one folder.** While a rerun is queued or running, the folder holds the previous run's
   files, then a mix. When the files belong to someone else and can't be removed, the mix stays.
3. **No trace.** Nothing says a result was the third try. A flaky CI job that was retried, or a coding agent that
   reran until the gate passed, look like a first run.

## What a rerun is, and is not
A rerun is not a repeated measurement. People rerun because they changed their code locally and want to see the
result, because a machine or a license server failed, or because a dependency outside the repository changed. The
new result often measures something else than the previous one.

So this RFC gives reruns a directory, a number and a record, and nothing more:
- **A run still has one result: its latest attempt's.** The web app, the gate, History and the APIs see what they
  see today. There is still one row per run in the database.
- **Earlier attempts are a record, not samples.** We keep how each ended, its metrics and its log, to answer "what
  happened before this passed?". Nothing is computed over them.
- **QA-Board doesn't aggregate attempts.** Projects that repeat measurements do it inside `run()`, with the tool
  they trust (hyperfine, their benchmark harness), and return the statistics they want as metrics. What a run's
  metrics mean stays the project's business.

## Design

### Where attempts are saved
```
output/<configurations>/<input>/                    the first attempt: today's path, unchanged
output/<configurations>/<input>/latest_attempt.txt  "3": written when the run is done again
output/<configurations>/<input>_attempt3/           the third attempt
```

- **The first attempt keeps today's path.** Projects whose runs are never done again see no change, and every
  existing run is a valid first attempt: there is nothing to convert.
- **Later attempts add `_attemptN` to the directory's name.** The names of run directories only have `0-9 a-z . = -`
  (`slugify_hash` in `qaboard/conventions.py`), so the `_` can't be confused with an input's name, and the suffix
  parses back. Letters, digits and `_` need no quoting or escaping on Windows (cmd, PowerShell), in POSIX shells,
  in URLs (the web app, the IIIF image server) and in LSF's or Jenkins' command lines. `@2` was considered: it's
  shorter, but URLs escape it (`%40`), which every viewer would then have to get right.
- **`latest_attempt.txt`, in the first attempt's directory, holds the number of the latest attempt**, as text. No
  file means 1. Finding a run's results is one small read, from any language, without a server:

  ```bash
  dir=output/$conf/$input; [ -f $dir/latest_attempt.txt ] && dir=${dir}_attempt$(cat $dir/latest_attempt.txt)
  ```

  Looking for `_attempt2`, `_attempt3`... until one is missing was considered. It needs every earlier directory to
  stay, as an empty folder at least, and the file is one read however many attempts there were.

### What `qa` does
`qaboard/attempts.py` has the three operations. They only read and write the storage: `--offline` works.

| Operation | Rule | Used by |
|---|---|---|
| **latest** | The directory `latest_attempt.txt` points to, else the first attempt's. | `qa postprocess`, `qa sync`, `qa get output_dir`, `qa batch --list-output-dirs`, `--action-on-existing`, `qa check-bit-accuracy`, `--keep-previous` |
| **reserve** | If the latest attempt never started (it has no `run.json`), that directory. Otherwise the next number, written to `latest_attempt.txt`. | `qa batch` for the runs it starts, `qa run` |
| **replace the previous attempt** | Its `log.txt` moves to the new attempt's directory as `log.attempt<N>.txt`, with the logs it kept itself (the last 10). Its other files are removed, best effort. The first attempt's directory stays, with `latest_attempt.txt` only. | `qa run`, when it starts |

- **`qa batch` and `qa run` agree without telling each other.** `qa batch` reserves a directory for each run it
  starts: it tells QA-Board where the run will be, and runners (LSF, dask, Jenkins) send their logs there before
  `qa run` starts. Reserving twice gives the same directory until a run starts in it, so the `qa run` of the job
  finds the directory its batch reserved. A job that never starts leaves a reserved directory, which the next
  attempt uses.
- **The previous attempt's files are removed when the new attempt starts**, as today, where `qa run` empties the
  directory. The storage used doesn't change, but for the logs. If they can't be removed (they belong to someone
  else), they stay: the storage scan lists them as an untracked run, that its owner or an admin deletes.
- **Logs are kept**, because a failed attempt's log is often the only evidence of a flaky machine or test. They are
  in the run's manifest, so they're deleted with its files and counted in its storage, and bit-accuracy checks
  ignore them. `qa` tells the server which ones it has (`data.attempt_logs`).
- **If `latest_attempt.txt` can't be written** (the first attempt's directory belongs to someone else), `qa` warns
  and reruns in place, as before.

### What keeps running in place
- **Local runs** (`qa run` without `--share`, outside CI), saved in the working directory's `output/`. People
  iterating on their code keep their editor, image viewer and scripts on one path; nothing caches those files, and
  nobody else reads them.
- **`--output <dir>`** and `qa batch --prefix-outputs-path`: you chose the directory.
- **`--keep-previous`** (or `QABOARD_RUN_KEEP`): the run continues in the latest attempt's directory, with its files.
- **Projects that opt out**, with `outputs: {reruns: in-place}` in *qaboard.yaml*, or `QA_RERUNS=in-place` in the
  environment (e.g. for one CI job). For projects whose scripts build the paths of results themselves and can't
  read `latest_attempt.txt` yet.

### What the server keeps
No migration: runs keep their row, and the server already saves the directory each run reports
(`outputs.output_dir_override`).
- `data.attempt`: the number in the directory's name, when it's over 1.
- `data.previous_attempts`: when a run starts a new attempt, what the row said of the attempt it replaces: its
  number, when it started and ended, whether it failed or never finished, who ran it, and its metrics (plain
  values, at most 300). The last 10.
- **Runs done again in place are recorded too**: a finished run that says it's pending again, in the same
  directory, starts a new attempt, kept with `in_place: true`. `qa batch` saying "pending" then its `qa run` saying
  "running" is one attempt.
- When a run is hard-deleted, the first attempt's directory goes too if it only holds `latest_attempt.txt`. A run
  done again after that starts from its first attempt.
- Admins can't add an earlier attempt's leftover folder as a run from a storage scan ("Add runs to QA-Board"): the
  run's row already has its latest attempt.

The web app shows "attempt 3" on the run, with the earlier attempts and their metrics on hover, and their logs
in the Logs view. For a run done again in place, the image viewer warns that the image may be stale: the browser,
the viewer and the image server all cache by path, and we can't clear them all.

## Migration
- **Existing results**: nothing to do. A directory without `latest_attempt.txt` is a first attempt.
- **Upgrading `qa`**: reruns of shared and CI results start using `_attemptN` directories. The first run of each
  commit, which is what CI does, is where it was.
- **Old `qa` with a new server, new `qa` with an old server**: both work. The server stores the directory it's
  given; an old server ignores the attempt.
- **Mixed versions in one batch** (a `qa batch` that starts `qa run` on machines with another version, e.g. Jenkins
  agents): `qa batch` and `qa run` can disagree on a rerun's directory. `qa batch` now finds its runs' results in
  QA-Board by their id, so it reports the right status when the server is reachable. Upgrade both sides together.
- **Scripts that read results**: `qa batch --list-output-dirs`, `qa get output_dir`, `qaboard.runs()` and the API's
  `output_dir_url` give the latest attempt's directory. Scripts that build the path themselves read
  `latest_attempt.txt`, or the project opts out.

## Not in this version, on purpose
- **Keeping the output files of earlier attempts**, beyond their logs. It multiplies the storage of people who
  iterate, and needs storage usage, retention rules and deletions to know about attempts first. `outputs.reruns`
  can get a third value later.
- **A database row per attempt.** Every query on runs would have to ignore earlier attempts. `previous_attempts`
  answers "how many times, who, did it fail" without it.
- **New directories for local runs.** See above. Possible later behind the same setting.
- **Statistics over attempts.** See "What a rerun is, and is not".

## Decided after the first version
1. **Logs of earlier attempts are kept**, for every attempt, not only failed ones in CI: see above.
2. **The gate says when runs passed after being done again**: in its summary and in the comment it posts on pull
   requests (`docs/quality-ledger-plan.md`, item 3).
3. **`start_run()` reserves its directory with the same operations** (`docs/rfcs/python-sdk-runs.md`): a training run
   started twice is two attempts.

## What ships
- `qaboard/attempts.py`, used by `qa run`, `qa batch`, `qa postprocess`, `qa sync`, `qa get`, `qa check-bit-accuracy`.
  `qa batch` finds its runs' results by their id first (`qaboard/runners/job.py`).
- `outputs.reruns` in *qaboard.yaml*, `QA_RERUNS`.
- The server's `data.attempt` and `data.previous_attempts` (`backend/attempts.py`), the clean-up on hard deletes, the
  **attempt N** tag on run cards (`webapp/src/components/AttemptTag.jsx`), the earlier logs in the Logs view, and the
  image viewer's **may be stale** tag.
- Docs: [Where is the data saved?](../../website/docs/storage/where-is-the-data-saved.mdx) ("When a run is done
  again"), the run cards' page of the user guide, the admins' storage page, the agents' `qaboard-results` skill, the
  release note.

Tested: unit tests (`tests/test_attempts.py`, `tests/test_cli.py`, `tests/test_runners.py`,
`backend/tests/test_outputs.py`), and on a real database `backend/integration_tests/test_ingest.py`. Not tested on a
cluster: LSF job arrays, the Jenkins Windows runner and Windows clients only through the unit tests.
