#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "beautifulsoup4>=4.12",
#   "httpx>=0.27",
# ]
# ///
"""
The docs' Algolia search index (DocSearch), built from the website's build and replaced by CI on every deploy.

Algolia's crawler used to fill it, and stopped. Now the Website workflow (.github/workflows/website.yml) runs:

    uv run website/search/algolia_index.py records website/build --out search-records.json   # every build: checks the pages
    uv run website/search/algolia_index.py push search-records.json                          # after deploying from master

`push` needs ALGOLIA_WRITE_API_KEY, an Algolia API key restricted to the samsung_qaboard* indices (ACLs: search,
addObject, deleteObject, deleteIndex, editSettings, settings). It fills a temporary index, then moves it over the
real one: searches never see a half-filled index. The app id and the index name are the ones of docusaurus.config.ts
(themeConfig.algolia), overridable with ALGOLIA_APP_ID and ALGOLIA_INDEX_NAME.

The records have the format the DocSearch modal reads (hierarchy.lvl0-6, content, type, url) and the facets
Docusaurus' contextual search filters on (language, docusaurus_tag, from each page's docsearch:* meta tags).
hierarchy.lvl0, the groups in the search results, is the docs section of the page (src/components/DocsSwitcher).
"""
import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

from bs4 import BeautifulSoup, Tag

APP_ID = os.environ.get('ALGOLIA_APP_ID', 'Q9000IO3JM')
INDEX_NAME = os.environ.get('ALGOLIA_INDEX_NAME', 'samsung_qaboard')

# Each must have pages, or the build changed in a way the extraction missed
EXPECTED_SECTIONS = ['Get started', 'User guide', 'Project integration', 'Admin', 'Release notes', 'Blog']
# Fewer pages than this and `push` refuses to replace the index: something is wrong with the build
MIN_PAGES = 100
# Algolia's limit is 10 KB per record on the smaller plans
MAX_CONTENT_CHARS = 3000

LEVEL_WEIGHT = {'lvl1': 100, 'lvl2': 90, 'lvl3': 80, 'lvl4': 70, 'lvl5': 60, 'lvl6': 50, 'content': 0}
# The docs before the release notes and the blog, when they match as well
PAGE_RANK = {'docs': 1}

# From DocSearch's Docusaurus template, which the DocSearch modal and Docusaurus' search bar expect
SETTINGS = {
  'attributesForFaceting': ['type', 'lang', 'language', 'version', 'docusaurus_tag'],
  'attributesToRetrieve': ['hierarchy', 'content', 'anchor', 'url', 'url_without_anchor', 'type'],
  'attributesToHighlight': ['hierarchy', 'content'],
  'attributesToSnippet': ['content:10'],
  'camelCaseAttributes': ['hierarchy', 'content'],
  'searchableAttributes': [
    'unordered(hierarchy.lvl0)',
    'unordered(hierarchy.lvl1)',
    'unordered(hierarchy.lvl2)',
    'unordered(hierarchy.lvl3)',
    'unordered(hierarchy.lvl4)',
    'unordered(hierarchy.lvl5)',
    'unordered(hierarchy.lvl6)',
    'content',
  ],
  'distinct': True,
  'attributeForDistinct': 'url',
  'customRanking': ['desc(weight.pageRank)', 'desc(weight.level)', 'asc(weight.position)'],
  'ranking': ['words', 'filters', 'typo', 'attribute', 'proximity', 'exact', 'custom'],
  'highlightPreTag': '<span class="algolia-docsearch-suggestion--highlight">',
  'highlightPostTag': '</span>',
  'minWordSizefor1Typo': 3,
  'minWordSizefor2Typos': 7,
  'allowTyposOnNumericTokens': False,
  'minProximity': 1,
  'ignorePlurals': True,
  'advancedSyntax': True,
  'attributeCriteriaComputedByMinProximity': True,
  'removeWordsIfNoResults': 'allOptional',
  'separatorsToIndex': '_',
}

HEADINGS = {'h2': 2, 'h3': 3, 'h4': 4, 'h5': 5, 'h6': 6}
# Blocks whose text is a record. A list item's nested lists and paragraphs are records of their own
BLOCKS = {'p', 'li', 'tr', 'summary', 'dt', 'dd'}
NESTED_BLOCKS = {'p', 'ul', 'ol', 'pre', 'table', 'div', 'figure', 'details', 'blockquote'}
# Never indexed: code blocks, the headings' "#" links, tab labels, placeholders and other decorations. Mark more
# with data-nosearch="true"
SKIPPED = 'pre, .hash-link, [aria-hidden="true"], [role="tab"], [data-nosearch], nav, button, script, style, svg'


def clean(text: str) -> str:
  return re.sub(r'\s+', ' ', text.replace('​', '')).strip()


def own_text(element: Tag) -> str:
  """The element's text, without the text of the blocks it contains (indexed separately)."""
  if element.name == 'tr':
    return ' · '.join(filter(None, (clean(cell.get_text()) for cell in element.find_all('td', recursive=False))))
  parts = []
  for string in element.find_all(string=True):
    parent = string.parent
    while parent is not None and parent is not element:
      if parent.name in NESTED_BLOCKS or parent.name in BLOCKS:
        break
      parent = parent.parent
    else:
      parts.append(str(string))
  return clean(''.join(parts))


def section(soup: BeautifulSoup, path: str) -> str:
  active = soup.select_one('nav[aria-label="Docs sections"] a[aria-current]')
  if active and active.get('data-section'):
    return active['data-section']
  if path.startswith('/qaboard/release-notes/'):
    return 'Release notes'
  if path.startswith('/qaboard/blog/'):
    return 'Blog'
  return 'Docs'


def page_records(html: str) -> list[dict]:
  soup = BeautifulSoup(html, 'html.parser')
  meta = {m['name'].removeprefix('docsearch:'): m.get('content', '') for m in soup.select('meta[name^="docsearch:"]')}
  tag = meta.get('docusaurus_tag', '')
  # Pages, not the lists of posts or tags that repeat them
  if not (tag == 'default' or tag.startswith('docs-')):
    return []
  robots = soup.select_one('meta[name="robots"]')
  if robots and 'noindex' in robots.get('content', ''):
    return []
  canonical = soup.select_one('link[rel="canonical"]')
  article = soup.select_one('article')
  body = article.select_one('.markdown') if article else None
  title = article.select_one('h1') if article else None
  if not (canonical and body and title):
    return []  # e.g. the landing page: no article
  page_url = canonical['href']
  kind = 'docs' if tag.startswith('docs-') else 'blog'

  for skipped in body.select(SKIPPED):
    skipped.decompose()
  for skipped in title.select(SKIPPED):
    skipped.decompose()

  hierarchy: dict[str, str | None] = {f'lvl{i}': None for i in range(7)}
  hierarchy['lvl0'] = section(soup, urlsplit(page_url).path)
  hierarchy['lvl1'] = clean(title.get_text())
  anchor = None
  records = []

  def add(type_: str, content: str | None):
    url = f'{page_url}#{anchor}' if anchor else page_url
    records.append({
      'objectID': f'{page_url}#{len(records)}',
      'url': url,
      'url_without_anchor': page_url,
      'anchor': anchor,
      'type': type_,
      'content': content[:MAX_CONTENT_CHARS] if content else None,
      'hierarchy': dict(hierarchy),
      'weight': {'pageRank': PAGE_RANK.get(kind, 0), 'level': LEVEL_WEIGHT[type_], 'position': len(records)},
      'lang': meta.get('language', 'en'),
      'language': meta.get('language', 'en'),
      'docusaurus_tag': tag,
      **({'version': meta['version']} if 'version' in meta else {}),
    })

  add('lvl1', None)
  for element in body.find_all([*HEADINGS, *BLOCKS]):
    if element.name in HEADINGS:
      level = HEADINGS[element.name]
      text = clean(element.get_text())
      if not text:
        continue
      hierarchy[f'lvl{level}'] = text
      for deeper in range(level + 1, 7):
        hierarchy[f'lvl{deeper}'] = None
      anchor = element.get('id') or anchor
      add(f'lvl{level}', None)
    elif element.name == 'tr' and element.find('th'):
      continue  # table headers
    else:
      text = own_text(element)
      if text:
        add('content', text)
  return records


def build_records(build_dir: Path) -> list[dict]:
  records = []
  for path in sorted(build_dir.rglob('*.html')):
    records.extend(page_records(path.read_text(encoding='utf-8')))
  return records


def check(records: list[dict]) -> list[str]:
  pages = {r['url_without_anchor']: r['hierarchy']['lvl0'] for r in records}
  per_section = Counter(pages.values())
  errors = []
  if len(pages) < MIN_PAGES:
    errors.append(f'{len(pages)} pages, expected at least {MIN_PAGES}')
  for name in EXPECTED_SECTIONS:
    if not per_section[name]:
      errors.append(f'no page in the "{name}" section: did the HTML of the pages change? (see section())')
  too_big = [r['objectID'] for r in records if len(json.dumps(r).encode()) > 10_000]
  if too_big:
    errors.append(f'records over 10 KB: {too_big[:5]}')
  return errors


def cmd_records(args):
  records = build_records(args.build_dir)
  pages = {r['url_without_anchor']: r['hierarchy']['lvl0'] for r in records}
  print(f'{len(records)} records, {len(pages)} pages:', ', '.join(f'{n} {s}' for s, n in Counter(pages.values()).most_common()))
  errors = check(records)
  for error in errors:
    print(f'ERROR: {error}', file=sys.stderr)
  if args.out:
    args.out.write_text(json.dumps(records, ensure_ascii=False))
  sys.exit(1 if errors else 0)


class Algolia:
  def __init__(self, app_id: str, api_key: str, transport=None):
    import httpx
    self.hosts = [f'https://{app_id}.algolia.net', *(f'https://{app_id}-{i}.algolianet.com' for i in (1, 2, 3))]
    self.client = httpx.Client(
      headers={'X-Algolia-Application-Id': app_id, 'X-Algolia-API-Key': api_key},
      timeout=30,
      transport=transport,
    )

  def request(self, method: str, path: str, body=None, ok=(200, 201)):
    import httpx
    error = None
    for host in self.hosts:
      try:
        response = self.client.request(method, host + path, json=body)
      except httpx.TransportError as e:
        error = e
        continue
      if response.status_code >= 500:
        error = f'{response.status_code} {response.text}'
        continue
      if response.status_code not in ok:
        raise SystemExit(f'Algolia: {method} {path}: {response.status_code} {response.text}')
      return response.json()
    raise SystemExit(f'Algolia: {method} {path}: {error}')

  def wait(self, index: str, task_id: int, timeout=600):
    deadline = time.monotonic() + timeout
    while self.request('GET', f'/1/indexes/{index}/task/{task_id}')['status'] != 'published':
      if time.monotonic() > deadline:
        raise SystemExit(f'Algolia: task {task_id} on {index} still not done after {timeout}s')
      time.sleep(1)


def cmd_push(args):
  api_key = os.environ.get('ALGOLIA_WRITE_API_KEY')
  if not api_key:
    raise SystemExit('ALGOLIA_WRITE_API_KEY is not set')
  records = json.loads(args.records.read_text())
  errors = check(records)
  if errors:
    raise SystemExit('Not replacing the index: ' + '; '.join(errors))

  algolia = Algolia(APP_ID, api_key)
  tmp = f'{INDEX_NAME}_tmp'
  # A previous run may have left it half-filled
  deleted = algolia.request('DELETE', f'/1/indexes/{tmp}', ok=(200, 404))
  if 'taskID' in deleted:
    algolia.wait(tmp, deleted['taskID'])
  tasks = [algolia.request('PUT', f'/1/indexes/{tmp}/settings', SETTINGS)['taskID']]
  for start in range(0, len(records), 1000):
    batch = [{'action': 'addObject', 'body': r} for r in records[start:start + 1000]]
    tasks.append(algolia.request('POST', f'/1/indexes/{tmp}/batch', {'requests': batch})['taskID'])
  for task_id in tasks:
    algolia.wait(tmp, task_id)
  moved = algolia.request('POST', f'/1/indexes/{tmp}/operation', {'operation': 'move', 'destination': INDEX_NAME})
  algolia.wait(tmp, moved['taskID'])
  print(f'{INDEX_NAME}: {len(records)} records on {APP_ID}')


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  commands = parser.add_subparsers(required=True)
  records = commands.add_parser('records', help="Extract the search records from the build, and check them")
  records.add_argument('build_dir', type=Path)
  records.add_argument('--out', type=Path)
  records.set_defaults(func=cmd_records)
  push = commands.add_parser('push', help='Replace the Algolia index with these records')
  push.add_argument('records', type=Path)
  push.set_defaults(func=cmd_push)
  args = parser.parse_args()
  args.func(args)


if __name__ == '__main__':
  main()
