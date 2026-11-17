"""The client: what receiving a frame costs, from its bytes to its handler"""
import pytest

from fleet_sdk.client.registry import Registry
from fleet_sdk.codec.frames import Frame, encode_frame

from .test_codec import PAYLOADS, payload


@pytest.mark.benchmark(group='client')
@pytest.mark.parametrize('size', PAYLOADS)
def test_dispatch(benchmark, size):
    registry = Registry()
    seen = []
    registry.add('telemetry', seen.append)
    data = encode_frame(Frame(1, 70_000, payload(size)))
    benchmark(registry.dispatch, data)
    assert seen[-1].seq == 70_000


@pytest.mark.benchmark(group='client')
def test_dispatch_without_handler(benchmark):
    data = encode_frame(Frame(5, 12, b''))
    benchmark(Registry().dispatch, data)
