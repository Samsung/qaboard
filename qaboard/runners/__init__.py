from typing import Dict, Type

from .job import Job, JobGroup
from .base import BaseRunner
from .lsf import LsfRunner
from .local import LocalRunner
from .celery import CeleryRunner

runners: Dict[str, Type[BaseRunner]] = {
    'local': LocalRunner,
    'lsf': LsfRunner,
    'celery': CeleryRunner,
}


## We may not want to promote this, better have people contribute more runners to the project,
## rather than encourage everyone to write their own wrapper. Also it lets us keep the API internal.
## Besides, when we call stop_command server-side, having custom runners makes things even more complex
# def register_runner(runnerType):
#     assert hasattr(runnerType, 'type')
#     assert hasattr(runnerType, 'start_jobs')
#     assert hasattr(runnerType, 'stop_jobs')
#     runners[runnerType.type] = runnerType
