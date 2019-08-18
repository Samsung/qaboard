---
id: triggering-third-party-tools
title: Triggering CI and third-party tools via the web application
sidebar_label: Triggering External Tools
---

You often want to integrate various tools into your workflow. `qatools`'s web application can easily connect to third-party tools:

![Allowing triggered build](https://qa/s/qatools/img/ui-triggers.png)

## Adding external links
Configure your project's *qatools.yaml*:

```yaml
integrations:
  - name: Jenkins Triggered Build
    href: http://my-project/docs
```

> You can link directly to build artifacts.  The link will be disabled if the link doesn't work. To show a link but run the check on something else, also provide `url`, `method`, etc.

## Using webhooks to trigger external tools
Configure your project's *qatools.yaml*:

```yaml
integrations:
  - name: Jenkins Triggered Build
    webhook:
    - text: 'Windows',
      icon: build
      webhook:
      # all the options are send straight to the axios http library. For reference:
      # https://github.com/axios/axios#axios-api
      -  url: "http://jensirc:8080/${project}"
         method: post
         data:
           branch: "${commit.branch}"
```

## Using variables
You can use some special variables in your strings with some `${VARIABLE}` templating:
- **Commit** data like `commit.id`, `commit.branch`..
- **Project** data like `project` (full project name), `subproject` (project name relative to the root project), 
- [**Git** repository data](https://docs.gitlab.com/ee/user/project/integrations/webhooks.html#push-event) with `git`, eg `git.default_branch`... 
- **Artifacts** are saved under `commit.commit_dir_url = commit.repo_commit_dir_url / subproject`.
- `user` is the one defined in the tuning tab or the project's default. 

## Styling the list of integrations
Optionnaly you can style each button
```yaml
integrations:
  - name: Styled Integration
    # https://blueprintjs.com/docs/#icons
    icon: build
    # For the full list of options refer to
    # https://blueprintjs.com/docs/#core/components/menu
    label: docs
    disabled: false
    intent: danger
```

To group integration, you can add dividers:
```yaml
integrations:
  # ...
  - divider: true
    title: Section Title
  # ...
```

## Triggering GitlabCI jobs
https://docs.gitlab.com/ee/ci/triggers/#triggering-a-pipeline-from-a-webhook

## Triggering Jenkins jobs
1. If you don't have one, [get an API token](https://stackoverflow.com/questions/45466090/how-to-get-the-api-token-for-jenkins) for your user

```bash
http://jensirc:8080/me/descriptorByName/jenkins.security.ApiTokenProperty/generateNewToken
# Enter "OK to retry using POST" and get the "tokenValue"
```

:::caution
Since you'll commit those credentials with the code, make sure you don't have too many privileges... At some point qatools will support *secrets*. 
:::

2. Get a crumb to handle [Jenkins' CSRF](https://support.cloudbees.com/hc/en-us/articles/219257077-CSRF-Protection-Explained), eg at *http://jensirc:8080/crumbIssuer/api/xml?xpath=concat(//crumbRequestField,%22:%22,//crumb)*

3. Go to your Jenkins project configuration page at *$JENKINS_URL/$PROJECT/configure* and allow triggered builds:
![Allowing triggered build](https://qa/s/qatools/img/configure-jenkins-build-triggers.png)

4. Configure your project's *qatools.yaml*:

```yaml
integrations:
  - name: Jenkins Triggered Build
    webhook:
      method: post
      url: $JENKINS_URL/job/$PROJECT/buildWithParameters
      headers:
        Jenkins-Crumb: c762b20d61bd34c5fd8e49ad6637a8a2
      params:
        token: $TOKEN
      auth: {
        username: arthurf
        password: api-token
      data:
        commit: "${commit.id}"
        cause: Triggered on the QA web app
```

Alternatively, you can also send users to the build page: 

```yaml
integrations:
  - text: Build
    label: With Parameters
    icon: build
    href: http://jensirc:8080/view/HW_ALG/job/HW_ALG-delivery/build?delay=0sec
    # Jenkins behaves wtf and returns 405 errors...
    # https://issues.jenkins-ci.org/browse/JENKINS-3121
    ignore_failure: true
```