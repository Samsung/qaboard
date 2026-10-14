"""
Search commits "by anything", in the spirit of the web application's filter boxes (match_query in webapp/src/utils.js):

  speed -wip branch:feature committer:alice "two words" id:3fa2

- Terms are ANDed, and `-term` excludes.
- Free text matches the commit id (prefix), message, committer, branch or a batch label, case-insensitively.
- Qualifiers only look at one field: branch:, committer: (or author:), batch: (or label:), message: (or msg:), id: (or commit:).
- Use double quotes for text with spaces: message:"fix crash".

We only build SQL with bound parameters, and escape LIKE wildcards: users search for text, not patterns.
"""
import re
from collections import namedtuple


Term = namedtuple('Term', ['field', 'value', 'negated'])

# qualifier => field
qualifiers = {
  'branch': 'branch',
  'committer': 'committer',
  'author': 'committer',
  'batch': 'batch',
  'label': 'batch',
  'message': 'message',
  'msg': 'message',
  'id': 'id',
  'commit': 'id',
  'sha': 'id',
}
# keeps the SQL small whatever users paste in the search box
max_terms = 20
max_term_length = 200

token_pattern = re.compile(r'(?P<negated>-)?(?:(?P<qualifier>[A-Za-z]+):)?(?:"(?P<quoted>[^"]*)"?|(?P<word>\S+))')
# commit ids users copy are at least this long. Shorter words ("add", "bad"...) are not looked up as ids
min_free_text_id_length = 4
hex_pattern = re.compile(r'[0-9a-fA-F]+')


def parse_query(query):
  """'fix -wip branch:dev' => [Term('text', 'fix', False), Term('text', 'wip', True), Term('branch', 'dev', False)]"""
  terms = []
  for match in token_pattern.finditer(query or ''):
    negated = bool(match['negated'])
    qualifier = match['qualifier'].lower() if match['qualifier'] else None
    value = match['quoted'] if match['quoted'] is not None else match['word']
    if qualifier and qualifier not in qualifiers:
      # e.g. "fix:" in a commit message, or a URL: we look for the text as typed
      value = f"{match['qualifier']}:{value}"
      qualifier = None
    if value is None or not value.strip() or value == '-' or (not qualifier and value[:-1].lower() in qualifiers and value.endswith(':')):
      continue # e.g. "branch:" while users are typing
    terms.append(Term(qualifiers[qualifier] if qualifier else 'text', value.strip()[:max_term_length], negated))
    if len(terms) == max_terms:
      break
  return terms


def escape_like(value, escape='\\'):
  """So that % and _ match themselves in LIKE patterns"""
  return value.replace(escape, escape * 2).replace('%', f'{escape}%').replace('_', f'{escape}_')


def commits_search_filter(terms):
  """A SQLAlchemy filter on CiCommit that matches all the terms"""
  from sqlalchemy import and_, or_, not_, func
  from .models import CiCommit, Batch

  def contains(column, value):
    # coalesce: NULLs would make "NOT (...)" unknown, and hide commits
    return func.coalesce(column, '').ilike(f'%{escape_like(value)}%', escape='\\')

  def starts_with(column, value):
    return func.coalesce(column, '').ilike(f'{escape_like(value)}%', escape='\\')

  def matches(term):
    if term.field == 'branch':
      return contains(CiCommit.branch, term.value)
    if term.field == 'committer':
      return contains(CiCommit.committer_name, term.value)
    if term.field == 'message':
      return contains(CiCommit.message, term.value)
    if term.field == 'batch':
      return CiCommit.batches.any(contains(Batch.label, term.value))
    if term.field == 'id':
      return starts_with(CiCommit.hexsha, term.value)
    anywhere = [
      contains(CiCommit.message, term.value),
      contains(CiCommit.committer_name, term.value),
      contains(CiCommit.branch, term.value),
      CiCommit.batches.any(contains(Batch.label, term.value)),
    ]
    if len(term.value) >= min_free_text_id_length and hex_pattern.fullmatch(term.value):
      anywhere.append(starts_with(CiCommit.hexsha, term.value))
    return or_(*anywhere)

  return and_(*[not_(matches(t)) if t.negated else matches(t) for t in terms])
