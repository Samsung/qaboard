import random

import pytest

from fleet_sdk.client import RetryError, backoff_delays, retry


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def failing(times, error=ConnectionError):
    calls = []

    def fn():
        calls.append(1)
        if len(calls) <= times:
            raise error("backend unreachable")
        return 'ok'
    fn.calls = calls
    return fn


def test_no_retry_when_it_works():
    clock = FakeClock()
    assert retry(failing(0), clock=clock, sleep=clock.sleep) == 'ok'
    assert clock.sleeps == []


@pytest.mark.parametrize('failures', [1, 2, 3, 4])
def test_retries_until_it_works(failures):
    clock = FakeClock()
    fn = failing(failures)
    assert retry(fn, attempts=5, clock=clock, sleep=clock.sleep) == 'ok'
    assert len(fn.calls) == failures + 1


def test_gives_up():
    clock = FakeClock()
    with pytest.raises(RetryError) as e:
        retry(failing(10), attempts=3, clock=clock, sleep=clock.sleep)
    assert e.value.attempts == 3


def test_other_errors_are_not_retried():
    with pytest.raises(KeyError):
        retry(failing(1, KeyError), sleep=lambda s: None)


def test_exponential_without_jitter():
    assert list(backoff_delays(base=0.1, factor=2, cap=1, attempts=6, jitter=False)) == pytest.approx([0.1, 0.2, 0.4, 0.8, 1])


@pytest.mark.parametrize('seed', range(5))
def test_full_jitter_stays_under_the_delay(seed):
    delays = list(backoff_delays(base=0.1, factor=2, cap=1, attempts=8, rng=random.Random(seed)))
    caps = [min(1, 0.1 * 2 ** n) for n in range(7)]
    assert all(0 <= d <= c for d, c in zip(delays, caps))


def test_deadline():
    clock = FakeClock()
    with pytest.raises(RetryError):
        retry(failing(100), attempts=100, base=1, cap=1, jitter=False, deadline=3.5, clock=clock, sleep=clock.sleep)
    assert sum(clock.sleeps) <= 3.5


def test_at_least_one_attempt():
    with pytest.raises(ValueError):
        retry(lambda: 1, attempts=0)
