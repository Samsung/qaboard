from .job import Job, JobGroup

from .lsf import LsfRunner
from .local import LocalRunner
from .celery import CeleryRunner

runners = {
    'local': LocalRunner,
    'lsf': LsfRunner,
    'celery': CeleryRunner,
}


## We may not want to promote this, better have people contribute more runners to the project,
## rather than encourage everyone to write their own wrapper. Also it lets us keep the API internal.
## Besides, when we call stop_command server-side, having custom runners makes things even more complex
# def register_runner(runnerType):
#     assert hasattr(runnerType, 'type')
#     assert hasattr(runnerType, 'start')
#     assert hasattr(runnerType, 'start_jobs')
#     assert hasattr(runnerType, 'stop_jobs')
#     assert hasattr(runnerType, 'stop_command')
#     runners[runnerType.type] = runnerType
