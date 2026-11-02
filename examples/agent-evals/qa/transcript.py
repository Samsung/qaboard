"""
transcript.txt: the conversation as text, one block per message, for QA-Board's text viewer (which diffs it against
the reference run's). No times or token counts: a diff shows what the assistant did differently, nothing else.
"""
import json


def args(arguments: dict) -> str:
    return ', '.join(f'{k}={json.dumps(v)}' for k, v in arguments.items())


def text(events: list) -> str:
    blocks = []
    for e in events:
        if e['kind'] == 'operator':
            blocks.append(f"[operator]\n{e['text']}")
        elif e['kind'] == 'assistant':
            lines = [f"[assistant, turn {e['turn']}]"]
            if e.get('thought'):
                lines.append(f"(thinking) {e['thought']}")
            if 'tool' in e:
                lines.append(f"-> {e['tool']}({args(e['arguments'])})")
            elif 'answer' in e:
                lines.append(e['answer'])
            else:
                lines.append(f"(error) {e.get('error')}: {e.get('raw', '')}")
            blocks.append('\n'.join(lines))
        elif e['kind'] == 'tool':
            body = f"error: {e['error']}" if e.get('error') else json.dumps(e['result'], ensure_ascii=False)
            blocks.append(f"[{e['tool']}]\n{body}")
        elif e['kind'] == 'stopped':
            blocks.append(f"[stopped]\n{e['text']}")
    return '\n\n'.join(blocks) + '\n'
