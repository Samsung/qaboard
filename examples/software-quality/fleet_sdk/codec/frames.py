"""
A frame: magic byte 0xA3, version, type, sequence number (varint), payload length (varint), payload, CRC-16 of
everything before it (big-endian).
"""
import warnings
from dataclasses import dataclass

from .crc import crc16
from .varint import decode_varint, encode_varint

MAGIC = 0xA3
VERSION = 2
TYPES = {1: 'telemetry', 2: 'pose', 3: 'battery', 4: 'mission', 5: 'ack'}
MAX_PAYLOAD = 64 * 1024


class FrameError(ValueError):
    pass


@dataclass(frozen=True)
class Frame:
    type: int
    seq: int
    payload: bytes = b''

    @property
    def type_name(self) -> str:
        return TYPES.get(self.type, 'unknown')


def encode_frame(frame: Frame) -> bytes:
    if frame.type not in TYPES:
        raise FrameError(f"unknown frame type {frame.type}")
    if len(frame.payload) > MAX_PAYLOAD:
        raise FrameError(f"payload of {len(frame.payload)} bytes, over {MAX_PAYLOAD}")
    body = bytes([MAGIC, VERSION, frame.type]) + encode_varint(frame.seq) + encode_varint(len(frame.payload)) + frame.payload
    return body + crc16(body).to_bytes(2, 'big')


def decode_frame(data: bytes) -> tuple:
    """(frame, number of bytes read): data may hold more frames after this one"""
    if len(data) < 3:
        raise FrameError("truncated header")
    if data[0] != MAGIC:
        raise FrameError(f"bad magic byte 0x{data[0]:02x}")
    if data[1] != VERSION:
        raise FrameError(f"unsupported version {data[1]}")
    try:
        seq, offset = decode_varint(data, 3)
        length, offset = decode_varint(data, offset)
    except ValueError as e:
        raise FrameError(str(e)) from e
    if length > MAX_PAYLOAD:
        raise FrameError(f"payload of {length} bytes, over {MAX_PAYLOAD}")
    end = offset + length
    if len(data) < end + 2:
        raise FrameError("truncated frame")
    expected = int.from_bytes(data[end:end + 2], 'big')
    if crc16(data[:end]) != expected:
        raise FrameError("bad checksum")
    if data[2] not in TYPES:
        raise FrameError(f"unknown frame type {data[2]}")
    return Frame(data[2], seq, bytes(data[offset:end])), end + 2


def parse(data: bytes) -> Frame:
    """Deprecated since 1.3: use decode_frame(), which also says where the frame ends"""
    warnings.warn("codec.parse() is deprecated, use codec.decode_frame()", DeprecationWarning, stacklevel=2)
    return decode_frame(data)[0]


def split_frames(stream: bytes) -> list:
    """All the frames of a stream of back-to-back frames"""
    frames, offset = [], 0
    while offset < len(stream):
        frame, size = decode_frame(stream[offset:])
        frames.append(frame)
        offset += size
    return frames
