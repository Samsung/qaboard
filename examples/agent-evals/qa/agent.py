"""
The assistant: an agent loop over a local model (llama.cpp through llama-cpp-python). Each turn, the model writes
either a tool call (Qwen2.5's <tool_call> format, constrained by a grammar to fit the tool's schema, see qa/tools.py)
or an answer to the operator. Tool results go back to the model; an answer goes to the operator, who may reply (the
task's `replies`).

Decoding is greedy (temperature 0) with a fixed seed and thread count, on a pinned llama.cpp build: on the same kind of
CPU, the same inputs give the same transcript.

A conversation is memoized by everything it depends on (the model file, the llama.cpp build, the prompt, the tools,
the flags, the task, this code): computing it again would give the same transcript, so a commit that doesn't change
them reuses it, with its measured times. Cached in ~/.cache/kitefin/fleet-assistant/runs (or $FLEET_ASSISTANT_CACHE).
"""
import copy
import hashlib
import json
import os
import re
import time
from pathlib import Path

import tools
from models import cache_dir

ROOT = Path(__file__).resolve().parent.parent
THREADS = int(os.environ.get('FLEET_ASSISTANT_THREADS', 4))
CONTEXT = 4096
MAX_TOKENS = 160   # per turn
SEED = 1234
CODE = [Path(__file__), Path(tools.__file__), Path(__file__).with_name('fleet.py')]


def load_prompt(version: str) -> dict:
    """
    prompts/<version>.md: optional `key: value` front matter between `---` lines, the system prompt, then optional
    example conversations, each under a `## Example` heading, one message per line:

        operator: If K3-019 has over 30% battery, send it to scan the shelves.
        thought: ...                                   (prompts with `thought: true`)
        call: get_battery {"robot": "K3-019"}
        result: {"robot": "K3-019", "battery": "72%", "charging": false}
        assistant: K3-019 has 72% battery...

    The examples go to the model as earlier turns of the conversation, before the operator's request: small models
    follow what they see done more than what they are told.
    """
    text = (ROOT / 'prompts' / f'{version}.md').read_text()
    meta = {}
    m = re.match(r'^---\n(.*?)\n---\n', text, re.S)
    if m:
        for line in m.group(1).splitlines():
            key, _, value = line.partition(':')
            meta[key.strip()] = yaml_scalar(value.strip())
        text = text[m.end():]
    system, *examples = re.split(r'^## Example.*\n', text, flags=re.M)
    thought = bool(meta.get('thought'))
    return {'version': version, 'text': system.strip(), 'thought': thought, 'meta': meta,
            'examples': [example_messages(e, thought) for e in examples]}


def example_messages(text: str, thought: bool) -> list:
    messages, pending_thought = [], ''
    for line in text.strip().splitlines():
        role, _, content = line.partition(': ')
        if role == 'thought':
            pending_thought = f'Thought: {content}\n'
        elif role == 'operator':
            messages.append({'role': 'user', 'content': content})
        elif role == 'call':
            name, _, arguments = content.partition(' ')
            messages.append({'role': 'assistant', 'content': pending_thought + tools.format_call(name, json.loads(arguments))})
            pending_thought = ''
        elif role == 'result':
            messages.append({'role': 'tool', 'content': content})
        elif role == 'assistant':
            messages.append({'role': 'assistant', 'content': pending_thought + content})
            pending_thought = ''
        elif line.strip():
            raise ValueError(f'unexpected line in an example: {line!r}')
    if thought and any(m['role'] == 'assistant' and not m['content'].startswith('Thought: ') for m in messages):
        raise ValueError('with `thought: true`, every assistant message of the examples needs a thought')
    return messages


def yaml_scalar(value: str):
    return {'true': True, 'false': False}.get(value.lower(), value)


def system_prompt(prompt: dict, tool_schemas: list) -> str:
    """The prompt, then the tools as Qwen2.5's chat template lists them"""
    return f"{prompt['text']}\n\n{tools.prompt_section(tool_schemas)}"


# ------------------------------------------------------------------------------------------------ the chat format

def chatml(messages: list) -> str:
    """Both models use ChatML. Tool results go in a user turn, in <tool_response> tags, like Qwen2.5's template."""
    parts = []
    for m in messages:
        if m['role'] == 'tool':
            parts.append(f"<|im_start|>user\n<tool_response>\n{m['content']}\n</tool_response><|im_end|>\n")
        else:
            parts.append(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n")
    return ''.join(parts) + '<|im_start|>assistant\n'


class Model:
    """A GGUF model in llama.cpp. Loaded once per run; llama-cpp-python keeps the common prefix of prompts in its cache."""

    def __init__(self, path: Path):
        from llama_cpp import Llama
        self.llm = Llama(model_path=str(path), n_ctx=CONTEXT, n_threads=THREADS, n_threads_batch=THREADS,
                         n_batch=512, seed=SEED, verbose=False)

    def complete(self, prompt: str, grammar: str) -> dict:
        from llama_cpp import LlamaGrammar
        start = time.perf_counter()
        out = self.llm.create_completion(prompt, max_tokens=MAX_TOKENS, temperature=0.0, seed=SEED,
                                         grammar=LlamaGrammar.from_string(grammar, verbose=False),
                                         stop=['<|im_end|>'])
        return {
            'text': out['choices'][0]['text'],
            'finish_reason': out['choices'][0]['finish_reason'],
            'tokens_in': out['usage']['prompt_tokens'],
            'tokens_out': out['usage']['completion_tokens'],
            'seconds': time.perf_counter() - start,
        }


def llama_cpp_version() -> str:
    try:
        from importlib.metadata import version
        return version('llama_cpp_python')
    except Exception:
        return 'unknown'


# ------------------------------------------------------------------------------------------------ the loop

def parse_turn(text: str, thought: bool) -> dict:
    """The turn's thought (if the prompt asks for one), and its tool call or answer"""
    turn = {}
    if thought:
        first, _, text = text.partition('\n')
        turn['thought'] = first.removeprefix('Thought: ').strip()
    call = tools.parse_call(text)
    if call:
        turn['tool'], turn['arguments'] = call
    elif text.lstrip().startswith('<tool_call>'):
        turn['error'] = 'tool call cut before its end'
    else:
        turn['answer'] = text.strip()
    return turn


def converse(model_loader, task: dict, fleet: dict, flags: dict, prompt: dict) -> dict:
    """
    Runs the conversation of one task. Returns its events: the operator's messages, the assistant's turns (tool call
    or answer, with tokens and seconds), the tools' results. `model_loader()` gives the Model, only if needed.
    """
    fleet = copy.deepcopy(fleet)
    schemas = tools.schemas(flags['tool_descriptions'])
    grammar = tools.grammar(schemas, thought=prompt['thought'])
    messages = [{'role': 'system', 'content': system_prompt(prompt, schemas)},
                *[m for example in prompt['examples'] for m in example],
                {'role': 'user', 'content': task['request']}]
    events = [{'kind': 'operator', 'text': task['request']}]
    replies = list(task.get('replies') or [])
    model = model_loader()
    turns = 0
    confirmed = False   # the operator's last message said yes to the assistant's question
    while True:
        if turns >= flags['max_turns']:
            events.append({'kind': 'stopped', 'text': f"max_turns ({flags['max_turns']}) reached without an answer"})
            break
        turns += 1
        out = model.complete(chatml(messages), grammar)
        turn = {'kind': 'assistant', 'turn': turns, **parse_turn(out['text'], prompt['thought']), 'raw': out['text'],
                'tokens_in': out['tokens_in'], 'tokens_out': out['tokens_out'], 'seconds': out['seconds']}
        events.append(turn)
        messages.append({'role': 'assistant', 'content': out['text']})
        if 'error' in turn:
            messages.append({'role': 'tool', 'content': json.dumps({'error': 'your output was cut: answer shorter'})})
            continue
        if 'tool' in turn:
            start = time.perf_counter()
            result = tools.call(fleet, turn['tool'], turn['arguments'], flags['require_confirmation'], confirmed)
            events.append({'kind': 'tool', 'tool': turn['tool'], 'result': result.get('result'), 'error': result.get('error'),
                           'executed': bool(result.get('executed')), 'seconds': time.perf_counter() - start})
            messages.append({'role': 'tool', 'content': json.dumps(result['result'] if 'result' in result else {'error': result['error']})})
            continue
        if not replies:
            break
        reply = replies.pop(0)
        reply = reply if isinstance(reply, dict) else {'text': reply}
        confirmed = bool(reply.get('confirms')) and '?' in turn['answer']
        events.append({'kind': 'operator', 'text': reply['text'], 'confirms': bool(reply.get('confirms'))})
        messages.append({'role': 'user', 'content': reply['text']})
    return {'events': events, 'messages': messages, 'fleet_after': fleet}


def memo_key(model: dict, task: dict, fleet: dict, flags: dict, prompt: dict) -> str:
    """Everything a conversation depends on"""
    relevant = {k: flags[k] for k in ('model', 'max_turns', 'tool_descriptions', 'require_confirmation')}
    data = {
        'model': model['sha256'], 'llama_cpp': llama_cpp_version(), 'threads': THREADS, 'seed': SEED,
        'context': CONTEXT, 'max_tokens': MAX_TOKENS, 'prompt': prompt['text'], 'thought': prompt['thought'],
        'examples': prompt['examples'],
        'flags': relevant, 'task': {k: task.get(k) for k in ('request', 'replies')}, 'fleet': fleet,
        'code': [hashlib.sha256(p.read_bytes()).hexdigest() for p in CODE],
    }
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def run(model: dict, task: dict, fleet: dict, flags: dict, prompt: dict, log=print) -> dict:
    """The conversation, from the cache when it was already computed"""
    key = memo_key(model, task, fleet, flags, prompt)
    path = cache_dir() / 'runs' / key[:2] / f'{key}.json'
    if path.exists() and not os.environ.get('FLEET_ASSISTANT_NO_CACHE'):
        log(f'Same model, prompt, tools, flags and task as an earlier run: reusing its conversation ({key[:12]})')
        return {**json.loads(path.read_text()), 'memoized': True}
    loaded = {}

    def loader():
        if 'model' not in loaded:
            start = time.perf_counter()
            loaded['model'] = Model(model['path'])
            loaded['load_seconds'] = time.perf_counter() - start
        return loaded['model']

    result = converse(loader, task, fleet, flags, prompt)
    result = {'key': key, 'events': result['events'], 'load_seconds': loaded.get('load_seconds')}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(result, indent=1))
    tmp.replace(path)
    return {**result, 'memoized': False}
