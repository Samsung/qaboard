import React from "react";

import {
    Icon,
    Intent,
    MenuItem,
    MenuDivider,
    Tag,
    Tooltip,
    InputGroup,
} from "@blueprintjs/core";

import { make_eval_templates_recursively } from '../utils';

  
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
            searchQuery: ''
        };
    }

    handleSearchChange = (e) => {
        this.setState({ searchQuery: e.target.value });
    }

    filterIntegrations = (integrations, searchQuery) => {
        if (!searchQuery.trim()) {
            return integrations;
        }
        
        const query = searchQuery.toLowerCase();
        
        const filterRecursively = (items) => {
            const filtered = [];
            let currentSection = [];
            let currentDivider = null;
            
            for (const integration of items) {
                if (integration.divider) {
                    // If we have a previous section with matches, add the divider and items
                    if (currentSection.length > 0) {
                        if (currentDivider) {
                            filtered.push(currentDivider);
                        }
                        filtered.push(...currentSection);
                    }
                    // Start new section
                    currentDivider = integration;
                    currentSection = [];
                } else {
                    const searchableText = [
                        integration.text,
                        integration.name,
                        integration.label,
                        integration.alt,
                        integration.id
                    ].filter(Boolean).join(' ').toLowerCase();
                    
                    const matchesSearch = searchableText.includes(query);
                    
                    // Check if any sub-items match
                    let hasMatchingSubItems = false;
                    let filteredSubItems = [];
                    if (integration.sub && integration.sub.length > 0) {
                        filteredSubItems = filterRecursively(integration.sub);
                        hasMatchingSubItems = filteredSubItems.length > 0;
                    }
                    
                    // Include this integration if it matches or has matching sub-items
                    if (matchesSearch || hasMatchingSubItems) {
                        const filteredIntegration = { ...integration };
                        if (filteredSubItems.length > 0) {
                            filteredIntegration.sub = filteredSubItems;
                        }
                        currentSection.push(filteredIntegration);
                    }
                }
            }
            
            // Handle the last section
            if (currentSection.length > 0) {
                if (currentDivider) {
                    filtered.push(currentDivider);
                }
                filtered.push(...currentSection);
            }
            
            return filtered;
        };
        
        return filterRecursively(integrations);
    }

    render() {
        const { integrations, level=0, integrationStatuses={}, triggerIntegration, startUpdateIntegrationStatuses, stopUpdateIntegrationStatuses } = this.props;
        const eval_templates_recusively = make_eval_templates_recursively(this.props)
        const { searchQuery } = this.state;

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
          let status = integrationStatuses[key(integration)];
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
              onClick={triggerIntegration(integration)}
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
              onClick={!!!integration.href ? triggerIntegration(integration) : undefined}
            >
              {integration.sub && <IntegrationsMenus {...this.props} integrations={integration.sub} level={level+1} />}
          </MenuItem>
        }

        const integrations_in_menu = integrations.filter(i => i?.in_menu !== false);
        const integrations_outside_menu = integrations.filter(i => i?.in_menu === false || level > 0);
        
        // Apply search filtering only to top-level menu items
        const filtered_integrations_in_menu = level === 0 ? this.filterIntegrations(integrations_in_menu, searchQuery) : integrations_in_menu;

        return <>
          {integrations_outside_menu.map(render_integration)}
          {level === 0 && <MenuItem
            icon="send-to"
            text="Integrations"
            popoverProps={{
              usePortal: true,
              hoverCloseDelay: 2000,
              transitionDuration: 1000,
              onOpening: () => {startUpdateIntegrationStatuses && startUpdateIntegrationStatuses(5000)},
              onClosed: stopUpdateIntegrationStatuses,
              // Prevent closing when interacting with search input
              interactionKind: "hover",
              hasBackdrop: false,
              canEscapeKeyClose: true,
              enforceFocus: false,
              autoFocus: false,
            }}
          >
            {integrations_in_menu.length > 5 && (
              <div 
                style={{ 
                  padding: '8px', 
                  borderBottom: '1px solid #ccc', 
                  marginBottom: '4px',
                  position: 'sticky',
                  top: 0,
                  backgroundColor: '#30404d',
                  zIndex: 1000
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <InputGroup
                  leftIcon="search"
                  placeholder="Search integrations..."
                  value={searchQuery}
                  onChange={this.handleSearchChange}
                  small
                  fill
                  onFocus={(e) => e.stopPropagation()}
                  onBlur={(e) => e.stopPropagation()}
                />
              </div>
            )}
            <div style={{ minHeight: searchQuery ? '200px' : 'auto' }}>
              {filtered_integrations_in_menu.map(render_integration)}
              {filtered_integrations_in_menu.length === 0 && searchQuery && (
                <MenuItem 
                  icon="search" 
                  text={`No integrations found for "${searchQuery}"`}
                  disabled
                />
              )}
            </div>
            {integrations_in_menu.length === 0 && <>
                <MenuDivider />
                <MenuItem
                    icon="info-sign"
                    target="_blank"
                    href={`${this.props.docs_root}docs/triggering-third-party-tools`}
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

