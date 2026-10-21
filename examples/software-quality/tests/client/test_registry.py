import pytest

from fleet_sdk.client import Registry, default_registry, dispatch, handler
from fleet_sdk.codec import Frame, FrameError, encode_frame


def test_handler_decorator_registers():
    @handler('battery')
    def on_battery(frame):
        return frame.payload

    assert dispatch(encode_frame(Frame(3, 1, b'87%'))) == b'87%'


def test_default_registry_starts_empty():
    assert default_registry.handlers == {}


def test_no_handler():
    assert Registry().dispatch(encode_frame(Frame(2, 1, b'pose'))) is None


def test_one_handler_per_type():
    registry = Registry()
    registry.add('pose', print)
    with pytest.raises(ValueError, match='already'):
        registry.add('pose', print)


@pytest.mark.parametrize('frame_type,name', [(1, 'telemetry'), (2, 'pose'), (3, 'battery'), (4, 'mission'), (5, 'ack')])
def test_dispatch_by_type(frame_type, name):
    registry = Registry()
    for n in ('telemetry', 'pose', 'battery', 'mission', 'ack'):
        handler(n, registry)(lambda frame, n=n: n)
    assert registry.dispatch(encode_frame(Frame(frame_type, 7))) == name


def test_corrupted_frames_raise():
    data = bytearray(encode_frame(Frame(1, 1, b'x')))
    data[-1] ^= 0xFF
    with pytest.raises(FrameError):
        Registry().dispatch(bytes(data))
