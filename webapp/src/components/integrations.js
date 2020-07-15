import React from "react";
import axios from "axios";

import {
    Icon,
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
          integrations: {}
        }
      }
    
    trigger = integration => e => {
        const { project, project_data={}, commit={} } = this.props;
        if (!!integration.webhook || !!integration.gitlabCI || !!integration.jenkins) {
          this.setState({
            integrations: {
              ...this.state.integrations,
              [key(integration)]: {
                loading: true,
                triggered: true,
              },
            }
          });
          if (integration.webhook) {
            var url = '/api/v1/webhook/proxy/';
            var params = integration.webhook;
          } else if (integration.gitlabCI) {
            url = '/api/v1/gitlab/job/play/';
            const git = project_data.data?.git || {};
            if (!git.web_url) {
              this.setState({
                integrations: {
                  ...this.state.integrations,
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
              ...integration.gitlabCI,
            }
          } else if (integration.jenkins) {
            url = '/api/v1/jenkins/build/trigger/';
            params = {
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
                    [key(integration)]: {
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
                    [key(integration)]: {is_loaded: true, loading: false, error, statusText: error.response.statusText},
                  }
                });
              }); 
        }
    }
    
    stopUpdateIntegrationStatuses = () => {
      clearInterval(this.state.intervalId);
    }
    startUpdateIntegrationStatuses = interval => {
      this.stopUpdateIntegrationStatuses();
      this.setState({
        intervalId: setInterval(this.updateIntegrationStatuses, interval || 10*1000),
      })
    }
    componentDidMount = function() {
      // Not necessary to rush fetching the statuses (?)
      // this.startUpdateIntegrationStatuses(60 * 1000)
    }
    componentWillUnmount = function() {
      this.stopUpdateIntegrationStatuses()
    }

    // componentDidUpdate(prevProps) {
    // }
 
    updateIntegrationStatuses = () => {
        const { project_data={}, commit={} } = this.props;
        const commit_qatools_config = commit.data?.qatools_config || {};
        const project_qatools_config = project_data.data?.qatools_config || {};
        const eval_templates_recusively = make_eval_templates_recursively(this.props)
        // let _integrations = debug_integrations; // FIXME comment-out
        const _integrations = commit_qatools_config.integrations || project_qatools_config.integrations || [];
        let integrations = [...default_gitlab_integrations, ..._integrations]
        integrations = JSON.parse(JSON.stringify(integrations))
        integrations.filter(i => (i.href !== undefined && i.src === undefined) || i.gitlabCI || i.jenkins)
                    .forEach(integration => {
          try {
            integration = eval_templates_recusively(integration)
          } catch {
            return;
          }
          if (!integration) {
            return;
          }
          const status = this.state.integrations[key(integration)] || {};
          if (status.loading)
            return
          if (integration.jenkins && status.job?.web_url === undefined && status.job?.url === undefined)
            return
          this.setState({
            integrations: {
              ...this.state.integrations,
              [key(integration)]: {
                ...this.state.integrations[key(integration)],
                loading: true,
              },
            }
          });
          //  console.log(integration.text, integration)
           const { label, icon, text, href, alt, style, ignore_failure, gitlabCI, jenkins, ...request } = integration;
           if (gitlabCI) {
            var req_url = '/api/v1/gitlab/job/';
            const git = project_data.data?.git || {};
            if (!git.web_url) {
              this.setState({
                integrations: {
                  ...this.state.integrations,
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
              job_id: status.job?.id,
              ...gitlabCI,
            }
          } else if (jenkins) {
            req_url = '/api/v1/jenkins/build/';
            params = {
              ...status?.job, //.web_url, .url
            }
            // console.log(this.state.integrations[key(integration)])
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
                    [key(integration)]: {
                      ...this.state.integrations[key(integration)],
                      is_loaded: true,
                      loading: false,
                      error: null,
                      statusText: null,
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
                    [key(integration)]: {
                      ...this.state.integrations[key(integration)],
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
        const { single_menu, project_data={}, commit={} } = this.props;
        const commit_qatools_config = commit?.data?.qatools_config || {};
        const project_qatools_config = project_data?.data?.qatools_config || {};
        // let _integrations = debug_integrations; // FIXME comment-out
        const _integrations = commit_qatools_config.integrations || project_qatools_config.integrations || [];
        let integrations = [...default_gitlab_integrations, ..._integrations]
        integrations = JSON.parse(JSON.stringify(integrations))
        const uses_default_integrations = true
        // console.log(integrations)
        const eval_templates_recusively = make_eval_templates_recursively(this.props)


        const render_integration = (integration, idx) => {
          try {
            integration = eval_templates_recusively(integration)
          } catch {
            // console.log('error with integration', integration)
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
          let status = this.state.integrations[key(integration)];
          let first_loading = !!status && (status.loading && !status.is_loaded);
          let trigger_loading = !!status && (status.loading && status.triggered);
          let has_error = !!status && !!status.error
          let disabled = !integration.src && ( integration.disabled || first_loading || has_error || trigger_loading);
          // console.log(key(integration), integration, status, "first_loading", first_loading, "disabled", disabled, "trigger_loading", trigger_loading)

          if (integration.gitlabCI || integration.jenkins) {
            // console.log(status)
            let label = has_error ? <Tooltip>
                                      <Tag round icon="cross" intent="danger"/>
                                      <span>{JSON.stringify(status.error.message)}</span>
                                    </Tooltip>
                                  : <JobTag job={status?.job}/>
            return <MenuItem
              key={idx}
              tagName='div'
              shouldDismissPopover={false}
              icon={( (!!status?.job?.web_url || !!status?.job?.url) && status.job.status !== 'manual') ? 'repeat' : 'play'}
              {...integration}
              gitlabCI={undefined}
              jenkins={undefined}
              label={label}
              onClick={this.trigger(integration)}
              disabled={disabled}
              />
          }

          let show_status = !!status && !!status.statusText

          const badge = integration.src && <img
            alt={integration.alt || key(integration)}
            src={integration.src}
          />        
          if (badge) {
            var right_label = integration.icon && <Icon icon={integration.icon}/>
          } else {
            right_label = show_status ? `${!!integration.label ? integration.label : ''} [${status.statusText}]`
                                      : integration.label;
          }
          if (!!integration.href)
            return <MenuItem
                    key={idx}
                    disabled={disabled}
                    {...integration}
                    icon={badge || integration.icon}
                    label={right_label}
                    target="_blank"
                  />
          return <MenuItem
            key={idx}
            shouldDismissPopover={false}
            {...integration}
            icon={badge || integration.icon}
            label={right_label}
            disabled={disabled}
            onClick={this.trigger(integration)}
          />
        }

        const badges = integrations.filter(i => i.src);
        const integrations_in_menu = single_menu ? integrations.filter(i => !i.src) : integrations;
        return <>
          {single_menu && badges.map(render_integration)}
          <MenuItem
                  icon="send-to"
                  text="Actions & Links"
                  popoverProps={{
                    usePortal: true,
                    hoverCloseDelay: 1000,
                    transitionDuration: 1000,
                    onOpening: this.startUpdateIntegrationStatuses,
                    onClosed: this.stopUpdateIntegrationStatuses,
          }}>
            {integrations_in_menu.map(render_integration)}
            {uses_default_integrations && <>
              {integrations_in_menu.length > 0 && <MenuDivider />}
              <MenuItem
                icon="info-sign"
                target="_blank"
                href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs/triggering-third-party-tools`}
                text="Click to learn how to link to docs/artifacts, or trigger webhooks and GitlabCI/jenkins jobs..."
              />
            </>}
            </MenuItem>
        </>;
  }
}



/*
    // TOOD: better defaults..
    let is_gitlab = !!git.web_url; //FIXME..
    if (badges.length === 0 && is_gitlab)
*/


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
    <a href={job.url || job.web_url} target="_blank"  rel="noopener noreferrer"><Tag
      round
      onClick={e => {e.stopPropagation()}}
      minimal
      interactive
      {...make_props(status, allow_failure)} >
    </Tag></a>
    <span><Tag>{status}</Tag> Click to see more...</span>
  </Tooltip>
}


export { IntegrationsMenus };

// For debugging
/*eslint no-template-curly-in-string: "off"*/
const default_gitlab_integrations = [
    {
      href: "${git.web_url}/commits/${branch}",
      alt: "Build status",
      src: "${git.web_url}/badges/${branch}/build.svg",
      only: "${branch}" // won't be displayed in per-commit pages
    },
    {
      href: "${git.web_url}/commits/${branch}",
      alt: "Coverage",
      src: "${git.web_url}/badges/${branch}/coverage.svg",
      only: "${branch}" // won't be displayed in per-commit pages
    }, 
]

/*
const debug_integrations = [
    {
      divider: true,
      title: 'Build',
    },
    {
      text: 'Play Gitlab Manual Job',
      gitlabCI: {
        job_name: "tuning",
        project_id: "LSC/Calibration",
        // job_name: "chart-report",
        // commit_id: "9ce4c8a6",
        // project_id: "tof/swip_tof",
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
*/