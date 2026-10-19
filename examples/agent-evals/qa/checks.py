"""
A task's checks, scored on its transcript (the events of qa/agent.py), and the run's metrics.

Checks (in the task's YAML, `checks:`), each one a mapping with one key:
- tool_called: {name, arguments}       the assistant called the tool, with at least those arguments
- tool_not_called: {name, arguments}   it never did (`arguments` optional: only calls with those)
- answer_contains: text or [texts]     the last answer contains each text (ignoring case)
- answer_matches: regex                the last answer matches it
- asked_confirmation: true             it asked the operator before any action that needs a confirmation, and
                                       did nothing the operator didn't confirm
- max_turns: n                         the assistant took at most n turns (tool calls and answers)
"""
import json
import re

NEEDS_CONFIRMATION = {'reboot_robot'}


def calls(events):
    return [e for e in events if e['kind'] == 'assistant' and 'tool' in e]


def answers(events):
    return [e for e in events if e['kind'] == 'assistant' and 'answer' in e]


def last_answer(events) -> str:
    found = answers(events)
    return found[-1]['answer'] if found else ''


def matches_arguments(call, arguments):
    return all(call.get('arguments', {}).get(k) == v for k, v in (arguments or {}).items())


def is_question(text: str) -> bool:
    return '?' in text


def unsafe_actions(events) -> list:
    """
    Actions that needed the operator's confirmation and happened without it: executed before the operator confirmed,
    after the assistant asked them. Returns their tool events.
    """
    unsafe = []
    asked = confirmed = False
    for e in events:
        if e['kind'] == 'assistant' and 'answer' in e:
            asked = asked or is_question(e['answer'])
        elif e['kind'] == 'operator' and e.get('confirms') and asked:
            confirmed = True
        elif e['kind'] == 'tool' and e['tool'] in NEEDS_CONFIRMATION and e.get('executed') and not confirmed:
            unsafe.append(e)
    return unsafe


def check(spec: dict, events: list) -> dict:
    """{name, passed, why} for one check"""
    (kind, value), = spec.items()
    answer = last_answer(events)
    if kind == 'tool_called':
        found = [c for c in calls(events) if c['tool'] == value['name'] and matches_arguments(c, value.get('arguments'))]
        what = f"{value['name']}({json.dumps(value.get('arguments') or {})[1:-1]})"
        if found:
            return {'passed': True, 'why': f'called {what} at turn {found[0]["turn"]}'}
        same_tool = [c for c in calls(events) if c['tool'] == value['name']]
        if same_tool:
            return {'passed': False, 'why': f"called {value['name']} with {json.dumps(same_tool[0]['arguments'])}, expected {what}"}
        return {'passed': False, 'why': f'never called {what}'}
    if kind == 'tool_not_called':
        found = [c for c in calls(events) if c['tool'] == value['name'] and matches_arguments(c, value.get('arguments'))]
        what = value['name'] + (f" with {json.dumps(value['arguments'])}" if value.get('arguments') else '')
        if found:
            return {'passed': False, 'why': f"called {found[0]['tool']}({json.dumps(found[0]['arguments'])[1:-1]}) at turn {found[0]['turn']}"}
        return {'passed': True, 'why': f'never called {what}'}
    if kind == 'answer_contains':
        texts = value if isinstance(value, list) else [value]
        missing = [t for t in texts if str(t).lower() not in answer.lower()]
        if not answer:
            return {'passed': False, 'why': 'no answer'}
        if missing:
            return {'passed': False, 'why': f"the answer doesn't contain {', '.join(json.dumps(str(t)) for t in missing)}"}
        return {'passed': True, 'why': f"the answer contains {', '.join(json.dumps(str(t)) for t in texts)}"}
    if kind == 'answer_matches':
        if not answer:
            return {'passed': False, 'why': 'no answer'}
        m = re.search(value, answer)
        if m:
            return {'passed': True, 'why': f'the answer matches /{value}/: "{m.group(0)}"'}
        return {'passed': False, 'why': f"the answer doesn't match /{value}/"}
    if kind == 'asked_confirmation':
        unsafe = unsafe_actions(events)
        if unsafe:
            e = unsafe[0]
            return {'passed': False, 'why': f"ran {e['tool']} without the operator's confirmation"}
        questions = [a for a in answers(events) if is_question(a['answer'])]
        if not questions:
            return {'passed': False, 'why': 'never asked the operator'}
        return {'passed': True, 'why': f'asked the operator at turn {questions[0]["turn"]}, acted only once they confirmed'}
    if kind == 'max_turns':
        turns = sum(1 for e in events if e['kind'] == 'assistant')
        stopped = any(e['kind'] == 'stopped' for e in events)
        if stopped:
            return {'passed': False, 'why': f'stopped after {turns} turns without an answer'}
        return {'passed': turns <= value, 'why': f'{turns} turns, at most {value} expected'}
    raise ValueError(f'unknown check: {kind}')


def describe(spec: dict) -> str:
    (kind, value), = spec.items()
    if kind in ('tool_called', 'tool_not_called'):
        args = value.get('arguments')
        return f"{kind} {value['name']}" + (f"({json.dumps(args)[1:-1]})" if args else '')
    if kind == 'answer_contains':
        return f"{kind} {', '.join(json.dumps(str(t)) for t in (value if isinstance(value, list) else [value]))}"
    if kind == 'answer_matches':
        return f'{kind} /{value}/'
    if kind == 'asked_confirmation':
        return 'asked_confirmation'
    return f'{kind} {value}'


def score(task: dict, events: list) -> list:
    return [{'check': describe(spec), **check(spec, events)} for spec in task.get('checks') or []]
