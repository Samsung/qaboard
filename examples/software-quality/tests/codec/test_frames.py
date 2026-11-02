import pytest

from fleet_sdk.codec import Frame, FrameError, decode_frame, encode_frame
from fleet_sdk.codec.frames import MAX_PAYLOAD, TYPES, split_frames


@pytest.mark.parametrize('frame_type', sorted(TYPES))
@pytest.mark.parametrize('seq', [0, 1, 127, 128, 2 ** 20, 2 ** 33])
def test_round_trip(frame_type, seq):
    frame = Frame(frame_type, seq, b'\x01\x02payload')
    data = encode_frame(frame)
    assert decode_frame(data) == (frame, len(data))


def test_round_trip_fuzz(rng, fuzz_case):
    frame = Frame(rng.choice(sorted(TYPES)), rng.getrandbits(rng.choice([8, 24, 34])), rng.randbytes(rng.randrange(0, 300)))
    assert decode_frame(encode_frame(frame))[0] == frame


def test_empty_payload():
    assert decode_frame(encode_frame(Frame(5, 3)))[0].payload == b''


def test_max_payload():
    frame = Frame(1, 1, bytes(MAX_PAYLOAD))
    assert decode_frame(encode_frame(frame))[0] == frame
    with pytest.raises(FrameError, match='over'):
        encode_frame(Frame(1, 1, bytes(MAX_PAYLOAD + 1)))


@pytest.mark.parametrize('corrupt,error', [
    (lambda d: b'\x00' + d[1:], 'magic'),
    (lambda d: d[:1] + b'\x09' + d[2:], 'version'),
    (lambda d: d[:-1] + bytes([d[-1] ^ 1]), 'checksum'),
    (lambda d: d[:-3], 'truncated'),
    (lambda d: d[:2], 'truncated'),
])
def test_rejects_corrupted(corrupt, error):
    data = encode_frame(Frame(3, 42, b'battery 87%'))
    with pytest.raises(FrameError, match=error):
        decode_frame(corrupt(data))


def test_unknown_type():
    with pytest.raises(FrameError, match='unknown'):
        encode_frame(Frame(99, 1))


def test_split_stream():
    frames = [Frame(1, n, bytes([n]) * n) for n in range(10)]
    assert split_frames(b''.join(encode_frame(f) for f in frames)) == frames


def test_type_names():
    assert Frame(3, 0).type_name == 'battery'
    assert Frame(42, 0).type_name == 'unknown'
