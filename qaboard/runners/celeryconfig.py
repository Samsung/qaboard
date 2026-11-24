import os
from kombu.serialization import registry, enable_insecure_serializers

registry.enable('pickle')
enable_insecure_serializers()

broker_connection_retry_on_startup=True
# No default: runners.celery.broker_url in qaboard.yaml or $CELERY_BROKER_URL say where the broker is,
# and `qa batch`, `qa doctor` and workers say so when neither does (celery.py's missing_broker)
broker_url=os.environ.get('CELERY_BROKER_URL') or None
result_backend=os.environ.get('CELERY_RESULT_BACKEND', 'rpc://')
task_serializer='pickle'
accept_content=['pickle', 'json', 'application/x-python-serialize']
result_serializer='pickle'
enable_utc=True

# otherwise tasks just show as PENDING
task_track_started=True