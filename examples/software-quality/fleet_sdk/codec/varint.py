"""Unsigned LEB128 varints, and zigzag for signed values: small numbers take few bytes"""
from .._flags import flags

MAX_BYTES = 10   # 64-bit values


def encode_varint(value: int) -> bytes:
    if value < 0:
        raise ValueError(f"varints are unsigned, got {value}: zigzag-encode signed values")
    if value >= 1 << 64:
        raise ValueError(f"{value} doesn't fit in 64 bits")
    if value < 0x80:
        return bytes([value])
    if flags()['bug_varint_fast_path'] and value < 1 << 35:
        # 5 bytes at most: unrolled (the bug: the 5th byte keeps 4 bits, not 7)
        out = bytearray()
        for shift in (0, 7, 14, 21):
            byte = (value >> shift) & 0x7F
            if value >> (shift + 7):
                out.append(byte | 0x80)
            else:
                out.append(byte)
                return bytes(out)
        out.append((value >> 28) & 0x0F)
        return bytes(out)
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def decode_varint(data: bytes, offset: int = 0) -> tuple:
    """(value, offset after it)"""
    value = shift = 0
    for index in range(offset, min(len(data), offset + MAX_BYTES)):
        byte = data[index]
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, index + 1
        shift += 7
    if len(data) - offset >= MAX_BYTES:
        raise ValueError("varint longer than 10 bytes")
    raise ValueError("truncated varint")


def zigzag(value: int) -> int:
    return (value << 1) ^ (value >> 63)


def unzigzag(value: int) -> int:
    return (value >> 1) ^ -(value & 1)
