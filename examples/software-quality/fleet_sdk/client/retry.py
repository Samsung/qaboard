"""Retries with exponential backoff and full jitter, under a deadline. The clock and sleep are injectable."""
import random
import time


class RetryError(Exception):
    def __init__(self, attempts, last):
        super().__init__(f"gave up after {attempts} attempts: {last!r}")
        self.attempts = attempts
        self.last = last


def backoff_delays(base=0.1, factor=2.0, cap=5.0, attempts=5, jitter=True, rng=None):
    """The delays before each retry: base * factor^n, capped, with full jitter (uniform in 0..delay)"""
    rng = rng or random.Random()
    for n in range(attempts - 1):
        delay = min(cap, base * factor ** n)
        yield rng.uniform(0, delay) if jitter else delay


def retry(fn, *, attempts=5, base=0.1, factor=2.0, cap=5.0, deadline=None, retry_on=(ConnectionError, TimeoutError),
          jitter=True, rng=None, clock=time.monotonic, sleep=time.sleep):
    """Calls fn() until it returns, retrying on `retry_on` errors, at most `attempts` times or until `deadline` seconds"""
    if attempts < 1:
        raise ValueError("at least one attempt")
    start = clock()
    delays = backoff_delays(base, factor, cap, attempts, jitter, rng)
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except retry_on as error:
            last = error
        if attempt == attempts:
            break
        delay = next(delays)
        if deadline is not None and clock() - start + delay > deadline:
            break
        sleep(delay)
    raise RetryError(attempt, last)
