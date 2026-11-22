"""
Tests for qaboard/media.py: the media runs log at each step, their files and their index, media.jsonl.
The web app's parser (webapp/src/viewers/media/media.js) is tested on the same fixtures: tests/fixtures/media/.
"""
import io
import json
import shutil
import struct
import sys
import tempfile
import unittest
import wave
import zlib
from pathlib import Path

import numpy

from qaboard import media
from qaboard.media import INDEX, MediaError, MediaLog, read_media

from .test_benchmarks import imported_modules, loaded_by_the_cli
from .test_active_run import ActiveRunTestCase
from .test_upload import UploaderTestCase

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'media'


def decode_png(data: bytes) -> numpy.ndarray:
  """Our PNGs, without Pillow: one IDAT, filter 0 on every row"""
  assert data.startswith(b'\x89PNG\r\n\x1a\n')
  width, height, _, color = struct.unpack('>IIBB', data[16:26])
  channels = {0: 1, 2: 3, 6: 4}[color]
  start = data.index(b'IDAT') + 4
  length = struct.unpack('>I', data[start - 8:start - 4])[0]
  raw = zlib.decompress(data[start:start + length])
  rows = [raw[y * (width * channels + 1) + 1:(y + 1) * (width * channels + 1)] for y in range(height)]
  array = numpy.frombuffer(b''.join(rows), dtype=numpy.uint8)
  return array.reshape((height, width) if channels == 1 else (height, width, channels))


class TestFixtures(unittest.TestCase):
  """What Python and the web app both read: change the format, change both."""
  def test_index_as_both_read_it(self):
    self.assertEqual(read_media(FIXTURES / 'run'), json.loads((FIXTURES / 'expected.json').read_text()))

  def test_files_of_the_index_exist(self):
    for item in read_media(FIXTURES / 'run'):
      if 'path' in item:
        self.assertTrue((FIXTURES / 'run' / item['path']).is_file(), item['path'])

  def test_fixtures_are_up_to_date(self):
    # make.py writes the same run folder again
    with tempfile.TemporaryDirectory() as d:
      copy = Path(d) / 'media'
      shutil.copytree(FIXTURES, copy)
      import subprocess
      subprocess.run([sys.executable, str(copy / 'make.py')], check=True, capture_output=True)
      self.assertEqual((copy / 'expected.json').read_text(), (FIXTURES / 'expected.json').read_text())
      self.assertEqual((copy / 'run' / INDEX).read_text(), (FIXTURES / 'run' / INDEX).read_text())


class MediaTestCase(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.run_dir = Path(self.tmp.name)
    self.log = MediaLog(self.run_dir)

  def file(self, line):
    return (self.run_dir / line['path']).read_bytes()


class TestImages(MediaTestCase):
  def test_arrays_as_png_without_pillow(self):
    rgb = numpy.arange(4 * 3 * 3, dtype=numpy.uint8).reshape(4, 3, 3)
    [line] = self.log.add('val/samples', 7, media.Image(rgb, caption='first'), time=10.0)
    self.assertEqual(line, {'_step': 7, '_time': 10.0, 'key': 'val/samples', 'kind': 'image', 'index': 0,
                            'path': 'media/val/samples/7_0.png', 'width': 3, 'height': 4, 'caption': 'first'})
    numpy.testing.assert_array_equal(decode_png(self.file(line)), rgb)

  def test_arrays_like_wandb_reads_them(self):
    # CHW like PyTorch, floats in [0, 1], one channel, booleans
    chw = numpy.zeros((3, 4, 5))
    chw[0] = 1.0
    [line] = self.log.add('chw', 0, media.Image(chw))
    image = decode_png(self.file(line))
    self.assertEqual(image.shape, (4, 5, 3))
    self.assertEqual(image[0, 0].tolist(), [255, 0, 0])
    [line] = self.log.add('gray', 0, media.Image(numpy.full((2, 2, 1), 0.5)))
    self.assertEqual(decode_png(self.file(line)).tolist(), [[127, 127], [127, 127]])
    [line] = self.log.add('mask', 0, media.Image(numpy.eye(2, dtype=bool)))
    self.assertEqual(decode_png(self.file(line)).tolist(), [[255, 0], [0, 255]])
    # floats over 1 are taken as 0-255
    [line] = self.log.add('bright', 0, media.Image(numpy.full((1, 1), 300.0)))
    self.assertEqual(decode_png(self.file(line)).tolist(), [[255]])
    with self.assertRaises(MediaError):
      self.log.add('bad', 0, media.Image(numpy.zeros((2, 2, 7))))

  def test_files_and_bytes(self):
    jpeg = self.run_dir / 'photo.JPG'
    # the smallest header we read the size from: SOI, then a SOF0 segment
    jpeg.write_bytes(b'\xff\xd8' + b'\xff\xc0\x00\x11\x08' + struct.pack('>HH', 480, 640) + b'\x03' + b'\x00' * 9)
    [line] = self.log.add('photos', 3, media.Image(jpeg))
    self.assertEqual((line['path'], line['width'], line['height']), ('media/photos/3_0.jpg', 640, 480))
    gif = b'GIF89a' + struct.pack('<HH', 2, 1) + b'\x00' * 10
    [line] = self.log.add('anim', 3, media.Image(gif))
    self.assertEqual((line['path'], line['width'], line['height']), ('media/anim/3_0.gif', 2, 1))
    with self.assertRaises(MediaError):
      self.log.add('missing', 0, media.Image(Path('nope.png')))
    with self.assertRaises(MediaError):
      self.log.add('text', 0, media.Image({'not': 'an image'}))

  def test_boxes(self):
    boxes = [{'x': 1, 'y': 2.5, 'w': 3, 'h': 4, 'label': 'cat', 'score': numpy.float32(0.75), 'group': 'predictions', 'extra': 1}]
    [line] = self.log.add('detections', 0, media.Image(numpy.zeros((8, 8), dtype=numpy.uint8), boxes=boxes))
    self.assertEqual(line['boxes'], [{'x': 1, 'y': 2.5, 'w': 3, 'h': 4, 'label': 'cat', 'group': 'predictions', 'score': 0.75}])
    with self.assertRaises(MediaError):
      media.Image(numpy.zeros((2, 2)), boxes=[{'x': 1}])

  def test_lists_and_keys(self):
    lines = self.log.add('../val samples//x', 2, [media.Image(numpy.zeros((1, 1))), media.Image(numpy.ones((1, 1)))])
    self.assertEqual([(l['index'], l['path']) for l in lines], [(0, 'media/val_samples/x/2_0.png'), (1, 'media/val_samples/x/2_1.png')])
    self.assertEqual(lines[0]['key'], '../val samples//x')  # the index keeps the name, the path is safe
    with self.assertRaises(MediaError):
      self.log.add('mixed', 0, [media.Image(numpy.zeros((1, 1))), 3])


class TestOtherKinds(MediaTestCase):
  def test_audio_samples_as_wav(self):
    stereo = numpy.stack([numpy.linspace(-1, 1, 1600), numpy.zeros(1600)], axis=1)
    [line] = self.log.add('tts', 0, media.Audio(stereo, sample_rate=16000, caption='hi'))
    self.assertEqual({k: line[k] for k in ('path', 'sample_rate', 'channels', 'duration')},
                     {'path': 'media/tts/0_0.wav', 'sample_rate': 16000, 'channels': 2, 'duration': 0.1})
    with wave.open(io.BytesIO(self.file(line))) as f:
      frames = numpy.frombuffer(f.readframes(f.getnframes()), dtype='<i2').reshape(-1, 2)
    self.assertEqual((frames[0, 0], frames[-1, 0], frames[0, 1]), (-32767, 32767, 0))
    # channels first, int16
    [line] = self.log.add('int', 0, media.Audio(numpy.zeros((2, 100), dtype=numpy.int16), sample_rate=8000))
    self.assertEqual(line['channels'], 2)
    with self.assertRaisesRegex(MediaError, 'sample_rate'):
      self.log.add('no rate', 0, media.Audio(numpy.zeros(10)))
    [line] = self.log.add('mp3', 0, media.Audio(b'ID3' + b'\x00' * 20, sample_rate=44100))
    self.assertEqual((line['path'], line['sample_rate']), ('media/mp3/0_0.mp3', 44100))

  def test_video(self):
    clip = self.run_dir / 'clip.mp4'
    clip.write_bytes(b'\x00\x00\x00\x18ftypmp42')
    [line] = self.log.add('rollout', 5, media.Video(clip, fps=30))
    self.assertEqual((line['path'], line['fps']), ('media/rollout/5_0.mp4', 30))
    frames = numpy.zeros((2, 3, 4, 4), dtype=numpy.uint8)
    try:
      import PIL  # noqa: F401
    except ImportError:
      with self.assertRaisesRegex(MediaError, 'Pillow'):
        self.log.add('frames', 0, media.Video(frames))
    else:
      [line] = self.log.add('frames', 0, media.Video(frames))
      self.assertEqual((line['path'], line['fps']), ('media/frames/0_0.gif', 4.0))

  def test_tables_with_media_cells(self):
    table = media.Table(columns=['image', 'label', 'score', 'nested'], data=[[media.Image(numpy.zeros((2, 3))), 'cat', numpy.float64(0.5), {'a': numpy.int64(1)}]])
    table.add_data(None, 'dog', float('nan'), [1, 2])
    [line] = self.log.add('predictions', 1, table)
    self.assertEqual({k: line[k] for k in ('path', 'columns', 'rows')}, {'path': 'media/predictions/1_0.table.json', 'columns': ['image', 'label', 'score', 'nested'], 'rows': 2})
    saved = json.loads(self.file(line))
    self.assertEqual(saved['data'], [
      [{'kind': 'image', 'path': 'media/predictions/1_0/0_0.png', 'width': 3, 'height': 2}, 'cat', 0.5, {'a': 1}],
      [None, 'dog', None, [1, 2]],
    ])
    self.assertTrue((self.run_dir / 'media/predictions/1_0/0_0.png').is_file())

  def test_tables_from_dataframes(self):
    class Frame:  # what we use of pandas
      columns = ['a', 'b']
      values = numpy.array([[1, 2], [3, 4]])
    self.assertEqual(media.Table(dataframe=Frame()).rows, [[1, 2], [3, 4]])
    self.assertEqual(media.Table(data=[[1, 2]]).columns, ['c0', 'c1'])

  def test_histograms_are_in_the_index(self):
    [line] = self.log.add('weights', 3, media.Histogram([1, 2, 2, 3, 100, float('nan')], bins=3))
    self.assertNotIn('path', line)
    self.assertEqual(line['counts'], [4, 0, 1])
    self.assertEqual(line['bins'][0], 1)
    self.assertEqual(len(line['bins']), 4)
    self.assertEqual(media.Histogram(numpy.array([])).counts, [0] * 64)
    self.assertEqual(media.Histogram([5, 5], bins=2).counts, [0, 2])  # a single value still has a width
    counts, edges = numpy.histogram([1, 2, 3], bins=2)
    self.assertEqual(media.Histogram(np_histogram=(counts, edges)).counts, [1, 2])
    with self.assertRaises(MediaError):
      media.Histogram(np_histogram=([1, 2], [0, 1]))
    self.assertEqual(len(media.Histogram(numpy.arange(10), bins=10_000).counts), media.MAX_BINS)

  def test_texts_html_plotly(self):
    [text] = self.log.add('answer', 0, media.Text('42'))
    [html] = self.log.add('report', 0, media.Html('<b>ok</b>'))
    [plot] = self.log.add('figure', 0, media.Plotly({'data': [{'y': [numpy.int64(1)]}]}))
    self.assertEqual([self.file(text), self.file(html)], [b'42', b'<b>ok</b>'])
    self.assertEqual(plot['path'], 'media/figure/0_0.plotly.json')
    self.assertEqual(json.loads(self.file(plot)), {'data': [{'y': [1]}]})
    [report] = self.log.add('files', 0, media.File(self.run_dir / 'media/report/0_0.html'))
    self.assertEqual(report['path'], 'media/files/0_0.html')

  def test_what_code_logs_as_is(self):
    class Figure:
      def savefig(self, f, format):
        f.write(media.png(numpy.zeros((1, 2), dtype=numpy.uint8)))
    Figure.__module__ = 'matplotlib.figure'
    self.assertIsInstance(media.as_media(Figure()), media.Image)
    [line] = self.log.add('fig', 0, Figure())
    self.assertEqual((line['width'], line['height']), (2, 1))
    self.assertFalse(media.is_media(1.0) or media.is_media([]) or media.is_media('a.png') or media.is_media(numpy.zeros(3)))


class TestWhatTheReviewFound(MediaTestCase):
  def test_integer_audio_of_any_width(self):
    def frames(line):
      with wave.open(io.BytesIO(self.file(line))) as f:
        return numpy.frombuffer(f.readframes(f.getnframes()), dtype='<i2').tolist()
    # int16 values in an int64 array, like a list of ints: kept, not divided to silence
    [line] = self.log.add('pcm', 0, media.Audio([0, 16000, -16000], sample_rate=8000))
    self.assertEqual(frames(line), [0, 16000, -16000])
    [line] = self.log.add('int32', 0, media.Audio(numpy.array([0, 2 ** 30, -2 ** 30], dtype=numpy.int32), sample_rate=8000))
    self.assertEqual(frames(line), [0, 16384, -16384])
    [line] = self.log.add('uint8', 0, media.Audio(numpy.array([128, 255, 0], dtype=numpy.uint8), sample_rate=8000))
    self.assertEqual(frames(line), [0, 32512, -32768])
    [line] = self.log.add('uint16', 0, media.Audio(numpy.array([32768, 65535, 0], dtype=numpy.uint16), sample_rate=8000))
    self.assertEqual(frames(line), [0, 32767, -32768])
    for bad in (dict(data=numpy.zeros(3), sample_rate='fast'), dict(data=numpy.zeros(3), sample_rate=0), dict(data=3.0, sample_rate=8000)):
      with self.assertRaises(MediaError):
        self.log.add('bad', 0, media.Audio(**bad))

  def test_a_bad_value_saves_nothing(self):
    with self.assertRaises(MediaError):
      media.Image(numpy.zeros((2, 2)), boxes=[{'x': float('nan'), 'y': 0, 'w': 1, 'h': 1}])
    clip = self.run_dir / 'clip.mp4'
    clip.write_bytes(b'mp4')
    # numpy numbers in the fields are numbers
    [line] = self.log.add('video', 0, media.Video(clip, fps=numpy.float32(30)))
    self.assertEqual(line['fps'], 30.0)

    too_big = media.Table(columns=['a'], data=[[i] for i in range(media.MAX_TABLE_ROWS + 1)])
    with self.assertRaises(MediaError):
      self.log.add('list', 1, [media.Text('fine'), too_big])
    self.assertFalse((self.run_dir / 'media/list').exists())   # neither file of the list
    self.assertEqual(read_media(self.run_dir, 'list'), [])

  def test_keys_never_share_a_folder(self):
    [a] = self.log.add('a b', 7, media.Text('first'))
    [b] = self.log.add('a_b', 7, media.Text('second'))
    [c] = self.log.add('A_B', 7, media.Text('third'))   # the same folder on macOS and Windows
    self.assertEqual(a['path'], 'media/a_b/7_0.txt')
    self.assertEqual(len({a['path'], b['path'], c['path']}), 3)
    self.assertEqual([self.file(i) for i in (a, b, c)], [b'first', b'second', b'third'])
    # resumed, keys keep their folders
    resumed = MediaLog(self.run_dir, resume=True)
    [b2] = resumed.add('a_b', 8, media.Text('again'))
    self.assertEqual(b2['path'].rsplit('/', 1)[0], b['path'].rsplit('/', 1)[0])

  def test_threads_logging_together(self):
    import threading
    errors = []

    def log(i):
      try:
        self.log.add('same', 0, media.Text(str(i)))
      except Exception as e:
        errors.append(e)
    threads = [threading.Thread(target=log, args=(i,)) for i in range(16)]
    for t in threads:
      t.start()
    for t in threads:
      t.join()
    self.assertEqual(errors, [])
    self.assertEqual(len((self.run_dir / INDEX).read_text().splitlines()), 16)

  def test_tables_from_mappings_and_bad_rows(self):
    self.assertEqual(media.Table(data={'label': ['cat', 'dog'], 'score': [0.9, 0.4]}).rows, [['cat', 0.9], ['dog', 0.4]])
    self.assertEqual(media.Table(data={'label': ['cat', 'dog'], 'score': [0.9, 0.4]}).columns, ['label', 'score'])
    for bad in ([1, 2, 3], 'abc', ['ab', 'cd']):
      with self.assertRaises(MediaError):
        media.Table(data=bad)

  def test_html_and_text_from_bytes(self):
    [html] = self.log.add('html', 0, media.Html(b'<p>hi</p>'))
    [stream] = self.log.add('stream', 0, media.Html(io.BytesIO(b'<p>ho</p>')))
    [text] = self.log.add('text', 0, media.Text('caf\u00e9'.encode()))
    self.assertEqual([self.file(html), self.file(stream), self.file(text)], [b'<p>hi</p>', b'<p>ho</p>', 'caf\u00e9'.encode()])
    with self.assertRaises(MediaError):
      self.log.add('missing', 0, media.Html('missing.html'))

  def test_16_bit_images_are_scaled_and_empty_ones_refused(self):
    [line] = self.log.add('u16', 0, media.Image(numpy.array([[0, 65535, 32768]], dtype=numpy.uint16)))
    self.assertEqual(decode_png(self.file(line)).tolist(), [[0, 255, 128]])
    with self.assertRaisesRegex(MediaError, 'empty'):
      media.Image(numpy.zeros((0, 3))).encode()

  def test_histograms_of_what_isnt_numbers(self):
    for values in (['a', 'b'], 3.0, [None, None]):
      try:
        media.Histogram(values)
      except MediaError:
        pass
    with self.assertRaises(MediaError):
      media.Histogram(np_histogram=([1, 2], [0, float('nan'), 1]))


class TestIndex(MediaTestCase):
  def test_last_of_duplicates_and_cut_lines(self):
    self.log.add('answer', 1, media.Text('a'))
    with open(self.run_dir / INDEX, 'a') as f:
      f.write('{"_step": 2, "key": "ans')  # killed while writing
    self.log.add('answer', 1, media.Text('b'))
    self.log.add('answer', 0, media.Text('c'))
    self.assertEqual([(i['_step'], self.file(i)) for i in read_media(self.run_dir)], [(0, b'c'), (1, b'b')])
    self.assertEqual(len((self.run_dir / INDEX).read_text().splitlines()), 4)  # the cut line stays alone on its line

  def test_resume_keeps_the_index(self):
    self.log.add('a', 0, media.Text('a'))
    MediaLog(self.run_dir, resume=True).add('a', 1, media.Text('b'))
    self.assertEqual([i['_step'] for i in read_media(self.run_dir, 'a')], [0, 1])
    MediaLog(self.run_dir)
    self.assertEqual(read_media(self.run_dir), [])


class TestUploads(UploaderTestCase):
  def test_media_are_sent_while_the_run_goes_on(self):
    server = self.server()
    uploader = self.uploader(server)
    log = MediaLog(self.run_dir)
    log.add('answer', 0, media.Text('hi'))
    self.write('model.onnx', b'weights')
    self.assertTrue(uploader.sync())
    self.assertEqual(sorted(server.files), [INDEX, 'media/answer/0_0.txt'])
    log.add('answer', 1, media.Text('ho'))
    self.assertTrue(uploader.sync())
    self.assertEqual(server.files[INDEX], (self.run_dir / INDEX).read_bytes())  # appended, like series.jsonl


class TestUploadsOnlyTheirMedia(UploaderTestCase):
  def test_a_media_link_out_of_the_folder_isnt_followed(self):
    import os
    server = self.server()
    secret = Path(self.tmp.name) / 'secret'
    secret.mkdir()
    (secret / 'id_rsa').write_bytes(b'key')
    os.symlink(secret, self.run_dir / 'media')
    self.write(INDEX, b'{}\n')
    self.assertTrue(self.uploader(server).sync())
    self.assertNotIn('media/id_rsa', server.files)

  def test_a_media_folder_without_index_isnt_sent_while_the_run_goes_on(self):
    server = self.server()
    self.write('media/frame.png', b'png')   # a `qa run` project's own folder
    self.assertTrue(self.uploader(server).sync())
    self.assertEqual(server.files, {})

  def test_the_files_go_before_the_lines_that_list_them(self):
    server = self.server()
    MediaLog(self.run_dir).add('answer', 0, media.Text('hi'))
    self.assertTrue(self.uploader(server).sync())
    paths = [request[1] for request in server.requests if request[0] == 'PUT']
    self.assertTrue(paths, server.requests)
    self.assertLess(next(i for i, p in enumerate(paths) if 'answer' in p), next(i for i, p in enumerate(paths) if INDEX in p))


class TestActiveRun(ActiveRunTestCase):
  def test_logging_media(self):
    result = self.python(QA_OFFLINE='1', code="""
import numpy
import qaboard as qb
run = qb.start_run(input="eval", output_dir="my-run", capture_output=False)
assert run.log({"loss": 1.0, "samples": [qb.Image(numpy.zeros((2, 2))), qb.Image(numpy.ones((2, 2)))], "nested": {"hist": qb.Histogram([1, 2])}}) == 0
assert run.log({"answer": qb.Text("hi")}) == 1          # media alone count as a step, like numbers
assert run.log_image("val/sample", numpy.zeros((4, 4, 3)), caption="first", boxes=[{"x": 0, "y": 0, "w": 2, "h": 2}]) == 1   # the last step
assert run.log_audio("tts", numpy.zeros(100), sample_rate=8000, step=5) == 5
assert run.log_table("preds", [["cat", 0.9]], columns=["label", "score"]) == 1
assert run.log_histogram("w", numpy.arange(10), bins=5, step=2) == 2
assert run.log_text("answer", "ho", step=3) == 3
assert run.log_media("report", qb.Html("<p>ok</p>")) == 1
# what can't be saved is said once and skipped
assert run.log_audio("broken", numpy.zeros(10)) == 1
assert run.log_audio("broken", numpy.zeros(10)) == 1
for call in (lambda: run.log_media("_x", qb.Text("a")), lambda: run.log_media("x", qb.Text("a"), step=-1)):
  try:
    call()
  except ValueError:
    pass
  else:
    raise AssertionError("not refused")
try:
  run.log_media("x", 3.0)
except TypeError:
  pass
else:
  raise AssertionError("not refused")
assert dict(run.metrics) == {"loss": 1.0}, run.metrics   # media aren't metrics
keys = sorted({(i["key"], i["_step"]) for i in run.media()})
assert keys == [("answer", 1), ("answer", 3), ("nested/hist", 0), ("preds", 1), ("report", 1), ("samples", 0), ("tts", 5), ("val/sample", 1), ("w", 2)], keys
assert [i["index"] for i in run.media("samples")] == [0, 1]
assert run.media("val/sample")[0]["boxes"] == [{"x": 0, "y": 0, "w": 2, "h": 2}]
# the helpers never raise out of a training: said once, skipped
run.log_image("bad_boxes", numpy.zeros((2, 2)), boxes=[{"x": 1}])
run.log_histogram("bad_hist", ["a"])
run.log_histogram("bad_hist2", 3.0)
run.log_audio("bad_rate", numpy.zeros(3), sample_rate="fast")
run.log_table("bad_table", [1, 2, 3])
assert run.log_image("listed", [numpy.zeros((1, 1)), qb.Image(numpy.ones((1, 1)), caption="b")], step=9) == 9
assert [i.get("caption") for i in run.media("listed")] == [None, "b"]
for key in ("bad_boxes", "bad_hist", "bad_rate", "bad_table"):
  assert run.media(key) == [], key
run.finish()
assert run.log_image("late", numpy.zeros((1, 1))) == -1   # like log()
assert run.media("late") == []
""")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(result.stderr.count('not logging broken'), 1, result.stderr)
    self.assertIn('sample_rate', result.stderr)
    for key in ("bad_boxes", "bad_hist", "bad_rate", "bad_table"):
      self.assertIn(f'not logging {key}', result.stderr)


class TestIsolation(unittest.TestCase):
  """Projects import qaboard.media with start_run(): it doesn't weigh on `import qaboard` or the `qa` CLI, and needs
  only the standard library (numpy, Pillow... are imported when the values are theirs)."""
  def test_imports_only_the_standard_library(self):
    path = Path(__file__).resolve().parent.parent / 'qaboard' / 'media.py'
    allowed = set(sys.stdlib_module_names) | {'numpy', 'PIL'}
    for name in imported_modules(path):
      self.assertTrue(not name.startswith('.') and name.split('.')[0] in allowed, f'media.py imports {name}')

  def test_not_loaded_by_import_qaboard_or_the_cli(self):
    self.assertNotIn('qaboard.media', loaded_by_the_cli())


if __name__ == '__main__':
  unittest.main()
