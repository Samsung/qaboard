"""
Server jobs: maintenance that takes minutes to days, started by admins (Admin > Storage) or by schedules,
e.g. hard-deleting the runs users deleted, or deleting old results as qaboard.yaml says.

- models/Job.py: jobs, their errors, schedules and workers, in the database. It's the queue.
- kinds.py: what jobs do (hard_delete.py, garbage_collect.py), report.py: how they report progress and errors.
- queue.py: create, claim, cancel jobs, start schedules. worker.py: runs them (`qaboard-admin jobs worker`).

Nothing depends on the web framework or on a broker: the API (api/admin_jobs.py) is a thin layer over queue.py.
"""
