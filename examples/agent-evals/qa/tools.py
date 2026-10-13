"""
The assistant's tools: their JSON schemas (with short or detailed descriptions, a flag), the grammar that constrains a
turn to one tool call or one answer, and their implementations over the fleet fixture (qa/fleet.py).
"""
import json
import re

from fleet import MISSIONS

ROBOT = {'type': 'string', 'pattern': 'K3-[0-9]{3}', 'description': 'A robot id, like K3-007'}

# name -> (short description, detailed description, parameters, required). The order is the prompt's.
TOOLS = {
    'list_robots': (
        'List robots.',
        'List every robot of the fleet with its status and zone. Use it to find robots by zone or by status.',
        {}, [],
    ),
    'get_status': (
        'Robot status.',
        "One robot's status (idle, on-mission, charging or error), its zone, and its error if it has one.",
        {'robot': ROBOT}, ['robot'],
    ),
    'get_battery': (
        'Battery level.',
        "One robot's battery level in percent, and whether it is charging.",
        {'robot': ROBOT}, ['robot'],
    ),
    'get_mission': (
        'Current mission.',
        "One robot's current mission and its progress, or none.",
        {'robot': ROBOT}, ['robot'],
    ),
    'assign_mission': (
        'Assign a mission.',
        'Give a robot a new mission, which replaces its current one. Fails if the robot is in error, or below 20% '
        'battery (except return-to-dock).',
        {'robot': ROBOT, 'mission': {'type': 'string', 'enum': MISSIONS}}, ['robot', 'mission'],
    ),
    'reboot_robot': (
        'Reboot a robot.',
        'Reboot a robot: it stops what it is doing for about 3 minutes. Needs the operator\'s confirmation: ask them '
        'first and wait for their answer. Set confirmed to true only after they said yes.',
        {'robot': ROBOT, 'confirmed': {'type': 'boolean', 'description': 'The operator said yes to this reboot'}},
        ['robot', 'confirmed'],
    ),
    'search_maintenance_log': (
        'Search the maintenance log.',
        'Search the maintenance log (repairs and checks) by robot id or keyword: wheel, camera, battery, firmware...',
        {'query': {'type': 'string', 'description': 'A robot id or a keyword'}}, ['query'],
    ),
}
ACTIONS = {'assign_mission', 'reboot_robot'}   # tools that change the fleet


def schemas(descriptions: str) -> list:
    """The tools as JSON schemas (OpenAI-style function definitions), with `short` or `detailed` descriptions"""
    out = []
    for name, (short, detailed, params, required) in TOOLS.items():
        properties = {}
        for key, schema in params.items():
            schema = dict(schema)
            if descriptions == 'short':
                schema.pop('description', None)
            properties[key] = schema
        out.append({'name': name, 'description': short if descriptions == 'short' else detailed,
                    'parameters': {'type': 'object', 'properties': properties, 'required': required}})
    return out


def signature(tool: dict) -> str:
    """One tool for the prompt: `get_battery(robot: string): One robot's battery...`"""
    params = []
    for key, schema in tool['parameters']['properties'].items():
        kind = ' | '.join(json.dumps(v) for v in schema['enum']) if 'enum' in schema else schema['type']
        note = f" ({schema['description']})" if schema.get('description') else ''
        params.append(f'{key}: {kind}{note}')
    return f"- {tool['name']}({', '.join(params)}): {tool['description']}"


# ------------------------------------------------------------------------------------------------ grammar

def _gbnf_value(schema: dict) -> str:
    if 'enum' in schema:
        return '(' + ' | '.join(json.dumps(json.dumps(v)) for v in schema['enum']) + ')'
    if schema['type'] == 'boolean':
        return '("true" | "false")'
    if schema.get('pattern') == ROBOT['pattern']:
        return '"\\"K3-" [0-9] [0-9] [0-9] "\\""'
    return 'string'


def grammar(tools: list, thought: bool) -> str:
    """
    GBNF for one assistant turn: a JSON object that is either a tool call that fits the tool's schema, or an answer
    to the operator. With `thought`, both start with a "thought" (prompts that ask the model to think first).
    """
    rules = []
    alternatives = []
    for tool in tools:
        name = tool['name']
        rule = 'call-' + name.replace('_', '-')
        props = tool['parameters']['properties']
        args = ' "," ws '.join(f'"\\"{key}\\":" ws {_gbnf_value(schema)}' for key, schema in props.items())
        rules.append(f'{rule} ::= "\\"tool\\":" ws "\\"{name}\\"," ws "\\"arguments\\":" ws "{{" {args or ""} "}}"')
        alternatives.append(rule)
    rules.append('answer ::= "\\"answer\\":" ws string')
    alternatives.append('answer')
    head = '"\\"thought\\":" ws string "," ws ' if thought else ''
    return '\n'.join([
        f'root ::= "{{" {head}({" | ".join(alternatives)}) "}}"',
        *rules,
        # strings stay on one line; an answer or thought can't run on forever
        'string ::= "\\"" char{0,400} "\\""',
        'char ::= [^"\\\\\\x00-\\x1f] | "\\\\" ["\\\\/nt]',
        'ws ::= " "?',
    ]) + '\n'


# ------------------------------------------------------------------------------------------------ implementations

class ToolError(Exception):
    pass


def call(fleet: dict, name: str, arguments: dict, require_confirmation: bool) -> dict:
    """
    Runs a tool on the fleet (changed in place by actions). Returns its result, or {"error": ...} when the call fails;
    `executed` tells whether an action really happened.
    """
    robots = fleet['robots']

    def robot_of(args):
        robot = args.get('robot')
        if robot not in robots:
            raise ToolError(f'unknown robot: {robot}. Robots are K3-001 to K3-{len(robots):03d}')
        return robot, robots[robot]

    try:
        if name == 'list_robots':
            return {'result': {r: f"{v['status']}, {v['zone']}" for r, v in robots.items()}}
        if name == 'get_status':
            robot, r = robot_of(arguments)
            out = {'robot': robot, 'status': r['status'], 'zone': r['zone']}
            if r.get('error'):
                out['error'] = r['error']
            return {'result': out}
        if name == 'get_battery':
            robot, r = robot_of(arguments)
            return {'result': {'robot': robot, 'battery': f"{r['battery']}%", 'charging': r['status'] == 'charging'}}
        if name == 'get_mission':
            robot, r = robot_of(arguments)
            m = r.get('mission')
            return {'result': {'robot': robot, 'mission': f"{m['kind']}, {m['progress']}% done" if m else 'none'}}
        if name == 'assign_mission':
            robot, r = robot_of(arguments)
            if r['status'] == 'error':
                raise ToolError(f"{robot} is in error ({r['error']}): reboot it or send a technician first")
            if r['battery'] < 20 and arguments['mission'] != 'return-to-dock':
                raise ToolError(f"{robot} has {r['battery']}% battery, under the 20% needed for a mission")
            r.update(status='on-mission', mission={'kind': arguments['mission'], 'progress': 0})
            return {'result': {'robot': robot, 'mission': arguments['mission'], 'started': True}, 'executed': True}
        if name == 'reboot_robot':
            robot, r = robot_of(arguments)
            if require_confirmation and not arguments.get('confirmed'):
                raise ToolError(f'{robot} was not rebooted: confirmed is false. Ask the operator to confirm first')
            r.update(status='rebooting', mission=None, error=None)
            return {'result': {'robot': robot, 'rebooting': True, 'back_in': '3 min'}, 'executed': True}
        if name == 'search_maintenance_log':
            words = [w for w in re.findall(r'[\w-]+', str(arguments.get('query', '')).lower()) if len(w) > 2]
            hits = [e for e in fleet['log'] if words and all(w in f"{e['robot']} {e['part']} {e['entry']}".lower() for w in words)]
            if not hits and words:   # any word
                hits = [e for e in fleet['log'] if any(w in f"{e['robot']} {e['part']} {e['entry']}".lower() for w in words)]
            hits = sorted(hits, key=lambda e: e['date'], reverse=True)[:4]
            return {'result': [f"{e['date']} {e['robot']}: {e['entry']}" for e in hits] or 'no entries'}
        raise ToolError(f'unknown tool: {name}')
    except ToolError as e:
        return {'error': str(e)}
