import os
import subprocess

from celery import Celery

app = Celery('celery_app')
app.conf.update(
    broker_url=os.environ.get('CELERY_BROKER_URL', 'pyamqp://guest@localhost//'),
    result_backend=os.environ.get('CELERY_RESULT_BACKEND', 'rpc://'),
    task_serializer='pickle',
    accept_content=['pickle'],
    result_serializer='pickle',
    enable_utc=True,
)

from qaboard.config import config
celery_config = config.get('runners', {}).get('celery', {})
app.conf.update(**celery_config)


@app.task(bind=True, name=celery_config.get('qaboard_task_name', "qaboard"))
def start(self, job, cwd=None):
  # https://docs.celeryproject.org/en/stable/userguide/tasks.html#task-request-info
  print('Executing task id {0.id}, groupID: {0.group}'.format(self.request))

  pipe = subprocess.PIPE
  with subprocess.Popen(job.run_context.command, shell=True,
                        encoding='utf-8',
                        # Avoid issues with code outputing malformed unicode
                        # https://docs.python.org/3/library/codecs.html#error-handlers
                        errors='surrogateescape',
                        cwd=cwd if cwd else job.run_context.job_options['cwd'],
                        stdout=pipe, stderr=pipe) as process:
    for line in process.stdout:
      print(line, end='')
    process.wait()
    return process.returncode

