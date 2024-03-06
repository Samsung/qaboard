import os
from kombu.serialization import registry, enable_insecure_serializers

registry.enable('pickle')
enable_insecure_serializers()

broker_connection_retry_on_startup=True
broker_url=os.environ.get('CELERY_BROKER_URL', 'pyamqp://guest:guest@qaboard:5672//')
result_backend=os.environ.get('CELERY_RESULT_BACKEND', 'rpc://')
task_serializer='pickle'
accept_content=['pickle', 'json', 'application/x-python-serialize']
result_serializer='pickle'
enable_utc=True

# otherwise tasks just show as PENDING
task_track_started=True