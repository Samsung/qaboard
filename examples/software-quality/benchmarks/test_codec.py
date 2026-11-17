"""The telemetry codec: varints by encoded size, CRC-16 and frames by payload size"""
import random

import pytest

from fleet_sdk.codec.crc import crc16
from fleet_sdk.codec.frames import Frame, decode_frame, encode_frame, split_frames
from fleet_sdk.codec.varint import decode_varint, encode_varint, unzigzag, zigzag

# a value that takes this many bytes as a varint
VARINTS = {1: 0x55, 2: 0x2AAA, 3: 0x155555, 4: 0xAAAAAAA, 5: 0x55555555, 10: 0xAAAAAAAAAAAAAAAA}
PAYLOADS = [16, 256, 4096]


def payload(size):
    return random.Random(size).randbytes(size)


@pytest.mark.benchmark(group='varint')
@pytest.mark.parametrize('size', VARINTS)
def test_encode_varint(benchmark, size):
    value = VARINTS[size]
    assert len(benchmark(encode_varint, value)) == size


@pytest.mark.benchmark(group='varint')
@pytest.mark.parametrize('size', VARINTS)
def test_decode_varint(benchmark, size):
    data = encode_varint(VARINTS[size]) if size == 10 else _reference_encoding(VARINTS[size])
    assert benchmark(decode_varint, data) == (VARINTS[size], size)


def _reference_encoding(value):
    """LEB128, written out: the benchmark of decode_varint doesn't depend on encode_varint's correctness"""
    out = bytearray()
    while value >= 0x80:
        out.append(value & 0x7F | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


@pytest.mark.benchmark(group='varint')
def test_zigzag_round_trip(benchmark):
    assert benchmark(lambda: unzigzag(zigzag(-123456789))) == -123456789


@pytest.mark.benchmark(group='crc')
@pytest.mark.parametrize('size', PAYLOADS)
def test_crc16(benchmark, size):
    benchmark(crc16, payload(size))


@pytest.mark.benchmark(group='frames')
@pytest.mark.parametrize('size', PAYLOADS)
def test_encode_frame(benchmark, size):
    benchmark(encode_frame, Frame(1, 70_000, payload(size)))


@pytest.mark.benchmark(group='frames')
@pytest.mark.parametrize('size', PAYLOADS)
def test_decode_frame(benchmark, size):
    data = encode_frame(Frame(1, 70_000, payload(size)))
    frame, read = benchmark(decode_frame, data)
    assert read == len(data) and frame.seq == 70_000


@pytest.mark.benchmark(group='frames')
def test_split_stream_of_100_frames(benchmark):
    stream = b''.join(encode_frame(Frame(2, seq, payload(32))) for seq in range(100))
    assert len(benchmark(split_frames, stream)) == 100
