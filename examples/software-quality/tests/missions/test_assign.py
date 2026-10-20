import pytest

from fleet_sdk.battery import BatteryState
from fleet_sdk.missions import Mission, Robot, assign, best_robot


def robot(id, x, soc=0.8, **kwargs):
    return Robot(id, (x, 0), BatteryState(soc), **kwargs)


def mission(id, x, **kwargs):
    return Mission(id, pickup=(x, 0), dropoff=(x, 5), **kwargs)


def test_closest_robot():
    assert best_robot([robot('a', 0), robot('b', 9), robot('c', 4)], mission('m', 5)).id == 'c'


def test_busy_robots_are_skipped():
    assert best_robot([robot('a', 5, busy=True), robot('b', 9)], mission('m', 5)).id == 'b'


def test_nobody_can():
    assert best_robot([robot('a', 0, soc=0.1)], mission('m', 50)) is None


@pytest.mark.parametrize('soc_a,soc_b,expected', [(0.9, 0.5, 'a'), (0.5, 0.9, 'b'), (0.7, 0.7, 'a')])
def test_ties_go_to_the_most_charged(soc_a, soc_b, expected):
    assert best_robot([robot('a', 3, soc_a), robot('b', 7, soc_b)], mission('m', 5)).id == expected


def test_priorities_first():
    robots = [robot('a', 0)]
    assert assign(robots, [mission('low', 0), mission('urgent', 9, priority=2)]) == {'urgent': 'a', 'low': None}


def test_one_mission_per_robot():
    result = assign([robot('a', 0), robot('b', 10)], [mission(f'm{i}', i) for i in range(3)])
    assert sorted(r for r in result.values() if r) == ['a', 'b']
    assert list(result.values()).count(None) == 1


def test_skips_a_robot_low_on_battery():
    """b is closer, but going there and back would leave it under its 15% reserve"""
    robots = [robot('a', 0, soc=0.9), robot('b', 200, soc=0.165)]
    assert best_robot(robots, mission('m', 201)).id == 'a'


@pytest.mark.parametrize('n', [1, 5, 20])
def test_everyone_gets_something(n):
    robots = [robot(f'r{i}', i * 3) for i in range(n)]
    result = assign(robots, [mission(f'm{i}', i * 3 + 1) for i in range(n)])
    assert None not in result.values()
