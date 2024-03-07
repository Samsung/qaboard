"""
Start celery tasks that wait for SSH connections to the worker
and stay live until it disconnects.

This will be used by WebCDE to use celery as job scheduler to
manage remote sessions.
"""
import time

from celery.app.control import Inspect
from qaboard.runners.celery_app import app as celery_app, ssh_task

from backend import app


# https://github.com/celery/celery/blob/main/celery/app/control.py#L340
inspector = Inspect(app=celery_app)


@app.post("/api/v1/task/celery/<id>")
def task_celery(id):
    result = ssh_task.delay(id)
    while result.status == "PENDING":
        time.sleep(1)
        # TODO: result.abort() after some time?
    print(f"{result} {result.id} {result.status}")
    statuses = inspector.query_task(result.id)
    assert statuses
    assert len(statuses.keys()) == 1
    hostname = list(statuses.keys())[0]
    status, info = statuses[hostname][result.id]
    return {
        "hostname": hostname,
        "status": status,
        **info,
    }
