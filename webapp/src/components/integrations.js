import React from "react";
import axios from "axios";

import {
    Icon,
    Intent,
    MenuItem,
    MenuDivider,
    Tag,
    Tooltip,
} from "@blueprintjs/core";

import { make_eval_templates_recursively } from '../utils';
import { git_hostname, default_git_hostname } from "../utils"
import { toaster } from "../toaster"

  
// TODO:
// Today we support integrations with
// - links
// - webhooks
// - gitlabCI jobs
// - jenkins builds
// In the future, to support more, we should refactor this code.
// It looks like we can easily into a class/functions with
//   .props.integration: what's in qaboard.yaml
//   .state.status:
//           Today we rely on
//           - status.error / status.loading
//           - status.job.web_url for logs (or status.job.url for the queue URL before a "build" is assigned)
//           - status.job.status for the icon
//   .trigger()
//           Makes an API call to trigger an action
//   .update()
//           Makes an API call to update the status 
//   .render()      // maybe just return MenuItem props (eg icon...), 
//   .renderLabel() // idem


// TODO:
// - The gitlabCI response includes data we could use to improve the tooltip
//     {
//        created_at': '2020-01-01T08:35:34.361Z',
//        'started_at': None,
//        'finished_at': None,
//        'duration': None     // 0.192 (s)
//      }
//     => started/finished Xmin ago, duration: Ymin
// - Same with the jenkins response
//     {
//       timestamp: 1577947320838,
//       duration: 354, //in ms,  ==0 if building..
//       estimatedDuration: 354,
//     }
//     => started/finished Xmin ago, est. Ymin left / duration: Zmin


export const key = integration => (integration.id || integration.text || integration.name || integration.alt)

class IntegrationsMenus extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
          statuses: {}
        }
      }
    
    trigger = integration => e => {
        const { project, project_data={}, commit={} } = this.props;
        const { webhook, gitlabCI, jenkins } = integration;
        if (!webhook && !gitlabCI && !jenkins) {
          return
        }
        this.setState({
          statuses: {
            ...this.state.statuses,
            [key(integration)]: {
              loading: true,
              triggered: true,
              data: undefined,
            },
          }
        });
        if (webhook) {
          var url = '/api/v1/webhook/proxy/';
          var params = webhook;
        } else if (jenkins) {
          url = '/api/v1/jenkins/build/trigger/';
          params = jenkins
        } else if (gitlabCI) {
          url = '/api/v1/gitlab/job/play/';
          const git = project_data.data?.git || {};
          const project_git_hostname = git_hostname(project_data.data?.qatools_config) ?? default_git_hostname
          git.web_url = git.web_url ?? `${project_git_hostname}/${git.path_with_namespace}`
          if (!git.web_url) {
            this.setState({
              statuses: {
                ...this.state.statuses,
                [key(integration)]: {
                  is_loaded: true, loading: false,
                  error: "Can't find gitlab host",
                  statusText: 'ERROR',
                },
              }
            });
            return;
          }
          params = {
            gitlab_host: git.web_url.split('/').slice(0,3).join('/'),
            project_id: project,
            commit_id: commit.id,
            ...gitlabCI,
          }
        }
        axios.post(url, params)
        .then(response => {
            console.log(response)
            toaster.show({
              message: `Webhook sent! [${response.status} ${response.statusText}]`,
              intent: Intent.SUCCESS,
            });
            this.setState({
              statuses: {
                ...this.state.statuses,
                [key(integration)]: {
                  is_loaded: true,
                  loading: false,
                  error: null,
                  statusText: response.statusText,
                  data: response.data,
                },
              }
            });
            if (!!response.data?.url && response.data?.open) {
              window.open(response.data.url, '_blank').focus();
            }
        })
        .catch(error => {
          console.log(error.response ?? error)
          toaster.show({
            message: `Something went wrong: ${JSON.stringify(error.response ?? error)}`,
            intent: Intent.DANGER,
          });
          this.setState({
            statuses: {
              ...this.state.statuses,
              [key(integration)]: {
                is_loaded: true, loading: false, error,
                statusText: error.response?.statusText,
                data: error.response?.data,
              },
            }
          });
        });
    }
    
    stopUpdateIntegrationStatuses = () => {
      clearInterval(this.state.intervalId);
    }
    startUpdateIntegrationStatuses = interval => {
      this.stopUpdateIntegrationStatuses();
      this.updateIntegrationStatuses();
      this.setState({
        intervalId: setInterval(this.updateIntegrationStatuses, interval || 10 * 1000),
      })
    }
    componentDidMount = function() {
      // Not necessary to rush fetching the statuses (?)
      // this.startUpdateIntegrationStatuses(60 * 1000)
    }
    componentWillUnmount = function() {
      this.stopUpdateIntegrationStatuses()
    }
 
    updateIntegrationStatuses = () => {
        const { integrations=[], project_data={}, commit={} } = this.props;
        const eval_templates_recusively = make_eval_templates_recursively(this.props)
        integrations.filter(i => 
          (i.href !== undefined && i.href !== "" && i.src === undefined)
          || i.gitlabCI
          || i.jenkins
        ).forEach(integration => {
          try {
            integration = eval_templates_recusively(integration)
          } catch {
            return;
          }
          if (!integration) {
            return;
          }
          const status = this.state.statuses[key(integration)] || {};
          if (status.loading)
            return
          if (integration.jenkins && status.data?.web_url === undefined && status.data?.url === undefined)
            return
          this.setState({
            statuses: {
              ...this.state.statuses,
              [key(integration)]: {
                ...this.state.statuses[key(integration)],
                loading: true,
              },
            }
          });
          //  console.log(integration.text, integration)
           const { label, icon, text, href, alt, style, ignore_failure, gitlabCI, jenkins, ...request } = integration;
           if (gitlabCI) {
            if (status?.triggered !== true)
              return
            var req_url = '/api/v1/gitlab/job/';
            const git = project_data.data?.git || {};
            if (!git.web_url) {
              this.setState({
                statuses: {
                  ...this.state.statuses,
                  [key(integration)]: {
                    is_loaded: true,
                    loading: false,
                    error: "Can't find gitlab host",
                    statusText: 'ERROR',
                  },
                }
              });
              return;
            }
            var params = {
              gitlab_host: git.web_url.split('/').slice(0,3).join('/'),
              project_id: this.props.project,
              commit_id: commit.id,
              job_id: status.data?.id,
              ...gitlabCI,
            }
          } else if (jenkins) {
            if (status?.triggered !== true)
              return
            req_url = '/api/v1/jenkins/build/';
            params = {
              ...status?.data, //.web_url, .url
            }
            // console.log(this.state.statuses[key(integration)])
          } else { // webhook
            req_url = '/api/v1/webhook/proxy/';
            params = {
              method: 'HEAD',
              url: integration.href.startsWith('/') ? `${window.location.origin}${integration.href}`: integration.href,
              ...request
            };
          }
          // console.log(req_url, params)
          axios.post(req_url, params)
            .then(response => {
                // console.log("[update]", response)
                this.setState({
                  statuses: {
                    ...this.state.statuses,
                    [key(integration)]: {
                      ...this.state.statuses[key(integration)],
                      is_loaded: true,
                      loading: false,
                      error: null,
                      statusText: null,
                      data: response.data,
                    },
                  }
                });
              })
              .catch(error => {
                const statusText = !!error.response ? error.response.statusText : "Network Error"
                console.log("[update] Error:", error.response)
                this.setState({
                  statuses: {
                    ...this.state.statuses,
                    [key(integration)]: {
                      ...this.state.statuses[key(integration)],
                      is_loaded: true,
                      loading: false,
                      error: (!!ignore_failure || statusText.includes("METHOD NOT ALLOWED")) ? null : error,
                      statusText,
                      data: error.response?.data,
                    },
                  }
                });
              });
        })
    }

    render() {
        const { integrations, level=0 } = this.props;
        const eval_templates_recusively = make_eval_templates_recursively(this.props)

        const render_integration = (integration, idx) => {
          try {
            integration = eval_templates_recusively(integration)
          } catch(e) {
            // console.log('error with integration', integration, e)
            return <span key={idx}/>;
          }
          if (!integration) {
            // console.log('undef integration', integration)
            return <span key={idx}/>;
          }
          // console.log('good', integration)
          if (integration.divider) {
            return <MenuDivider key={idx} {...integration}/>
          }
          let status = this.state.statuses[key(integration)];
          let first_loading = !!status && (status.loading && !status.is_loaded);
          let trigger_loading = !!status && (status.loading && status.triggered);
          let has_error = !!status && !!status.error
          let disabled = !integration.src && (integration.disabled || first_loading || (has_error && !integration.allow_failed) || trigger_loading);
          // console.log(key(integration), integration, status, "first_loading", first_loading, "disabled", disabled, "trigger_loading", trigger_loading)

          // TODO: always show the JobTag if "status.data" has some info
          if (integration.gitlabCI || integration.jenkins) {
            // console.log(status)
            let label = has_error ? <Tooltip content={<span>{JSON.stringify(status.error.message)}</span>}>
                                      <Tag round icon="cross" intent="danger"/>
                                    </Tooltip>
                                  : <StatusTag integration={integration} status={status}/>
            return <MenuItem
              key={idx}
              tagName='div'
              shouldDismissPopover={false}
              icon={( (!!status?.data?.web_url || !!status?.data?.url) && status.data.status !== 'manual') ? 'repeat' : 'play'}
              {...integration}
              gitlabCI={undefined}
              jenkins={undefined}
              label={label}
              onClick={this.trigger(integration)}
              disabled={disabled}
            />
          }

          const badge = integration.src && <img
            alt={integration.alt || key(integration)}
            src={encodeURI(`/api/v1/gitlab/proxy?url=${integration.src}`)}
          />
          if (badge) {
            var right_label = integration.icon && <Icon icon={integration.icon}/>
          } else {
            if (integration.webhook) {
              right_label = <StatusTag integration={integration} status={status}/>
            } else {
              right_label = !!integration.label ? integration.label : ''
              if (has_error) {
                right_label = <span>{right_label}<StatusTag integration={integration} status={status}/></span>
              }
            }
          }
          return <MenuItem
              key={idx}
              shouldDismissPopover={!!integration.href}
              {...integration}
              disabled={disabled}
              icon={badge || integration.icon}
              label={right_label}
              target={!!integration.href ? "_blank" : undefined}
              onClick={!!!integration.href ? this.trigger(integration) : undefined}
            >
              {integration.sub && <IntegrationsMenus {...this.props} integrations={integration.sub} level={level+1} />}
          </MenuItem>
        }

        const integrations_in_menu = integrations.filter(i => i?.in_menu !== false);
        const integrations_outside_menu = integrations.filter(i => i?.in_menu === false || level > 0);
        return <>
          {integrations_outside_menu.map(render_integration)}
          {level === 0 && <MenuItem
            icon="send-to"
            text="Actions & Links"
            popoverProps={{
              usePortal: true,
              hoverCloseDelay: 1000,
              transitionDuration: 1000,
              onOpening: () => {this.startUpdateIntegrationStatuses(5000)},
              onClosed: this.stopUpdateIntegrationStatuses,
            }}
          >
            {integrations_in_menu.map(render_integration)}
            {integrations_in_menu.length === 0 && <>
                <MenuDivider />
                <MenuItem
                    icon="info-sign"
                    target="_blank"
                    href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs/triggering-third-party-tools`}
                    text="Click to learn how to link to docs/artifacts, or trigger webhooks and GitlabCI/jenkins jobs..."
                />
            </>}
          </MenuItem>}
        </>;
  }
}



// A status tag for job: {status, allow_failure} like jenkins or gitlabCI.
// Reference:
// - gitlabCI statuses: https://docs.gitlab.com/ee/api/jobs.html#list-project-jobs
// - jenkins statuses:  https://javadoc.jenkins-ci.org/hudson/model/Result.html
const StatusTag = ({status}) => {
  if (status === undefined || status === null) {
    return <span></span>;
  }

  const make_props = (status, allow_failure) => {
    if (status === 'created')
      return {icon: 'flash', intent: 'warning'}
    if (status === 'pending' || status === 'BLOCKED' || status === 'STUCK' )
      return {icon: 'pause', intent: 'warning'}
    if (status === 'running')
      return {icon: 'walk', intent: 'primary'}
    if (status === 'failed') {
      return {
        icon: allow_failure ? 'issue' : 'cross',
        intent: allow_failure ? 'warning' : 'danger',
      } 
    }
    if (status === 'success')
      return {icon: 'tick', intent: 'success'}
    if (status === 'canceled' || status === 'ABORTED')
      return {icon: 'disable'}
    if (status === 'skipped' || status === 'NOT_BUILT')
      return {icon: 'fast-forward'}
    if (status === 'manual')
      return {icon: 'cog'}
    if (status === 'UNSTABLE')
      return {icon: 'cog', intent: 'warning'}
    return {}
  }
  console.log(status)
  const { data={}, allow_failure, statusText, error } = status;
  let tag_props = {...make_props(data.status, allow_failure)}
  if (data.status === undefined && statusText) {
    tag_props.intent = !!error ? Intent.DANGER : Intent.SUCCESS
    tag_props.icon = !!error ? "cross" : "tick"
  }
  const tag = <Tag
    round
    onClick={e => {e.stopPropagation()}}
    minimal
    interactive
    {...tag_props}
    >
      {!data.status && statusText}
  </Tag>
  const url = data.url ?? data.web_url
  return <Tooltip content={JSON.stringify(data)}>
    <>
      {url && <a href={url.replace("/api/json", "")} target="_blank"  rel="noopener noreferrer">
        {tag}
      </a>}
      {!url && tag}
    </>
  </Tooltip>
}

/*eslint no-template-curly-in-string: "off"*/
const default_gitlab_integrations = [
  {
    href: "${git.web_url}/commits/${branch}",
    alt: "Build status",
    src: "${git.web_url}/badges/${branch}/pipeline.svg",
    only: "${branch}" // won't be displayed in per-commit pages
  },
  {
    href: "${git.web_url}/commits/${branch}",
    alt: "Coverage",
    src: "${git.web_url}/badges/${branch}/coverage.svg",
    only: "${branch}" // won't be displayed in per-commit pages
  }, 
]


export { IntegrationsMenus, default_gitlab_integrations };

