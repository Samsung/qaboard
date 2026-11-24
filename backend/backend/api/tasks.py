"""
Start celery tasks that wait for SSH connections to the worker
and stay live until it disconnects.

This will be used by WebCDE to use celery as job scheduler to
manage remote sessions.
"""
import logging
import time

from celery.app.control import Inspect
from qaboard.runners.celery_app import app as celery_app, ssh_task

from backend import app, db_session
from ..audit import audit
from .auth import login_required

logger = logging.getLogger(__name__)


# https://github.com/celery/celery/blob/main/celery/app/control.py#L340
inspector = Inspect(app=celery_app)


@app.post("/api/v1/task/celery/<id>")
@login_required
def task_celery(id):
    result = ssh_task.delay(id)
    audit('celery.ssh_session', 'celery_task', result.id, str(id)[:200], meta={"connection_id": str(id)[:200]})
    db_session.commit()
    # without a free worker, don't hold a uwsgi worker forever
    deadline = time.monotonic() + 120
    while result.status == "PENDING":
        if time.monotonic() > deadline:
            return "No Celery worker started the task within 2 minutes", 504
        time.sleep(1)
    logger.debug("Celery task %s: %s", result.id, result.status)
    statuses = inspector.query_task(result.id)
    for hostname, tasks_info in statuses.items():
        if result.id not in tasks_info:
            continue
        status, info = tasks_info[result.id]
        return {
            "hostname": hostname,
            "status": status,
            **info,
        }
    return "Could not start task", 500
