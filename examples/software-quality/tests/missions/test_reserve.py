"""Robots keep a 15% reserve: enough to reach a dock if the mission takes longer than planned"""
import pytest

from fleet_sdk.battery import BatteryState, estimate_range_m
from fleet_sdk.missions import Mission, Robot, best_robot
from fleet_sdk.missions.assign import RESERVE, can_do, trip_m


def robot_with_range(range_m, reserve=RESERVE):
    """A robot whose battery takes it `range_m` meters before its reserve"""
    full = estimate_range_m(BatteryState(1.0), reserve=0) / 1.0
    return Robot('r', (0, 0), BatteryState(reserve + range_m / full))


MISSION = Mission('m', pickup=(100, 0), dropoff=(100, 50), dock=(0, 0))


@pytest.mark.parametrize('margin', [1.01, 1.1, 1.5, 3])
def test_enough_for_the_trip(margin):
    assert can_do(robot_with_range(trip_m(Robot('x', (0, 0), BatteryState(1)), MISSION) * margin), MISSION)


@pytest.mark.parametrize('margin', [0.5, 0.9, 0.99])
def test_not_enough_for_the_trip(margin):
    assert not can_do(robot_with_range(trip_m(Robot('x', (0, 0), BatteryState(1)), MISSION) * margin), MISSION)


@pytest.mark.parametrize('soc', [0.05, 0.10, 0.15])
def test_never_under_the_reserve(soc):
    assert not can_do(Robot('r', (100, 0), BatteryState(soc)), Mission('m', pickup=(100, 0), dropoff=(100, 1), dock=(100, 0)))


def test_heavier_payloads_need_more():
    light = Mission('m', pickup=(100, 0), dropoff=(100, 50), payload_kg=0)
    heavy = Mission('m', pickup=(100, 0), dropoff=(100, 50), payload_kg=40)
    r = robot_with_range(trip_m(Robot('x', (0, 0), BatteryState(1)), light) * 1.05)
    assert can_do(r, light) and not can_do(r, heavy)


def test_reserve_beats_distance():
    near = Robot('near', (100, 0), BatteryState(0.16))
    far = Robot('far', (0, 0), BatteryState(0.9))
    assert best_robot([near, far], MISSION).id == 'far'
