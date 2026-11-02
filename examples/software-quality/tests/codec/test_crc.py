import pytest

from fleet_sdk.codec import crc16

# CRC-16/CCITT-FALSE check values
VECTORS = [
    (b'', 0xFFFF),
    (b'123456789', 0x29B1),
    (b'A', 0xB915),
    (b'\x00', 0xE1F0),
    (b'\xff', 0xFF00),
    (b'\x00\x00', 0x1D0F),
    (b'kitefin', None),
]


@pytest.mark.parametrize('data,expected', [v for v in VECTORS if v[1] is not None])
def test_known_vectors(data, expected):
    assert crc16(data) == expected


@pytest.mark.parametrize('split', [0, 1, 4, 8, 9])
def test_in_chunks(split):
    data = b'123456789'
    assert crc16(data[split:], crc16(data[:split])) == crc16(data)


@pytest.mark.parametrize('position', range(8))
def test_detects_single_bit_flips(position):
    data = bytearray(b'telemetry frame')
    reference = crc16(bytes(data))
    data[position] ^= 1 << (position % 8)
    assert crc16(bytes(data)) != reference


def test_fits_16_bits(rng):
    for _ in range(100):
        data = bytes(rng.randrange(256) for _ in range(rng.randrange(1, 64)))
        assert 0 <= crc16(data) <= 0xFFFF
