"""Runs' files: manifests, deletes, and runs saved twice"""
import os
import json
import stat

import pytest

from .test_jobs import World, storage  # noqa: F401 (fixtures)


@pytest.fixture
def world(storage):
  return World(storage)


@pytest.fixture
def umask():
  """The umask is process-wide: what the server sets, every thread sees"""
  previous = os.umask(0o022)
  yield 0o022
  os.umask(previous)


def current_umask():
  mask = os.umask(0)
  os.umask(mask)
  return mask


def test_manifests_dont_change_the_umask(world, umask):
  from backend.models import Output
  run = world.run(world.batch('proj'), deleted=False, files=True, size=10)
  world.commit()
  output = world.db.get(Output, run.id)
  manifest = output.update_manifest()
  assert 'image.png' in manifest
  assert current_umask() == umask
  # users' runs rewrite it under their own accounts
  assert stat.S_IMODE((run.output_dir / 'manifest.outputs.json').stat().st_mode) == 0o666


def test_manifests_of_runs_without_folder(world, umask):
  from backend.models import Output
  run = world.run(world.batch('proj'), deleted=False)
  world.commit()
  output = world.db.get(Output, run.id)
  assert output.update_manifest() == {}
  assert stat.S_IMODE(run.output_dir.stat().st_mode) == 0o777
  assert current_umask() == umask


def test_soft_deletes_remove_the_empty_folders(world):
  from backend.models import Output
  run = world.run(world.batch('proj'), deleted=False, files=True)
  (run.output_dir / 'sub' / 'deeper').mkdir(parents=True)
  (run.output_dir / 'sub' / 'deeper' / 'a.png').write_bytes(b'a')
  (run.output_dir / 'kept').mkdir()
  (run.output_dir / 'kept' / 'b.png').write_bytes(b'b')
  (run.output_dir / 'kept' / 'notes.txt').write_bytes(b'not in the manifest')
  (run.output_dir / 'manifest.outputs.json').write_text(json.dumps({'sub/deeper/a.png': {}, 'kept/b.png': {}}))
  world.commit()
  output = world.db.get(Output, run.id)
  output.delete(soft=True)
  assert not (run.output_dir / 'sub').exists()
  assert sorted(p.name for p in (run.output_dir / 'kept').iterdir()) == ['notes.txt']
  assert (run.output_dir / 'manifest.outputs.json').exists()
  assert output.deleted


def test_runs_saved_twice_keep_the_newest(world):
  from backend.models import Output
  batch = world.batch('proj')
  first = world.run(batch, deleted=False, files=True, size=10)
  output = world.db.get(Output, first.id)
  duplicate = Output(batch=batch, test_input=output.test_input, platform=output.platform, configurations=output.configurations,
                     extra_parameters=output.extra_parameters, data={"newest": True})
  world.db.add(duplicate)
  world.commit()
  duplicate_id = duplicate.id
  found = Output.get_or_create(world.db, batch=batch, test_input=output.test_input, platform='linux',
                               configurations=['base'], extra_parameters={})
  assert found.id == duplicate_id and found.data == {"newest": True}
  assert [o.id for o in world.db.query(Output).filter(Output.batch_id == batch.id)] == [duplicate_id]
  # the files stay: they are the newest's too
  assert (first.output_dir / 'image.png').exists()
