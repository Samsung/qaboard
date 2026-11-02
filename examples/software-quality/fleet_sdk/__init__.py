"""
The Kitefin fleet SDK: what robots and fleet tools use to talk to the fleet backend.

- `codec`: telemetry frames on the wire (varints, CRC-16, frames)
- `planning`: the warehouse grid and paths through it
- `battery`: state of charge and range
- `missions`: which robot gets which mission
- `client`: retries with backoff, and the registry of message handlers
"""
__version__ = '1.5.0'
