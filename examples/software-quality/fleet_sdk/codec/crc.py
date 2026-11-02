"""CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR"""

_TABLE = []
for _byte in range(256):
    _crc = _byte << 8
    for _ in range(8):
        _crc = ((_crc << 1) ^ 0x1021) if _crc & 0x8000 else _crc << 1
    _TABLE.append(_crc & 0xFFFF)


def crc16(data: bytes, crc: int = 0xFFFF) -> int:
    """The checksum of `data`; give the previous result as `crc` to checksum data in chunks"""
    for byte in data:
        crc = ((crc << 8) & 0xFFFF) ^ _TABLE[((crc >> 8) ^ byte) & 0xFF]
    return crc
