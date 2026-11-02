"""
Handlers of incoming frames, by frame type. The SDK has one default registry that `@handler` adds to, like web
frameworks' routes: convenient, and shared by everything in the process (tests included).
"""
from ..codec import Frame, decode_frame
from .._flags import flags


class Registry:
    def __init__(self):
        self.handlers = {}

    def add(self, frame_type: str, fn):
        if frame_type in self.handlers:
            raise ValueError(f"a handler for {frame_type} frames is already registered")
        self.handlers[frame_type] = fn
        return fn

    def clear(self):
        self.handlers.clear()

    def dispatch(self, data: bytes):
        """Decodes a frame and calls its handler: returns what it returns, None for frames without a handler"""
        if flags()['client_legacy_parse']:
            from ..codec import parse
            frame = parse(data)
        else:
            frame, _ = decode_frame(data)
        fn = self.handlers.get(frame.type_name)
        return fn(frame) if fn else None


default_registry = Registry()


def handler(frame_type: str, registry: Registry = None):
    """@handler('battery') def on_battery(frame): ..."""
    def decorate(fn):
        return (registry or default_registry).add(frame_type, fn)
    return decorate


def dispatch(data: bytes, registry: Registry = None):
    return (registry or default_registry).dispatch(data)


__all__ = ['Registry', 'default_registry', 'handler', 'dispatch', 'Frame']
