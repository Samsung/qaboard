"""
QA-Board runs this file: `qa run --input safety/reboot-without-asking.yaml` calls run(context).

A run is one task (tasks/<category>/<name>.yaml): the operator's request, the fleet's facts, and the checks. The
assistant (qa/agent.py) answers it with a local model and the fleet's tools; the checks score its transcript. The run
saves the transcript, an HTML report and a plot of the tool calls, and returns the metrics (qa/metrics.yaml).
- the code's flags come from build/flags.json (what a commit changed), tuning parameters override them.
"""
import json
import os
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent  # noqa: E402
import checks  # noqa: E402
import fleet as fleets  # noqa: E402
import models  # noqa: E402
import plots  # noqa: E402
import report  # noqa: E402
import transcript  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# The code's defaults: the head of `main` at T0. A commit's changes are in build/flags.json.
DEFAULT_FLAGS = {
    'model': 'qwen2.5-0.5b',          # smollm2-360m, qwen2.5-0.5b (inputs.lock.yaml)
    'prompt': 'v5',                   # v1 ... v5: the system prompt, prompts/<prompt>.md
    'max_turns': 6,                   # 2-10: the assistant's turns (tool calls and answers) in a conversation
    'tool_descriptions': 'detailed',  # short, detailed: how the prompt describes the tools
    'require_confirmation': True,     # reboot_robot refuses to run with confirmed: false
}
FLEET_SEED = 2026   # the fleet every task starts from, before its own facts


def read_flags(params=None):
    flags = dict(DEFAULT_FLAGS)
    path = ROOT / 'build' / 'flags.json'
    if path.exists():
        flags.update({k: v for k, v in json.loads(path.read_text()).items() if v is not None and k in DEFAULT_FLAGS})
    flags.update({k: v for k, v in (params or {}).items() if k in DEFAULT_FLAGS})   # tuning parameters
    flags['max_turns'] = int(flags['max_turns'])
    if isinstance(flags['require_confirmation'], str):
        flags['require_confirmation'] = flags['require_confirmation'].lower() == 'true'
    return flags


def prices() -> dict:
    return yaml.safe_load((ROOT / 'qa' / 'prices.yaml').read_text())['models']


def evaluate(task_path: Path, flags: dict, name: str, log=print) -> dict:
    """Runs a task with these flags: its conversation (memoized), checks and metrics"""
    task = yaml.safe_load(task_path.read_text())
    model = models.model(flags['model'], log=log)
    prompt = agent.load_prompt(flags['prompt'])
    fleet = fleets.with_facts(fleets.generate(FLEET_SEED), task.get('fleet'))
    conversation = agent.run(model, task, fleet, flags, prompt, log=log)
    events = conversation['events']
    results = checks.score(task, events)
    turns = [e for e in events if e['kind'] == 'assistant']
    tool_events = [e for e in events if e['kind'] == 'tool']
    tokens_in = sum(t['tokens_in'] for t in turns)
    tokens_out = sum(t['tokens_out'] for t in turns)
    price = prices()[flags['model']]
    metrics = {
        'passed': 1 if all(r['passed'] for r in results) else 0,
        'checks_passed': sum(r['passed'] for r in results) / len(results) if results else 1,
        'unsafe_actions': len(checks.unsafe_actions(events)),
        'turns': len(turns),
        'tokens': tokens_in + tokens_out,
        'tokens_in': tokens_in,
        'tokens_out': tokens_out,
        'cost': (tokens_in * price['input'] + tokens_out * price['output']) / 1e6,
        'latency': sum(e['seconds'] for e in turns + tool_events),
        'tool_errors': sum(1 for e in tool_events if e.get('error')) + sum(1 for t in turns if t.get('error')),
        'is_failed': False,
    }
    return {'task': task, 'name': name, 'events': events, 'checks': results, 'metrics': metrics, 'flags': flags,
            'model': model, 'prompt': prompt, 'memoized': conversation['memoized'], 'key': conversation['key']}


def run(context):
    flags = read_flags(context.params)
    name = context.rel_input_path.with_suffix('').as_posix()
    print(f"{name}: model {flags['model']}, prompt {flags['prompt']}, {flags['tool_descriptions']} tool descriptions, "
          f"max {flags['max_turns']} turns, confirmation {'required' if flags['require_confirmation'] else 'not required'}")
    result = evaluate(context.input_path, flags, name)
    output_dir = Path(context.output_dir)
    (output_dir / 'transcript.txt').write_text(transcript.text(result['events']))
    (output_dir / 'conversation.json').write_text(json.dumps({k: result[k] for k in ('events', 'checks', 'metrics', 'flags')}, indent=1))
    report.write(output_dir / 'report.html', result)
    plots.tool_calls(output_dir / 'tools.plotly.json', result['events'], f'{name}: tool calls per turn')
    m = result['metrics']
    for c in result['checks']:
        print(f"  {'PASS' if c['passed'] else 'FAIL'}  {c['check']}: {c['why']}")
    print(f"{'passed' if m['passed'] else 'FAILED'}: {m['turns']} turns, {m['tokens']} tokens, {m['latency']:.2f} s, "
          f"{m['unsafe_actions']} unsafe actions, {m['tool_errors']} tool errors")
    return {**m, 'params': {'model': flags['model'], 'prompt': flags['prompt']}}


if __name__ == '__main__':
    # A quick look without QA-Board: python qa/main.py tasks/lookup/battery-level.yaml [...] (flags from build/flags.json)
    flags = read_flags(json.loads(os.environ.get('FLAGS', '{}')))
    for arg in sys.argv[1:]:
        r = evaluate(Path(arg), flags, Path(arg).stem)
        print(transcript.text(r['events']))
        for c in r['checks']:
            print(f"  {'PASS' if c['passed'] else 'FAIL'}  {c['check']}: {c['why']}")
        print(json.dumps(r['metrics']))
