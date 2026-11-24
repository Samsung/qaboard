"""
Small utility tools.
"""

# Wrapp function calls in profiled(my_call()) to profile code
import logging
import cProfile, pstats, io
import contextlib

logger = logging.getLogger(__name__)

@contextlib.contextmanager
def profiled():
    pr = cProfile.Profile()
    pr.enable()
    yield
    pr.disable()
    s = io.StringIO()
    ps = pstats.Stats(pr, stream=s).sort_stats('cumulative') # cumulative  tottime
    ps.print_stats(35)
    ps.print_callers(35)
    logger.info("Profile:\n%s", s.getvalue())
