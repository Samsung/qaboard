import pytest

from fleet_sdk.codec import decode_varint, encode_varint
from fleet_sdk.codec.varint import unzigzag, zigzag


@pytest.mark.parametrize('value,encoded', [
    (0, b'\x00'), (1, b'\x01'), (127, b'\x7f'), (128, b'\x80\x01'), (300, b'\xac\x02'),
    (16384, b'\x80\x80\x01'), (2 ** 32, b'\x80\x80\x80\x80\x10'), (2 ** 64 - 1, b'\xff' * 9 + b'\x01'),
])
def test_known_encodings(value, encoded):
    assert encode_varint(value) == encoded
    assert decode_varint(encoded) == (value, len(encoded))


@pytest.mark.parametrize('bits', [7, 14, 21, 28, 32, 34, 35, 42, 49, 56, 63, 64])
def test_round_trip_at_byte_boundaries(bits):
    for value in (2 ** bits - 1, 2 ** (bits - 1)):
        assert decode_varint(encode_varint(value))[0] == value


def test_round_trip_fuzz(rng, fuzz_case):
    value = rng.getrandbits(rng.choice([7, 16, 32, 35, 48, 64]))
    assert decode_varint(encode_varint(value)) == (value, len(encode_varint(value)))


@pytest.mark.parametrize('value', [-1, 2 ** 64])
def test_out_of_range(value):
    with pytest.raises(ValueError):
        encode_varint(value)


def test_truncated():
    with pytest.raises(ValueError, match='truncated'):
        decode_varint(b'\x80\x80')


def test_too_long():
    with pytest.raises(ValueError, match='longer'):
        decode_varint(b'\x80' * 11)


def test_offset():
    data = b'\xff' + encode_varint(300) + b'\x01'
    assert decode_varint(data, 1) == (300, 3)


@pytest.mark.parametrize('value', [0, -1, 1, -64, 63, 2 ** 62, -(2 ** 63)])
def test_zigzag(value):
    assert zigzag(value) >= 0
    assert unzigzag(zigzag(value)) == value
