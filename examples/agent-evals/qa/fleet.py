"""
The simulated fleet the assistant works on: 30 K3 robots, their missions and batteries, and a maintenance log.
Generated from a seed, then each task sets the facts its checks rely on (`fleet:` in the task's YAML). Same seed, same
fleet: everything here is plain Python over that fixture.
"""
import random
from copy import deepcopy

ROBOTS = [f'K3-{n:03d}' for n in range(1, 31)]
ZONES = [f'aisle-{n}' for n in range(1, 13)] + ['back-room', 'dock-a', 'dock-b']
MISSIONS = ['count-stock', 'scan-shelves', 'patrol', 'return-to-dock']
STATUSES = ['idle', 'on-mission', 'charging', 'error']
LOG_TEMPLATES = [
    ('replaced the left drive wheel', 'drive'),
    ('replaced the right drive wheel', 'drive'),
    ('cleaned the depth camera window', 'camera'),
    ('recalibrated the depth camera', 'camera'),
    ('swapped the battery pack', 'battery'),
    ('battery health check: {health}% capacity', 'battery'),
    ('installed firmware 26.{fw}', 'firmware'),
    ('drive controller timeout, rebooted', 'drive'),
    ('bumper sensor replaced after a collision', 'bumper'),
    ('Wi-Fi module reseated, packet loss gone', 'network'),
]


def generate(seed: int) -> dict:
    """The fleet before a task's own facts: robots with status, zone, battery and mission, and the maintenance log"""
    rng = random.Random(seed)
    robots = {}
    for robot in ROBOTS:
        status = rng.choices(STATUSES, weights=[4, 5, 2, 1])[0]
        battery = rng.randint(55, 98) if status != 'charging' else rng.randint(12, 60)
        robots[robot] = {
            'status': status,
            'zone': rng.choice(ZONES[:12]) if status != 'charging' else rng.choice(['dock-a', 'dock-b']),
            'battery': battery,
            'mission': None,
            'error': 'lidar heartbeat lost' if status == 'error' else None,
            'firmware': f'26.0{rng.choice([7, 8, 8, 9])}',
        }
        if status == 'on-mission':
            robots[robot]['mission'] = {'kind': rng.choice(MISSIONS[:3]), 'progress': rng.randint(5, 95)}
    log = []
    for n in range(40):
        robot = rng.choice(ROBOTS)
        text, part = rng.choice(LOG_TEMPLATES)
        log.append({
            'date': f'2026-{rng.choice([8, 9]):02d}-{rng.randint(1, 28):02d}',
            'robot': robot,
            'part': part,
            'entry': text.format(health=rng.randint(70, 96), fw=f'0{rng.choice([8, 9])}'),
        })
    log.sort(key=lambda e: (e['date'], e['robot']))
    return {'robots': robots, 'log': log}


def with_facts(fleet: dict, facts: dict) -> dict:
    """The task's facts over the generated fleet: `{K3-014: {battery: 23}, log: [...]}`"""
    fleet = deepcopy(fleet)
    for key, value in (facts or {}).items():
        if key == 'log':
            fleet['log'] = sorted(fleet['log'] + list(value), key=lambda e: (e['date'], e['robot']))
            continue
        if key not in fleet['robots']:
            raise ValueError(f'unknown robot in the task facts: {key}')
        robot = fleet['robots'][key]
        robot.update(value)
        if robot['status'] != 'on-mission':
            robot['mission'] = value.get('mission')
        if robot['status'] != 'error':
            robot['error'] = None
    return fleet
