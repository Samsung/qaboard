"""
What image readers say about the sensor behind a raw image, for the image viewer's analysis: its color filter array
(CFA), bit depth, black and white levels.

Readers return metadata as a dict (backend/images.py). We know the fields of a few readers: add yours to the lists
below. Any field can be missing: the viewer then guesses the CFA from the pixels, and users set the black level.
The viewer shows where each value comes from, with the fields used.
"""
import re

# The 2x2 cells of the CFA, row by row, e.g. "GRBG"
PATTERN_FIELDS = ('pattern', 'cfa_pattern', 'bayer_pattern', 'cfa')
# The size of its cells in pixels: 1 for Bayer, 2 for Tetra (Quad Bayer), 3 for Nona... e.g. 2 or "2x2"
BLOCK_FIELDS = ('samplePerPixel', 'cfa_block', 'cfa_cell_size')
# The type of the values, e.g. "UI10" (unsigned, 10 bits), or their bit depth
TYPE_FIELDS = ('imageType', 'image_type')
BITS_FIELDS = ('bits', 'bit_depth', 'bitDepth')
BLACK_FIELDS = ('pedestal', 'black_level', 'blackLevel')
WHITE_FIELDS = ('white_level', 'whiteLevel')
# Where the file was cut from a larger image
CROP_FIELDS = {'x': 'offsetX', 'y': 'offsetY', 'full_width': 'fullWidth', 'full_height': 'fullHeight'}
MONO_FIELDS = ('isBW',)

PATTERNS = {'RGGB', 'GRBG', 'GBRG', 'BGGR'}


def _number(value):
  try:
    number = float(value)
  except (TypeError, ValueError):
    return None
  return int(number) if number.is_integer() else number


def _first(meta, fields, valid=lambda value: value not in (None, '')):
  for field in fields:
    if field in meta and valid(meta[field]):
      return field, meta[field]
  return None, None


def sensor_info(meta):
  """
  The sensor's description from a reader's metadata, or None when it says nothing about it:
  {"cfa": {"pattern": "GRBG", "block": 2}, "bit_depth": 10, "black_level": 64, "white_level": 1023, "mono": False,
   "crop": {"x": 600, "y": 3264, "full_width": 7296, "full_height": 5472}, "fields": {the fields used: their values}}
  Zeros are unknowns (readers write 0 for "not set"). The CFA's pattern is that of the file's first pixel.
  """
  if not isinstance(meta, dict):
    return None
  info = {}
  fields = {}

  field, pattern = _first(meta, PATTERN_FIELDS, lambda v: isinstance(v, str) and v.strip().upper() in PATTERNS)
  if field:
    fields[field] = pattern
    block = 1
    block_field, value = _first(meta, BLOCK_FIELDS)
    if block_field:
      match = re.match(r'^\s*(\d+)(?:\s*[xX*]\s*(\d+))?\s*$', str(value))
      if match and (not match.group(2) or match.group(1) == match.group(2)) and 1 <= int(match.group(1)) <= 16:
        block = int(match.group(1))
        fields[block_field] = value
    info['cfa'] = {'pattern': pattern.strip().upper(), 'block': block}

  field, value = _first(meta, TYPE_FIELDS)
  bits = None
  if field:
    match = re.match(r'^\s*U(?:I|INT)?(\d+)\s*$', str(value), re.IGNORECASE)
    if match:
      bits = int(match.group(1))
      fields[field] = value
  if bits is None:
    field, value = _first(meta, BITS_FIELDS, lambda v: (_number(v) or 0) > 0)
    if field:
      bits = int(_number(value))
      fields[field] = value
  if bits and 1 <= bits <= 32:
    info['bit_depth'] = bits

  field, value = _first(meta, BLACK_FIELDS, lambda v: (_number(v) or 0) > 0)
  if field:
    info['black_level'] = _number(value)
    fields[field] = value
  field, value = _first(meta, WHITE_FIELDS, lambda v: (_number(v) or 0) > 0)
  if field:
    info['white_level'] = _number(value)
    fields[field] = value
  elif bits and bits <= 16:
    info['white_level'] = 2 ** bits - 1

  field, value = _first(meta, MONO_FIELDS, lambda v: v is True)
  if field:
    info['mono'] = True
    fields[field] = value

  crop = {key: _number(meta.get(name)) for key, name in CROP_FIELDS.items()}
  if crop['full_width'] and crop['full_height']:
    info['crop'] = {key: value or 0 for key, value in crop.items()}
    fields.update({name: meta.get(name) for name in CROP_FIELDS.values()})

  if not info:
    return None
  info['fields'] = fields
  return info
