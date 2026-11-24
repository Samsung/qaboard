"""
The rules of inputs and collections, without the database (backend/input_collections.py): names, references, the
projects a reference looks in, what clients send, and what we answer.
"""
import datetime

import pytest
import yaml

from backend.input_collections import (
  CollectionError, normalize_name, clean_text, clean_input_ids, clean_version, clean_project, clean_group_id, parse_ref, Ref,
  lookup_projects, is_visible_from, ref_of, like_escape, search_tokens, normalize_folder, clean_page, clean_sort, flag,
  thumbnail_size, iso, input_file, serialize_input, serialize_collection, serialize_version, batch_name, export_yaml,
  stale_error, MAX_INPUTS, MAX_LIMIT,
)


def error_of(function, *args):
  with pytest.raises(CollectionError) as e:
    function(*args)
  return e.value


class TestNames:
  def test_normalized_like_milestone_groups(self):
    assert normalize_name(" night / hard ") == "night/hard"
    assert normalize_name("/night//hard-cases/") == "night/hard-cases"
    assert normalize_name("a  b/c") == "a b/c"
    assert normalize_name("v1.2_final") == "v1.2_final"

  def test_invalid(self):
    for name in ("", "  ", "/", "a/../b", "a/./b", "night:hard", "night@2", "é", "a\\b", "a\nb", "<b>"):
      assert error_of(normalize_name, name).reason == 'invalid_name', name
    assert error_of(normalize_name, None).status == 400
    assert error_of(normalize_name, 3).reason == 'invalid_name'

  def test_length(self):
    assert normalize_name("a" * 200) == "a" * 200
    assert "too long" in str(error_of(normalize_name, "a" * 201))
    # after normalization
    assert normalize_name(" " + "a" * 200 + " /") == "a" * 200


class TestBodies:
  def test_texts(self):
    assert clean_text(None, 10, 'notes') == ''
    assert clean_text("  hi\x00 ", 10, 'notes') == 'hi'
    assert error_of(clean_text, 3, 10, 'notes').status == 400
    assert error_of(clean_text, "x" * 11, 10, 'notes').status == 413

  def test_input_ids_keep_their_order_without_duplicates(self):
    assert clean_input_ids([3, 1, 3, 2, 1]) == [3, 1, 2]
    assert clean_input_ids([]) == []

  def test_invalid_input_ids(self):
    for bad in (None, "1,2", {"1": 1}, [1, "2"], [True], [0], [-1], [1.5], [2**31]):
      assert error_of(clean_input_ids, bad).status == 400, bad

  def test_at_most_50000_inputs(self):
    assert len(clean_input_ids(list(range(1, MAX_INPUTS + 1)))) == MAX_INPUTS
    e = error_of(clean_input_ids, list(range(1, MAX_INPUTS + 2)))
    assert (e.status, e.reason) == (413, 'too_many_inputs')

  def test_versions(self):
    assert clean_version(None) is None and clean_version('') is None and clean_version('latest') is None
    assert clean_version('3') == 3 and clean_version(3) == 3
    for bad in ('0', '-1', 'v2', 2.5j, True, '1e3'):
      with pytest.raises(CollectionError):
        clean_version(bad)

  def test_projects(self):
    assert clean_project('a/b/') == 'a/b'
    for bad in (None, '', '/', 'a/../b', 'a//b', 3):
      assert error_of(clean_project, bad).reason == 'invalid_project', bad

  def test_groups(self):
    assert clean_group_id(None) is None and clean_group_id('') is None and clean_group_id('null') is None
    assert clean_group_id(12) == 12 and clean_group_id('12') == 12
    for bad in (True, 0, -3, 'x', 1.5, [1]):
      with pytest.raises(CollectionError):
        clean_group_id(bad)


class TestRefs:
  def test_names_and_versions(self):
    assert parse_ref("night/hard") == Ref("night/hard", None, None)
    assert parse_ref(" night / hard@2 ") == Ref("night/hard", 2, None)
    assert parse_ref("night/hard@latest") == Ref("night/hard", None, None)

  def test_explicit_project(self):
    assert parse_ref("a/b:night/hard@2") == Ref("night/hard", 2, "a/b")
    assert parse_ref("a/b/:night/hard") == Ref("night/hard", None, "a/b")

  def test_invalid(self):
    for bad in (None, "", "  ", "@2", "night@", "night@two", "night@0", ":night", "a/../b:night", "a:b:c", "night/hard@2@3"):
      assert error_of(parse_ref, bad).reason in ('invalid_ref', 'invalid_name'), bad

  def test_lookup_looks_in_the_project_then_its_ancestors(self):
    assert lookup_projects("a/b/c", parse_ref("night")) == ["a/b/c", "a/b", "a"]
    assert lookup_projects("a/b/c", parse_ref("x/y:night")) == ["x/y"]
    assert lookup_projects("a", parse_ref("night")) == ["a"]

  def test_visible_from_the_project_and_subprojects(self):
    assert is_visible_from("a", "a") and is_visible_from("a", "a/b") and is_visible_from("a/b", "a/b/c")
    assert not is_visible_from("a/b", "a") and not is_visible_from("a", "ab") and not is_visible_from("a/b", "a/bc")
    assert not is_visible_from("", "a")

  def test_ref_of(self):
    assert ref_of("night", "a", "a") == "night"
    assert ref_of("night", "a", "a/b") == "a:night"
    assert ref_of("night", "a", None, 3) == "night@3"
    assert ref_of("night", "a", "a/b", 3) == "a:night@3"


class TestSearchesAndPages:
  def test_like_escape(self):
    assert like_escape("a_b%c\\d") == "a\\_b\\%c\\\\d"

  def test_tokens(self):
    assert search_tokens(" night  street ") == ["night", "street"]
    assert search_tokens(None) == [] and search_tokens(3) == []
    assert len(search_tokens(" ".join(["w"] * 50))) == 10
    assert search_tokens("x" * 1000) == ["x" * 500]

  def test_folders(self):
    assert normalize_folder(" /a//b/ ") == "a/b"
    assert normalize_folder(None) == "" and normalize_folder("/") == ""

  def test_pages(self):
    assert clean_page(None, None) == (100, 0)
    assert clean_page('20', '40') == (20, 40)
    assert clean_page('0', '-5') == (1, 0)
    assert clean_page(str(MAX_LIMIT + 1), '0') == (MAX_LIMIT, 0)
    with pytest.raises(CollectionError):
      clean_page('ten', None)

  def test_sort_and_flags(self):
    assert clean_sort(None) == 'last_run' and clean_sort('path') == 'path'
    with pytest.raises(CollectionError):
      clean_sort('id; DROP TABLE')
    assert flag(None, True) and not flag('0', True) and flag('1', False) and flag('true', False) and not flag('no', True)

  def test_thumbnail_sizes(self):
    assert thumbnail_size(None) == 256 and thumbnail_size('x') == 256
    assert thumbnail_size('100') == 128 and thumbnail_size('256') == 256 and thumbnail_size('1') == 64
    assert thumbnail_size('99999') == 1024


DATE = datetime.datetime(2026, 11, 20, 10, 30)


class TestAnswers:
  def test_iso(self):
    assert iso(None) is None and iso(DATE) == "2026-11-20T10:30:00Z"
    assert iso(datetime.datetime(2026, 11, 20, 12, 30, tzinfo=datetime.timezone(datetime.timedelta(hours=2)))) == "2026-11-20T10:30:00Z"

  def test_input_file(self):
    assert input_file("/data/", "night/a.raw") == "/data/night/a.raw"
    assert input_file("/data", "/night/a.raw") == "/data/night/a.raw"
    assert input_file("data", "a.raw") is None
    assert input_file("C:\\data", "a.raw") is None

  def test_input(self):
    row = {'id': 7, 'database': '/data', 'path': 'night/street a.png', 'data': None, 'runs': 3, 'first_run_at': DATE, 'last_run_at': DATE}
    assert serialize_input(row) == {
      'id': 7, 'database': '/data', 'path': 'night/street a.png', 'name': 'street a.png', 'folder': 'night', 'data': {},
      'runs': 3, 'first_run_at': "2026-11-20T10:30:00Z", 'last_run_at': "2026-11-20T10:30:00Z",
      'thumbnail_url': "/api/v1/inputs/7/thumbnail", 'url': "/s/data/night/street%20a.png",
    }
    flat = serialize_input({'id': 1, 'database': 'rel', 'path': 'a.png', 'data': {'metadata': {'x': 1}}, 'position': 0})
    assert (flat['name'], flat['folder'], flat['runs'], flat['url'], flat['position'], flat['data']) == ('a.png', '', 0, None, 0, {'metadata': {'x': 1}})

  def collection(self, **kwargs):
    return {
      'id': 3, 'project_id': 'a', 'name': 'night/hard', 'description': None, 'created_at': DATE, 'updated_at': DATE,
      'archived_at': None, 'latest_version': 2, 'size': 10,
      'created_by_id': 1, 'created_by_user_name': 'alice', 'created_by_full_name': 'Alice A',
      'updated_by_id': 2, 'updated_by_user_name': 'bob', 'updated_by_full_name': 'Bob B', **kwargs,
    }

  def test_collection(self):
    data = serialize_collection(self.collection(), 'a', favorite=True, pins=[{'id': None, 'name': None}], user_group_ids=[], can_edit=True)
    assert data == {
      'id': 3, 'project': 'a', 'name': 'night/hard', 'description': '',
      'created_by': {'id': 1, 'user_name': 'alice', 'full_name': 'Alice A'},
      'updated_by': {'id': 2, 'user_name': 'bob', 'full_name': 'Bob B'},
      'created_at': "2026-11-20T10:30:00Z", 'updated_at': "2026-11-20T10:30:00Z", 'archived': False, 'archived_at': None,
      'latest_version': 2, 'size': 10, 'favorite': True, 'pinned_for': [{'id': None, 'name': None}], 'pinned': True,
      'can_edit': True, 'shared': True, 'mine': False, 'can_pin_everyone': False, 'ref': 'night/hard', 'inherited': False,
    }
    # personal, seen by its creator
    data = serialize_collection(self.collection(shared=False), 'a', user_id=1)
    assert (data['shared'], data['mine']) == (False, True)

  def test_inherited_collection(self):
    data = serialize_collection(self.collection(created_by_id=None, updated_by_id=None, archived_at=DATE), 'a/b', pins=[{'id': 5, 'name': 'team'}], user_group_ids=[6])
    assert (data['ref'], data['inherited'], data['created_by'], data['updated_by'], data['archived'], data['pinned'], data['favorite']) == ('a:night/hard', True, None, None, True, False, False)
    assert serialize_collection(self.collection(), 'a/b', pins=[{'id': 5, 'name': 'team'}], user_group_ids=[5])['pinned']

  def test_who_cant_edit_only_sees_the_pins_for_everyone_and_their_groups(self):
    pins = [{'id': None, 'name': None}, {'id': 5, 'name': 'team'}, {'id': 6, 'name': 'secret-team'}]
    assert serialize_collection(self.collection(), 'a', pins=pins, user_group_ids=[5])['pinned_for'] == pins[:2]
    assert serialize_collection(self.collection(), 'a', pins=pins)['pinned_for'] == pins[:1]
    assert serialize_collection(self.collection(), 'a', pins=pins, can_edit=True)['pinned_for'] == pins

  def test_version(self):
    assert serialize_version({'version': 2, 'created_at': DATE, 'notes': None, 'size': 4, 'created_by_id': None}) == {
      'version': 2, 'created_by': None, 'created_at': "2026-11-20T10:30:00Z", 'notes': '', 'size': 4,
    }

  def test_stale(self):
    assert stale_error(1, 3)['reason'] == 'stale_version' and stale_error(1, 3)['latest_version'] == 3


class TestExport:
  def test_batch_names(self):
    assert batch_name("night/hard cases") == "hard-cases"
    assert batch_name("x/..") == ".."  # not a valid name anyway
    assert batch_name("a/ ") == "collection"

  def test_yaml_with_a_version(self):
    text = export_yaml("night/hard-cases", "a", "a/b", 2, 120, 3)
    assert text.startswith("# The collection night/hard-cases of a: version 2, 120 inputs.")
    assert yaml.safe_load(text) == {'hard-cases': {'collections': ['a:night/hard-cases@2']}}
    assert "qaboard.yaml lists in inputs.batches, then: qa batch hard-cases" in text

  def test_yaml_latest(self):
    text = export_yaml("night/hard-cases", "a", None, None, 1, 3)
    assert "now 3, 1 input)" in text
    assert yaml.safe_load(text)['hard-cases'] == {'collections': ['night/hard-cases']}
