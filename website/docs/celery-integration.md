---
id: celery-integration
title: Using celery as a task runner
sidebar_label: Celery Integration
---

[Celery](http://docs.celeryproject.org/en/latest/index.html) is a simple, flexible, and reliable distributed task queue.


## Starting Celery workers
1. To manage the task queue we'll need what they call a *broker*. It's easy to start one:

```bash
docker run --detach -p 5672:5672 rabbitmq
#=> runs in the backgroud, stays alive
```

2. Next you need to start at least a *worker* that will execute async tasks:

```bash
pip install celery
celery -A qaboard.runners.celery_app worker --loglevel=info
```

3. Next, use QA-Board's Celery runner:

```bash
qa batch --runner=celery my-batch
```

## Configuring Celery
To configure Celery at the **project level**:

```yaml title="qaboard.yaml"
runners:
  default: celery
  celery:
    # Those are the default settings:
    broker_url: pyamqp://guest@localhost//  # also read from ENV vars with CELERY_BROKER_URL
    result_backend: rpc://                  # also read from ENV vars with CELERY_RESULT_BACKEND
    # To know all the options and tweak priorities, rate-limiting... Read:
    # http://docs.celeryproject.org/en/latest/getting-started/first-steps-with-celery.html#configuration
    # http://docs.celeryproject.org/en/latest/userguide/configuration.html#configuration
    # For example:
    timezone: Europe/Paris

    # By default tasks will be named "qaboard" unless you define
    qaboard_task_name: qaboard
```

It's often useful to give **batches** their own settings. For instance you may want to use different queues if you manage different types of resources (GPUs, Windows/Linux/Android...):

```bash
# On a server with a GPU:
celery -A qaboard.runners.celery_app worker --concurrency=1 --queues gpu,large-gpu
```

```yaml {7-9} title="qa/batches.yaml"
my-batch-that-needs-a-gpu:
  inputs:
  - my/training/images
  configuration:
  - hyperparams.yaml
  celery:
    task_routes:
      qaboard: gpu
```

:::tip
Read [Celery's tutorial](http://docs.celeryproject.org/en/latest/getting-started/first-steps-with-celery.html)
:::

Celery's [worker user guide](https://docs.celeryproject.org/en/stable/userguide/workers.html) has lots of information on how to run [worker in the background](https://docs.celeryproject.org/en/stable/userguide/daemonizing.html#daemonizing), set [concurrency](https://docs.celeryproject.org/en/stable/userguide/workers.html#concurrency)... Check it out too as needed!

If you need worker monitoring, read the [docs](http://docs.celeryproject.org/en/latest/userguide/monitoring.html).