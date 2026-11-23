"""
Tells the server, every few minutes, that a run still runs: if its machine is killed or loses the network, the
server marks it failed instead of showing it running forever (backend/backend/heartbeats.py).

The run says it sends heartbeats when it starts (`heartbeat: true` in POST /api/v1/output/), then reports
(PATCH /api/v1/output/<id>/progress, without metrics: nothing changes) at least every INTERVAL, with what the run
uses of its machine so far (qaboard/system_metrics.py, `{"resources": {...}}`). Runs use them through
their reporter (qaboard/reporting.py): `qa run` beats all along; qaboard.start_run() reports its progress anyway,
and beats when it has nothing new, and while its last files are sent.
"""
import os
from threading import Event, Thread
from typing import Any, Callable, Dict, Optional

from .results import ResultsError, _request

# The server fails runs silent for $QABOARD_SILENT_RUN_TIMEOUT_MINUTES (15 by default): several chances before that
INTERVAL = float(os.environ.get('QA_HEARTBEAT_INTERVAL') or 120.0)  # seconds
TIMEOUT = (10.0, 30.0)


def beat(server: str, run_id: int, token: Optional[str] = None, body: Optional[Dict[str, Any]] = None) -> None:
  """Says once that the run still runs, with `body`, e.g. {"resources": {...}}, but no metrics. Raises ResultsError"""
  _request(server, f"output/{run_id}/progress", method='PATCH', json=body or {}, token=token, timeout=TIMEOUT)


class Heartbeat:
  """`body()`: what each heartbeat says besides "still running" (see `beat`)"""
  def __init__(self, server: str, run_id: int, token: Optional[str] = None, interval: float = INTERVAL,
               body: Optional[Callable[[], Dict[str, Any]]] = None):
    self.server, self.run_id, self.interval = server, run_id, interval
    self._token = token
    self._body = body
    self._stop = Event()
    self._thread: Optional[Thread] = None

  def start(self) -> 'Heartbeat':
    self._thread = Thread(target=self._loop, name='qaboard-heartbeat', daemon=True)
    self._thread.start()
    return self

  def stop(self) -> None:
    self._stop.set()

  def _loop(self) -> None:
    while not self._stop.wait(self.interval):
      try:
        beat(self.server, self.run_id, self._token, self._body() if self._body is not None else None)
      except ResultsError as e:
        # a server from before heartbeats, the run ended, or we can't: nothing more to say. Else next time
        if not e.is_transient:
          return
      except Exception:  # never end the run
        pass
