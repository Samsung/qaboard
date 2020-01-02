import React from "react";
import axios from "axios";

import {
    Intent,
    MenuItem,
    MenuDivider,
    Tag,
    Tooltip,
    Toaster,
} from "@blueprintjs/core";

import { make_eval_templates_recursively } from '../utils';

export const toaster = Toaster.create();
  
// TODO:
// Today we support integrations with
// - links
// - webhooks
// - gitlabCI jobs
// - jenkins builds
// In the future, to support more, we should refactor this code.
// It looks like we can easily into a class/functions with
//   .props.integration: what's in qatools.yaml
//   .state.status:
//           Today we rely on
//           - status.error / status.loading
//           - status.job.web_url for logs
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



class IntegrationsMenus extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
          integrations: {}
        }
      }
    
    trigger = integration => e => {
        const { project, project_data={}, commit={} } = this.props;
        if (!!integration.webhook || !!integration.gitlabCI || !!integration.jenkins) {
          this.setState({
            integrations: {
              ...this.state.integrations,
              [integration.text]: {loading: true},
            }
          });
          if (integration.webhook) {
            var url = '/api/v1/webhook/proxy/';
            var params = integration.webhook;
          } else if (integration.gitlabCI) {
            url = '/api/v1/gitlab/job/play/';
            const git = (project_data.data || {}).git || {};
            if (!git.web_url) {
              this.setState({
                integrations: {
                  ...this.state.integrations,
                  [integration.text]: {
                    is_loaded: true, loading: false,
                    error: "Can't find gitlab host",
                    statusText: 'ERROR',
                  },
                }
              });
              return;
            }
            params = {
              project_id: project,
              commit_id: commit.id,
              gitlab_host: git.web_url.split('/').slice(0,3).join('/'),
              ...integration.gitlabCI,
            }
          } else if (integration.jenkins) {
            url = '/api/v1/jenkins/build/trigger/';
            params = {
              project_id: project,
              commit_id: commit.id,
              ...integration.jenkins,
            }
    
          }
          axios.post(url, params)
            .then(response => {
                console.log(response)
                toaster.show({
                  message: `Trigger sent! [${response.status} ${response.statusText}]`,
                  intent: Intent.SUCCESS,
                });
                this.setState({
                  integrations: {
                    ...this.state.integrations,
                    [integration.text]: {
                      is_loaded: true,
                      loading: false,
                      error: null,
                      statusText: response.statusText,
                      ...((integration.gitlabCI || integration.jenkins) ? {job: response.data} : {}),
                    },
                  }
                });
              })
              .catch(error => {
                console.log(error.response)
                toaster.show({
                  message: `Something wrong happened: ${JSON.stringify(error.response)}`,
                  intent: Intent.DANGER,
                });
                this.setState({
                  integrations: {
                    ...this.state.integrations,
                    [integration.text]: {is_loaded: true, loading: false, error, statusText: error.response.statusText},
                  }
                });
              }); 
        }
    }
    
    stopUpdateIntegrationStatuses = () => {
      clearInterval(this.state.intervalId);
    }
    startUpdateIntegrationStatuses = () => {
      this.stopUpdateIntegrationStatuses();
      this.setState({
        intervalId: setInterval(this.updateIntegrationStatuses, 3000),
      })
    }
    componentWillUnmount = function() {
      this.stopUpdateIntegrationStatuses()
    }
   
    updateIntegrationStatuses = () => {
        const { project, project_data={}, commit, user } = this.props;
        const eval_templates_recusively = make_eval_templates_recursively({project, project_data, commit, user})
        // const integrations = commit_qatools_config.integrations || project_qatools_config.integrations || [];
        const integrations = default_integrations; // FIXME comment-out
        integrations.filter(i => i.href !== undefined || i.gitlabCI || i.jenkins).forEach(integration => {
          integration = eval_templates_recusively(integration)
          const status = this.state.integrations[integration.text] || {};
          if (integration.jenkins && (status.job || {}).web_url === undefined)
            return
          // Note: For updates we don't want to be "loading" and disable the menuItem button
          //  console.log(integration.text, integration)
           const { label, icon, text, href, style, ignore_failure, gitlabCI, jenkins, ...request } = integration;
           if (gitlabCI) {
            var req_url = '/api/v1/gitlab/job/';
            const git = (project_data.data || {}).git || {};
            if (!git.web_url) {
              this.setState({
                integrations: {
                  ...this.state.integrations,
                  [integration.text]: {
                    is_loaded: true, loading: false,
                    error: "Can't find gitlab host",
                    statusText: 'ERROR',
                  },
                }
              });
              return;
            }
            var params = {
              project_id: this.props.project,
              gitlab_host: git.web_url.split('/').slice(0,3).join('/'),
              job_id: (status.job || {}).id,
              ...gitlabCI,
            }
          } else if (jenkins) {
            req_url = '/api/v1/jenkins/build/';
            params = {
              web_url: ((status || {}).job || {}).web_url,
            }
            // console.log(this.state.integrations[integration.text])
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
                console.log("[update]", response)
                this.setState({
                  integrations: {
                    ...this.state.integrations,
                    [integration.text]: {
                      ...this.state.integrations[integration.text],
                      is_loaded: true,
                      loading: false,
                      error: null,
                      ...((gitlabCI || jenkins) ? {job: response.data} : {})
                    },
                  }
                });
              })
              .catch(error => {
                console.log("[update] Error:", error.response)
                this.setState({
                  integrations: {
                    ...this.state.integrations,
                    [integration.text]: {
                      ...this.state.integrations[integration.text],
                      is_loaded: true,
                      loading: false,
                      error: !!ignore_failure ? null : error,
                      statusText: !!error.response ? error.response.statusText : "Network Error",
                    },
                  }
                });
              });
        })
    }

    render() {
        const { project, project_data={}, commit={}, user } = this.props;
        const qatools_integrations = default_integrations; // FIXME comment-out
        // const qatools_integrations = commit_qatools_config.integrations || project_qatools_config.integrations || [];
        // console.log(qatools_integrations)
    
        const eval_templates_recusively = make_eval_templates_recursively({project, project_data, commit, user})
        return <MenuItem
                icon="send-to"
                text="Actions & Links"
                popoverProps={{
                  usePortal: true,
                  hoverCloseDelay: 1000,
                  transitionDuration: 1000,
                  onOpening: this.startUpdateIntegrationStatuses,
                  onClosed: this.stopUpdateIntegrationStatuses,
                }}>
        {(qatools_integrations.length > 0)
        ? 
          qatools_integrations.map( (integration, idx) => {
            integration = eval_templates_recusively(integration)
            if (integration.divider) {
              return <MenuDivider key={idx} {...integration}/>
            }
            let status = this.state.integrations[integration.text];
            let was_triggered = !!status && (status.loading || !!status.error);
            let disabled = (integration.disabled || was_triggered) && (!!!status || !!!status.error);
            // console.log(integration.text, status, was_triggered)

            if (integration.gitlabCI || integration.jenkins) {
              // console.log(status)
              let has_error = !!status && !!status.error
              let label = has_error ? <Tooltip>
                                        <Tag round icon="cross" intent="danger"/>
                                        <span>{JSON.stringify(status.error.message)}</span>
                                      </Tooltip>
                                    : <JobTag job={(status || {}).job}/>
              return <MenuItem
                key={idx}
                tagName='div'
                shouldDismissPopover={false}
                icon={(was_triggered || !!((status || {}).job || {}).web_url ) ? 'repeat' : 'play'}
                {...integration}
                gitlabCI={undefined}
                jenkins={undefined}
                label={label}
                onClick={this.trigger(integration)}
                disabled={disabled}
               />
            }

            let show_status = !!status && !!status.statusText
            let right_label = show_status ? `${!!integration.label ? integration.label : ''} [${status.statusText}]`
                                          : integration.label;
            if (!!integration.href)
              return <MenuItem key={idx} disabled={disabled} {...integration} target="_blank" label={right_label}/>
            return <MenuItem
              key={idx}
              shouldDismissPopover={false}
              {...integration}
              disabled={disabled}
              label={right_label}
              onClick={this.trigger(integration)}
            />
          })
        : <MenuItem icon="info-sign" target="_blank"  href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs/triggering-third-party-tools`} text="Click to learn how to link to docs/artifacts, or trigger webhooks and GitlabCI/jenkins jobs..."/>
        }
      </MenuItem>
    }
}



// A status tag for job: {status, allow_failure} like jenkins or gitlabCI.
// Reference:
// - gitlabCI statuses: https://docs.gitlab.com/ee/api/jobs.html#list-project-jobs
// - jenkins statuses:  https://javadoc.jenkins-ci.org/hudson/model/Result.html
const JobTag = ({job}) => {
  if (job === undefined || job === null) {
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
  }
  const { status, allow_failure } = job;
  return <Tooltip>
    <a href={job.web_url} target="_blank"  rel="noopener noreferrer"><Tag
      round
      onClick={e => {e.stopPropagation(); console.log('log....')}}
      minimal
      interactive
      {...make_props(status, allow_failure)} >
    </Tag></a>
    <span><Tag>{status}</Tag> Click to see more...</span>
  </Tooltip>
}


export { IntegrationsMenus };


// For debugging
const default_integrations = [
    {
      divider: true,
      title: 'Build',
    },
    {
      text: 'Play Gitlab Manual Job',
      gitlabCI: {
        job_name: "chart-report",
        commit_id: "9ce4c8a6",
        project_id: "tof/swip_tof",
      }
    },
    {
      text: 'Jenkins build',
      jenkins: {
        build_url: "http://jensirc:8080/job/CDE_Project_Static",
        params: {
          project_name: "CIS",
          branch: "${commit.branch}",
          commit: '${commit.id}',
        }
      }
    },
    {
      text: 'Windows',
      icon: 'build',
      // when triggered, gives a way to check the status
      //status: {
      //  // ? maybe sh
      //}
      webhook: {
        url: 'http://jensirc:8080/job/CDE_Project_DLL/buildWithParameters',
        method: 'post',
        auth: {
          username: 'arthurf',
          password: '11089462c1273c2e5dc3f2746f03578bc5',
        },
        headers: {
          'Jenkins-Crumb': 'c762b20d61bd34c5fd8e49ad6637a8a1',
        },
        params: {
          token: 'qatools',
          project_name: 'CIS',
          branch: '${commit.branch}',
          cause: 'Triggered via the QA app'
        }
        // success: {**webhook_others, matches: /200: OK/ }
      }
    },
    {
      text: 'EXE',
      icon: 'download',
      label: 'Windows',
      href: '${commit.repo_commit_dir_url}/${project_parts.slice(-1)}/${project_parts[2]}/${subproject_parts[0]}/build/bin/',
    },
    // {
    //   text: 'EXE',
    //   icon: 'download',
    //   label: 'Windows',
    //   href: '${commit.commit_dir_url}/build/bin',
    // },
    // {
    //   divider: true,
    //   title: 'Docs',
    // },
    // {
    //   text: 'Generate',
    //   icon: 'build',
    // },
    // {
    //   text: 'View',
    //   icon: 'book',
    //   label: 'link',
    //   href: 'http://example.com/docs',
    // },
    // {
    //   divider: true,
    // },
    // {
    //   text: 'Publish',
    //   intent: 'warning',
    //   icon: 'upload',
    // },
  ]
