#!/bin/sh
# The demo-data image's entrypoint: restores the docs' demo projects into a QA-Board server, once, then exits.
#   restore.sh            the results and the database
#   restore.sh database   only the database
# - The results go to $QABOARD_DEMO_RESULTS (default /mnt/qaboard), the path the database has. Skipped when
#   .qaboard-demo/restored is already there.
# - The database is restored unless it already has QA-Board's tables: existing data is never touched.
#   Restore it before the backend starts the first time: the backend creates empty tables when it starts.
#   It connects like the backend: QABOARD_DB_HOST, QABOARD_DB_PORT, QABOARD_DB_NAME, QABOARD_DB_USER, QABOARD_DB_PASSWORD.
# - Concurrent restores (e.g. several backend replicas) wait for each other, then skip.
# - Dates move with the restore: the snapshot's T0 (the demo's "now", in metadata.json) becomes the time of the restore,
#   so that the demo commits look recent. On their first restore only: the database's dates (shift-dates.sql), and the
#   modification times of the demo's files and folders (mtimes.txt), which the file browser shows.
# Used by deployments/quickstart/compose.yml and the Helm chart's demoData (charts/qaboard/values.yaml).
# The image is built by docs-media/snapshot.py image, see docs-media/README.md.
set -eu

results="${QABOARD_DEMO_RESULTS:-/mnt/qaboard}"
export PGHOST="${QABOARD_DB_HOST:-db}" PGPORT="${QABOARD_DB_PORT:-5432}" PGDATABASE="${QABOARD_DB_NAME:-qaboard}"
export PGUSER="${QABOARD_DB_USER:-qaboard}" PGPASSWORD="${QABOARD_DB_PASSWORD:-password}"
timeout="${QABOARD_DEMO_DB_TIMEOUT:-600}"
mode="${1:-all}"

log() { echo "[demo-data] $*"; }

# Gives the demo's files and folders their modification times, moved by $1 seconds. /demo/mtimes.txt has a
# "<mtime> <path>" line for each folder (busybox's tar gives them the time of the restore) and file, sorted by time,
# except hard links (copies of a file are links to it) and symbolic links. One touch for the paths of the same time.
set_mtimes() {
  seconds=$1
  previous=
  set --
  while IFS= read -r line; do
    mtime=$((${line%% *} + seconds))
    if [ "$mtime" != "$previous" ] || [ $# -ge 100 ]; then
      if [ $# -gt 0 ]; then touch -c -d "@$previous" "$@" || true; fi
      set --
      previous=$mtime
    fi
    set -- "$@" "$results/${line#* }"
  done < /demo/mtimes.txt
  if [ $# -gt 0 ]; then touch -c -d "@$previous" "$@" || true; fi
}

# Called by psql below, while it holds the lock, with QABOARD_DEMO_SHIFT: how much to move the dates
if [ "$mode" = results ]; then
  if [ -f "$results/.qaboard-demo/restored" ]; then
    log "The results are already in $results"
  else
    log "Restoring the results into $results..."
    mkdir -p "$results"
    # Files with the same content are hard links in the archive: they stay hard links
    tar -x -o -f /demo/results.tar -C "$results"
    log "Moving their modification times by ${QABOARD_DEMO_SHIFT:-0}s, like the database's dates..."
    set_mtimes "${QABOARD_DEMO_SHIFT:-0}"
    mkdir -p "$results/.qaboard-demo"
    cp /demo/demo-data.txt "$results/.qaboard-demo/restored"
    log "Restored $(du -sh "$results" | cut -f1) of results"
  fi
  exit 0
fi

log "$(cat /demo/demo-data.txt)"
log "Waiting for the database ($PGHOST:$PGPORT)..."
start=$(date +%s)
until pg_isready -q -t 5; do
  if [ $(($(date +%s) - start)) -gt "$timeout" ]; then
    log "ERROR: the database didn't answer in ${timeout}s"
    exit 1
  fi
  sleep 2
done

# In one session, that holds an advisory lock until it ends. Query results go to /dev/null, \echo to the logs.
with_results=1
if [ "$mode" = database ]; then with_results=0; fi
psql -X -q -v ON_ERROR_STOP=1 -v with_results="$with_results" -o /dev/null <<'EOF'
SELECT pg_advisory_lock(5151);
-- The dates move by the time since T0: seconds only, so that they don't depend on time zones
\set metadata `cat /demo/metadata.json`
SELECT coalesce(floor(extract(epoch FROM now() - (:'metadata'::jsonb ->> 't0')::timestamptz)), 0)::bigint AS shift \gset demo_
\setenv QABOARD_DEMO_SHIFT :demo_shift
\if :with_results
  \! /demo/restore.sh results
  \if :SHELL_ERROR
    DO $$ BEGIN RAISE EXCEPTION 'could not restore the results'; END $$;
  \endif
\endif
SELECT to_regclass('public.projects') IS NULL AS empty \gset
\if :empty
  \echo [demo-data] Restoring the database, its dates moved by :demo_shift s...
  BEGIN;
  \i /demo/db.sql
  \i /demo/shift-dates.sql
  COMMIT;
  \echo [demo-data] Restored the database
\else
  \echo [demo-data] The database already has QA-Board tables: it is left as it is
\endif
EOF
log "Done"
