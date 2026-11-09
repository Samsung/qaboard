"""The project's Celery settings (qaboard.yaml's runners.celery), without importing Celery"""
import os
from typing import Any, Dict


# runners.celery settings that are the runner's, not Celery's
QABOARD_SETTINGS = ('forward_secrets',)


def qaboard_settings(config: Dict) -> Dict[str, Any]:
  """The runner's own settings from qaboard.yaml's runners.celery, e.g. forward_secrets"""
  settings = (config or {}).get('runners', {}).get('celery') or {}
  return {k: v for k, v in settings.items() if k in QABOARD_SETTINGS}


def celery_settings(config: Dict) -> Dict[str, Any]:
  """
  qaboard.yaml's runners.celery, with environment variables expanded in its URLs, so passwords stay out of git:
    broker_url: pyamqp://camera:${QA_CELERY_PASSWORD}@qaboard:5672/camera
  Unknown variables are left as they are. Without the runner's own settings (QABOARD_SETTINGS).
  """
  settings = {k: v for k, v in ((config or {}).get('runners', {}).get('celery') or {}).items() if k not in QABOARD_SETTINGS}
  for key, value in settings.items():
    if isinstance(value, str) and (key.endswith('_url') or key == 'result_backend'):
      settings[key] = os.path.expandvars(value)
  return settings
