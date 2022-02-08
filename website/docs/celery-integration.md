---
id: celery-integration
title: Using celery as a task runner
sidebar_label: Celery Integration
---

[Celery](http://docs.celeryproject.org/en/latest/index.html) is a simple, flexible, and reliable distributed task queue.


## Starting Celery workers
1. To manage the task queue we'll need what they call a *broker*. The QA-Board server already starts one on port `5672`. If you want to start another one, it's easy:

```bash
docker run --detach -p 5672:5672 rabbitmq
#=> runs in the background
```

2. Next you need to start at least a *worker* that will execute async tasks:

```bash
# need python3
pip install celery qaboard
celery -A qaboard.runners.celery_app worker --concurrency=10 --loglevel=info
```

:::note
Ideally we should run workers as daemons to handle failures, reboots... [Read the docs](https://docs.celeryproject.org/en/stable/userguide/daemonizing.html) to do it nicely... Currently we just use `screen`:

```bash
sudo apt-get install screen
screen -dmS qaboard-worker-01 <celery-command>
```

:::

3. To have `qa batch` use Celery runners, just  configure:

```yaml title="qaboard.yaml"
runners:
  default: celery
  # by default we assume you QA-Board server hostname is qaboard...
  # to change it (for example to "localhost", where QA-Board might be running), define:
  celery:
    broker_url: pyamqp://guest:guest@localhost:5672//  # also read from the ENV variable CELERY_BROKER_URL
```

:::tip
You can choose on the CLI what runner you want: 
```bash
qa batch --runner=celery my-batch
# can be useful to see real-time logs in the CLI...
qa batch --runner=local my-batch
```
:::

Note that unless you have a transparent shared storage for your working directory, you'll need to use `qa --share batch` to see runs in QA-Board...

## Advanced Celery Configuration 
To configure Celery at the **project level**:

```yaml title="qaboard.yaml"
runners:
  default: celery
  celery:
    # assuming your QA-Board server's hostname is qaboard
    broker_url: pyamqp://guest:guest@qaboard:5672//  # also read from ENV vars with CELERY_BROKER_URL
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