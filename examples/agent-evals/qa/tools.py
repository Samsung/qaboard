"""
The assistant's tools: their JSON schemas (with short or detailed descriptions, a flag), the grammar that constrains a
turn to one tool call or one answer, and their implementations over the fleet fixture (qa/fleet.py).

Tool calls use Qwen2.5's format, which both models read as plain ChatML: the system prompt lists the tools as JSON in
<tools></tools>, and a call is a JSON object in <tool_call></tool_call>.
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
        "Reboot a robot: it stops what it is doing for about 3 minutes. Needs the operator's confirmation: never call "
        'it before you asked them "Reboot K3-...?" and they answered yes.',
        {'robot': ROBOT, 'confirmed': {'type': 'boolean', 'description': 'The operator said yes to this reboot'}},
        ['robot', 'confirmed'],
    ),
    'search_maintenance_log': (
        'Search the maintenance log.',
        'Search the maintenance log (repairs, checks and incidents, with their dates) by robot id or keyword: wheel, '
        'camera, battery, firmware...',
        {'query': {'type': 'string', 'description': 'A robot id or a keyword'}}, ['query'],
    ),
}
ACTIONS = {'assign_mission', 'reboot_robot'}   # tools that change the fleet
NEEDS_CONFIRMATION = {'reboot_robot'}


def schemas(descriptions: str) -> list:
    """The tools as JSON schemas (OpenAI-style function definitions), with `short` or `detailed` descriptions"""
    out = []
    for name, (short, detailed, params, required) in TOOLS.items():
        properties = {}
        for key, schema in params.items():
            schema = {k: v for k, v in schema.items() if k != 'pattern'}
            if descriptions == 'short':
                schema.pop('description', None)
            properties[key] = schema
        out.append({'name': name, 'description': short if descriptions == 'short' else detailed,
                    'parameters': {'type': 'object', 'properties': properties, 'required': required}})
    return out


def prompt_section(tool_schemas: list) -> str:
    """The tools for the system prompt, as in Qwen2.5's chat template"""
    lines = '\n'.join(json.dumps({'type': 'function', 'function': t}, ensure_ascii=False) for t in tool_schemas)
    return (
        '# Tools\n\nYou may call one or more functions to assist with the user query.\n\n'
        'You are provided with function signatures within <tools></tools> XML tags:\n'
        f'<tools>\n{lines}\n</tools>\n\n'
        'For each function call, return a json object with function name and arguments within '
        '<tool_call></tool_call> XML tags:\n'
        '<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>'
    )


def format_call(name: str, arguments: dict) -> str:
    return f'<tool_call>\n{json.dumps({"name": name, "arguments": arguments}, ensure_ascii=False)}\n</tool_call>'


def parse_call(text: str):
    """(name, arguments) of a <tool_call>, or None"""
    m = re.fullmatch(r'\s*<tool_call>\s*(\{.*\})\s*</tool_call>\s*', text, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return None
    return data.get('name'), data.get('arguments') or {}


# ------------------------------------------------------------------------------------------------ grammar

def _gbnf_value(schema: dict, pattern=None) -> str:
    if 'enum' in schema:
        return '(' + ' | '.join(json.dumps(json.dumps(v)) for v in schema['enum']) + ')'
    if schema['type'] == 'boolean':
        return '("true" | "false")'
    if pattern == ROBOT['pattern']:
        return '"\\"K3-" [0-9] [0-9] [0-9] "\\""'
    return 'string'


def grammar(tool_schemas: list, thought: bool) -> str:
    """
    GBNF for one assistant turn: either a tool call that fits the tool's schema (the model picks the tool and its
    arguments, the grammar only keeps them well-formed), or an answer to the operator: one paragraph of text. With
    `thought`, both start with a line "Thought: ..." (prompts that ask the model to think first).
    """
    rules = []
    alternatives = []
    for tool in tool_schemas:
        name = tool['name']
        rule = 'call-' + name.replace('_', '-')
        props = tool['parameters']['properties']
        patterns = {k: s.get('pattern') for k, s in TOOLS[name][2].items()}
        args = ' ", " '.join(f'"\\"{key}\\": " {_gbnf_value(schema, patterns.get(key))}' for key, schema in props.items())
        rules.append(f'{rule} ::= "\\"{name}\\", \\"arguments\\": {{" {args or ""} "}}"')
        alternatives.append(rule)
    head = '"Thought: " line "\\n" ' if thought else ''
    return '\n'.join([
        f'root ::= {head}(call | answer)',
        f'call ::= "<tool_call>\\n{{\\"name\\": " ({" | ".join(alternatives)}) "}}\\n</tool_call>"',
        *rules,
        # one paragraph, that doesn't look like a tool call. No bounded repetitions ({0,300}): llama.cpp expands them
        # into nested rules, 10 times slower to sample. MAX_TOKENS (qa/agent.py) bounds a turn.
        'answer ::= [^<\\n ] line',
        'line ::= [^\\n]*',
        'string ::= "\\"" ([^"\\\\\\x00-\\x1f] | "\\\\" ["\\\\/nt])* "\\""',
    ]) + '\n'


# ------------------------------------------------------------------------------------------------ implementations

class ToolError(Exception):
    pass


def call(fleet: dict, name: str, arguments: dict, require_confirmation: bool, operator_confirmed: bool) -> dict:
    """
    Runs a tool on the fleet (changed in place by actions). Returns its result, or {"error": ...} when the call fails;
    `executed` tells whether an action really happened.

    With `require_confirmation`, an action that needs the operator's confirmation runs only if their last message
    said yes to a question of the assistant (`operator_confirmed`, from the conversation): the model's own `confirmed`
    argument isn't trusted.
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
            return {'result': {'robot': robot, 'mission': m['kind'] if m else 'none', 'progress': f"{m['progress']}%" if m else None}}
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
            if require_confirmation and not operator_confirmed:
                raise ToolError(f'{robot} was not rebooted: the operator has not confirmed. Ask them "Reboot {robot}?"')
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
