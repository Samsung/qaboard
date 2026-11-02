"""
How different runs' configurations are, to find a run's closest reference run.

It's a port of the web app's `config_distance` (webapp/src/configurations/tokens.js), so that `qa check-bit-accuracy
--reference-match closest` and the server's comparisons (backend/backend/compare.py) pick the reference run the
web app shows. Both are tested against the same cases, tests/fixtures/config-distance.json: change one, change the other.

A configuration is a list of items: strings ("base", "conf/night.yaml") or objects ({"gain": 4, "isp": {"awb": "auto"}}).
Each string is a setting, and so is each leaf of an object, keyed by its path ("isp.awb").
"""
import json
import math
import re
from decimal import Decimal
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


# ---------------------------------------------------------------------------- JavaScript's JSON

def _is_number(value) -> bool:
  return isinstance(value, (int, float)) and not isinstance(value, bool)

def js_number(value) -> str:
  """String(number) in JavaScript (Number::toString in ECMAScript): 1.0 is "1", 1.5e-05 is "0.000015", 1e21 is "1e+21" """
  if isinstance(value, int) and abs(value) < 1e21:
    return str(value)
  value = float(value)
  if math.isnan(value) or math.isinf(value):
    return 'null' # like JSON.stringify
  if value == 0:
    return '0'
  # the shortest digits that round-trip, like JavaScript's: value = 0.digits * 10**n
  sign, digits_tuple, exponent = Decimal(repr(abs(value))).normalize().as_tuple()
  digits = ''.join(map(str, digits_tuple))
  k, n = len(digits), len(digits_tuple) + int(exponent)
  if k <= n <= 21:
    text = digits + '0' * (n - k)
  elif 0 < n <= 21:
    text = f'{digits[:n]}.{digits[n:]}'
  elif -6 < n <= 0:
    text = f"0.{'0' * -n}{digits}"
  else:
    text = f"{digits[0]}{'.' + digits[1:] if k > 1 else ''}e{'+' if n - 1 > 0 else '-'}{abs(n - 1)}"
  return f'-{text}' if value < 0 else text

def js_keys(value: Dict) -> List:
  """The order of Object.keys(): integer-like keys first, in ascending order, then the others in insertion order"""
  integer_like = sorted((k for k in value if re.fullmatch(r'0|[1-9][0-9]*', str(k))), key=int)
  return [*integer_like, *(k for k in value if k not in integer_like)]

def js_stringify(value) -> str:
  """JSON.stringify(): no spaces, JavaScript's numbers and key order"""
  if isinstance(value, dict):
    return '{' + ','.join(f'{json.dumps(str(k), ensure_ascii=False)}:{js_stringify(value[k])}' for k in js_keys(value)) + '}'
  if isinstance(value, (list, tuple)):
    return '[' + ','.join(js_stringify(v) for v in value) + ']'
  if _is_number(value):
    return js_number(value)
  return json.dumps(value, ensure_ascii=False)


# ---------------------------------------------------------------------------- settings

# Some configuration keys are used and shown by viewers: they're not settings
HIDDEN_KEYS = ("badges", "roi", "auto_rois")

@dataclass(frozen=True)
class Token:
  kind: str   # 'string' or 'param'
  id: str     # identifies the setting: the string, or the key of the parameter
  full: str   # identifies the setting and its value
  text: str   # the value, as JSON
  value: Any = None

def _string_token(text: str) -> Token:
  return Token('string', f's\0{text}', f's\0{text}', text)

def _param_token(key: str, value) -> Token:
  text = js_stringify(value)
  return Token('param', f'p\0{key}', f'p\0{key}\0{text}', text, value)

def _visit(value, path: str, tokens: List[Token]):
  # Lists of objects have a setting per leaf ("layers[0].type"), lists of values are one setting
  if isinstance(value, dict) and value:
    for key in js_keys(value):
      if not path and key in HIDDEN_KEYS:
        continue
      _visit(value[key], f'{path}.{key}' if path else str(key), tokens)
  elif isinstance(value, list) and any(isinstance(v, dict) and v for v in value):
    for i, v in enumerate(value):
      _visit(v, f'{path}[{i}]', tokens)
  else:
    tokens.append(_param_token(path, value))

def config_tokens(configurations) -> List[Token]:
  """The settings of a configuration: a list of items, or a single object"""
  if configurations is None:
    return []
  if not isinstance(configurations, list):
    configurations = [configurations]
  tokens: List[Token] = []
  for c in configurations:
    if isinstance(c, dict):
      if c:
        _visit(c, '', tokens)
    else:
      tokens.append(_string_token(c if isinstance(c, str) else js_stringify(c)))
  return tokens


# ---------------------------------------------------------------------------- distances

STRING_SEPARATOR = re.compile(r'''[\s/\\.,:;=_\-@|+()\[\]{}"']''')

def _at(s: str, i: int) -> Optional[str]:
  return s[i] if 0 <= i < len(s) else None

def string_change(before: str, after: str, separator=STRING_SEPARATOR) -> Dict[str, str]:
  """Where two strings differ, cut at separators: "conf/day.yaml" and "conf/night.yaml" => "conf/", "day", "night", ".yaml" """
  p = 0
  while p < len(before) and p < len(after) and before[p] == after[p]:
    p += 1
  s = 0
  while s < len(before) - p and s < len(after) - p and before[len(before) - 1 - s] == after[len(after) - 1 - s]:
    s += 1
  def in_word(left, right):
    return left is not None and right is not None and not separator.match(left) and not separator.match(right)
  while p > 0 and (in_word(_at(before, p - 1), _at(before, p)) or in_word(_at(after, p - 1), _at(after, p))):
    p -= 1
  b, a = len(before), len(after)
  while s > 0 and (in_word(_at(before, b - s - 1), _at(before, b - s)) or in_word(_at(after, a - s - 1), _at(after, a - s))):
    s -= 1
  return {'prefix': before[:p], 'before': before[p:b - s], 'after': after[p:a - s], 'suffix': before[b - s:]}

def string_distance(a: str, b: str) -> float:
  """How different two strings are, from 0 (equal) to 1"""
  if a == b:
    return 0
  n, m = len(a), len(b)
  if n == 0 or m == 0:
    return 1
  if n * m > 100_000:
    change = string_change(a, b)
    return 1 - (len(change['prefix']) + len(change['suffix'])) / max(n, m)
  row = list(range(m + 1))
  for i in range(1, n + 1):
    next_row = [i]
    for j in range(1, m + 1):
      next_row.append(min(row[j] + 1, next_row[j - 1] + 1, row[j - 1] + (0 if a[i - 1] == b[j - 1] else 1)))
    row = next_row
  return row[m] / max(n, m)

def _value_distance(a: Token, b: Token) -> float:
  """How different two values of a setting are, from 0 to 1: 3 is closer to 4 than to 100"""
  if _is_number(a.value) and _is_number(b.value):
    total = abs(a.value) + abs(b.value)
    return abs(a.value - b.value) / total if total else 0
  return string_distance(a.text, b.text)

def _only_in(tokens: Sequence[Token], other: Sequence[Token]) -> List[Token]:
  """The settings of `tokens` that `other` doesn't have (as a multiset)"""
  left: Dict[str, int] = {}
  for t in other:
    left[t.full] = left.get(t.full, 0) + 1
  out = []
  for t in tokens:
    if left.get(t.full, 0) > 0:
      left[t.full] -= 1
    else:
      out.append(t)
  return out

def tokens_distance(a: Sequence[Token], b: Sequence[Token]) -> float:
  """
  How different two lists of settings are:
  - the integer part is the number of settings added, removed or changed. A changed value, or a string replaced by
    another, counts as one.
  - the fractional part breaks ties: how different the changed values are.
  """
  only_a, only_b = _only_in(a, b), _only_in(b, a)
  # the same settings, maybe in another order
  if not only_a and not only_b:
    return 0.5 if any(t.full != (b[i].full if i < len(b) else None) for i, t in enumerate(a)) else 0

  pair_distances: List[float] = []
  # changed values
  params_b = {t.id: t for t in only_b if t.kind == 'param'}
  keys_a = {t.id for t in only_a if t.kind == 'param'}
  changed = 0
  for t in only_a:
    other = params_b.get(t.id) if t.kind == 'param' else None
    if not other:
      continue
    changed += 1
    pair_distances.append(_value_distance(t, other))
    del params_b[t.id]
  # strings replaced by the most similar ones
  strings_a = [t.text for t in only_a if t.kind == 'string']
  strings_b = [t.text for t in only_b if t.kind == 'string']
  fewer, more = (strings_a, strings_b) if len(strings_a) <= len(strings_b) else (strings_b, strings_a)
  left = list(more)
  for s in fewer:
    best = 0
    for k, o in enumerate(left):
      if string_distance(s, o) < string_distance(s, left[best]):
        best = k
    pair_distances.append(string_distance(s, left[best]))
    left.pop(best)
  keys_b = {t.id for t in only_b if t.kind == 'param'}
  settings = len(more) + len(keys_a) + len(keys_b) - changed
  tie = sum(pair_distances) / len(pair_distances) if pair_distances else 1
  return settings + 0.9 * min(tie, 1)

def config_distance(configurations_a, configurations_b) -> float:
  """How different two configurations (or tuning parameters) are"""
  return tokens_distance(config_tokens(configurations_a), config_tokens(configurations_b))


# ---------------------------------------------------------------------------- runs

def run_distance(run: Dict, reference: Dict) -> Tuple[float, float, int]:
  """
  How different a reference run is from a run, to sort them like the web app (`matching_output` in webapp/src/utils.js):
  first by configurations, then by tuning parameters, then same platform first.
  Runs are dicts with `configurations`, `extra_parameters` and `platform`.
  """
  return (
    config_distance(reference.get('configurations'), run.get('configurations')),
    config_distance(reference.get('extra_parameters'), run.get('extra_parameters')),
    0 if reference.get('platform') == run.get('platform') else 1,
  )

def closest(run: Dict, references: Iterable[Dict]) -> List[Dict]:
  """The references sorted from the closest to the run, ties in their order"""
  return sorted(references, key=lambda reference: run_distance(run, reference))
