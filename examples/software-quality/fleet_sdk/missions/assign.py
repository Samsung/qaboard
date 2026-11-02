"""
A mission goes to the robot that can do it soonest: the closest one among those with enough battery to drive there,
do it, and get back to a dock with their reserve left.
"""
import math
from dataclasses import dataclass, field

from .._flags import flags
from ..battery import BatteryState, estimate_range_m

RESERVE = 0.15


@dataclass
class Robot:
    id: str
    position: tuple
    battery: BatteryState
    busy: bool = False
    payload_kg: float = 0.0


@dataclass
class Mission:
    id: str
    pickup: tuple
    dropoff: tuple
    payload_kg: float = 0.0
    priority: int = 0          # higher first
    dock: tuple = (0, 0)
    tags: list = field(default_factory=list)


def distance_m(a, b, cell_m=1.2) -> float:
    return math.dist(a, b) * cell_m


def trip_m(robot: Robot, mission: Mission) -> float:
    return (distance_m(robot.position, mission.pickup) + distance_m(mission.pickup, mission.dropoff)
            + distance_m(mission.dropoff, mission.dock))


def can_do(robot: Robot, mission: Mission) -> bool:
    if robot.busy:
        return False
    if flags()['bug_missions_reserve']:
        return estimate_range_m(robot.battery, mission.payload_kg, reserve=0.0) >= trip_m(robot, mission)
    return estimate_range_m(robot.battery, mission.payload_kg, reserve=RESERVE) >= trip_m(robot, mission)


def best_robot(robots, mission: Mission):
    """The closest robot that can do the mission, None if none can. Ties: the most charged, then by id."""
    candidates = [r for r in robots if can_do(r, mission)]
    if not candidates:
        return None
    return min(candidates, key=lambda r: (distance_m(r.position, mission.pickup), -r.battery.soc, r.id))


def assign(robots, missions) -> dict:
    """mission id -> robot id (or None), missions by priority then id, each robot gets one mission at most"""
    free = [r for r in robots if not r.busy]
    result = {}
    for mission in sorted(missions, key=lambda m: (-m.priority, m.id)):
        robot = best_robot(free, mission)
        result[mission.id] = robot.id if robot else None
        if robot:
            free.remove(robot)
    return result
