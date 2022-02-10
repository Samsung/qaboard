---
id: jenkins-integration
title: Using jenkins as a task runner
sidebar_label: Jenkins Integration
---

[Jenkins](https://www.jenkins.io/) can be used a distributed task queue. It's not pretty, but it can work...

## Creating a Build Job that `qa` will use
1. QA-Board needs to be [setup](deploy) with the ENV variable `JENKINS_AUTH`, in order to communicate with jenkins.
2. Create a Build Job configured with:
  * Enable "Trigger builds remotely", note the token
  * Parametrized: **task** should be a String parameter that gets a command to run
  * Build > "Execute Windows Batch command"

```
# if you need to make sure shared drive are available...
net use \\netapp\algo_data
net use \\netapp\raid
net use \\mars\stage\jenkins_ws
net use \\mars\stage\algo_jenkins_ws
net use \\mars\raid

@echo "%task%"
"%task%"" 
```


3. _qaboard.yaml_ needs to be configured with something like:
```yaml
runners:
  jenkins:
    build_url: http://jenmaster1:8080/job/ALGO/job/WindowsExecutor
    token: "1234"
```

## How to use this runner?
Multiple options:
- On the CLI: `qa batch --runner=windows`
- In our YAML files defining batches:
```yaml
my-batch:
  runner: windows
  inputs:
  - my/images/
  configurations: [base, delta]
```
