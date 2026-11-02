"""Telemetry on the wire: frames with a type, a sequence number, a varint-encoded payload and a CRC-16"""
from .crc import crc16
from .frames import Frame, FrameError, decode_frame, encode_frame, parse
from .varint import decode_varint, encode_varint

__all__ = ['crc16', 'Frame', 'FrameError', 'decode_frame', 'encode_frame', 'parse', 'decode_varint', 'encode_varint']
