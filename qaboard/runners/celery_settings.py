"""The project's Celery settings (qaboard.yaml's runners.celery), without importing Celery"""
import os
from typing import Any, Dict


def celery_settings(config: Dict) -> Dict[str, Any]:
  """
  qaboard.yaml's runners.celery, with environment variables expanded in its URLs, so passwords stay out of git:
    broker_url: pyamqp://camera:${QA_CELERY_PASSWORD}@qaboard:5672/camera
  Unknown variables are left as they are.
  """
  settings = dict((config or {}).get('runners', {}).get('celery') or {})
  for key, value in settings.items():
    if isinstance(value, str) and (key.endswith('_url') or key == 'result_backend'):
      settings[key] = os.path.expandvars(value)
  return settings
