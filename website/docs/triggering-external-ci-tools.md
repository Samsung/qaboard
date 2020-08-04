---
id: triggering-third-party-tools
title: Triggering CI and third-party tools via the web application
sidebar_label: Triggering External Tools
---
import useBaseUrl from '@docusaurus/useBaseUrl';

You often want to integrate various tools into your workflow, or show [status badges](https://shields.io/index.html). QA-Board lets you connect to those third-party tools on each commit's page and on commit index pages:

<img alt="Allowing triggered build" src={useBaseUrl('img/ui-triggers.png')} />

:::note
The screenshots are not up-to-date; the menu is now named **"Actions & Links"**
:::



## Adding badges and external links
Configure your project's *qaboard.yaml* like so to display direct links to docs, build artifacts, coverage reports, etc:

```yaml title="qaboard.yaml"
integrations:
- text: Docs
  href: http://my-project/docs

- src: https://gitlab.com/my/project/badges/develop/coverage.svg
  href: http://my-project/docs
  alt: Coverage Report
```

:::tip
The menu item will be disabled if the link doesn't work.
To show a link but run the check on an other URL, you can provide `url`, `method` (POST..), etc. If you add `allow_failed: true` the link is always enabled.
:::

## Play GitlabCI manual jobs
Configure your project with:
```yaml title="qaboard.yaml"
integrations:
  - text: Gitlab Job
    gitlabCI:
      job_name: build-linux
```
<img alt="jenkins-and-gitlab-integrations" src={useBaseUrl('img/gitlab-jenkins.gif')} />

  ## Trigger Jenkins builds
```yaml title="qaboard.yaml"
integrations:
  - text: Jenkins Triggered Build
    jenkins:
      build_url: $JENKINS_URL/job/CDE_Project_Linux
      parameters:
        commit: "${commit.id}"
```

## Using webhooks
You can use webhooks to trigger a variety of external tools:

```yaml
integrations:
  - text: Jenkins Triggered Build
    webhook:
    - text: 'Windows',
      icon: build
      webhook:
      # all the options are send straight to the axios http library. For reference:
      # https://github.com/axios/axios#axios-api
      -  url: "https://my-application/${project}"
         method: POST
         data:
           branch: "${commit.branch}"
```

## Using variables
You can use some special variables in your strings with some `${VARIABLE}` templating:
- **Commit**: `commit.id`, `commit.branch`, `commit.branch_slug`... Also `branch`.
- **Project**: `project` (full project name), `subproject` (project name relative to the root project), 
- [**Git** repository data](https://docs.gitlab.com/ee/user/project/integrations/webhooks.html#push-event) with `git`: eg `git.default_branch`... 
- **Artifacts** are saved under `commit.artifacts_url = commit.repo_artifacts_url / subproject`.
- **Outputs** are saved under `commit.outputs_url`
- [etc](https://github.com/Samsung/qaboard/blob/master/webapp/src/utils.js#L303)

:::tip
If you use use `${branch}` in any of the fields, the integration will only appear on project/branch pages. You can add a dummy `only: {branch}`.
:::



## Styling the integrations
Optionnaly you can style each menu item:
```yaml
integrations:
  - text: Styled Integration
    # Full list of icons: https://blueprintjs.com/docs/#icons
    icon: build
    # Full list of options: https://blueprintjs.com/docs/#core/components/menu
    label: docs
    disabled: false
    intent: danger
```

You can add dividers to group integration:
```yaml
integrations:
  # --snip--
  - divider: true
    title: Section Title
  # --snip--
```

## Example: Jenkins integration via Webhooks
:::caution
The out-of-the-box jenkins integration above is much better! This is just an example with webhooks!
:::

1. If you don't have one, [get an API token](https://stackoverflow.com/questions/45466090/how-to-get-the-api-token-for-jenkins) for your user

```bash
$JENKINS_URL/me/descriptorByName/jenkins.security.ApiTokenProperty/generateNewToken
# Enter "OK to retry using POST" and get the "tokenValue"
```

:::caution
Since you'll commit those credentials with the code, make sure you don't have too many privileges... At some point QA-Board will support *secrets*. 
:::

2. Get a crumb to handle [Jenkins' CSRF](https://support.cloudbees.com/hc/en-us/articles/219257077-CSRF-Protection-Explained), eg at *$JENKINS_URL/crumbIssuer/api/xml?xpath=concat(//crumbRequestField,%22:%22,//crumb)*

3. Go to your Jenkins project configuration page at *$JENKINS_URL/$PROJECT/configure* and allow triggered builds:
<img alt="Allowing triggered build" src={useBaseUrl('img/configure-jenkins-build-triggers.png')} />

4. Configure your project with:

```yaml title="qaboard.yaml"
integrations:
  - name: Jenkins Triggered Build
    webhook:
      method: post
      url: $JENKINS_URL/job/$PROJECT/buildWithParameters
      headers:
        Jenkins-Crumb: $JenkinsCrumb
      params:
        token: $TOKEN
      auth: {
        username: $username
        password: api-token    # keep as-is
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
    href: $JENKINS_URL/view/HW_ALG/job/HW_ALG-delivery/build?delay=0sec
    # Jenkins behaves wtf and returns 405 errors...
    # https://issues.jenkins-ci.org/browse/JENKINS-3121
    ignore_failure: true
```
