// The status of the sidebar's integrations (links, webhooks, GitLab CI jobs, GitHub Actions workflows, Jenkins builds):
// we probe links with HEAD requests, trigger builds and poll their status.
// Statuses of triggered builds are kept in localStorage per commit, so they survive page reloads.
import { useEffect, useRef, useState } from "react";
import { Intent } from "@blueprintjs/core";

import { http, errorMessage } from "./api/http";
import { toaster } from "./toaster";
import { make_eval_templates_recursively } from "./utils";
import { host_url } from "./git";

const LS_PREFIX = 'qaboard:integrationStatuses:';
const LS_INDEX_KEY = 'qaboard:integrationStatuses:index';
const LS_MAX_COMMITS = 50;

const loadIntegrationStatuses = commit_id => {
  if (!commit_id) return {};
  try {
    const raw = localStorage.getItem(LS_PREFIX + commit_id);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Clear stale loading flags, the in-flight request from the previous
    // session is gone and would otherwise block the next poll forever.
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v ? { ...v, loading: false } : v]));
  } catch (e) {
    console.warn('Failed to load integrationStatuses from localStorage', e);
    return {};
  }
};

const saveIntegrationStatuses = (commit_id, statuses) => {
  if (!commit_id) return;
  try {
    // Only persist entries the user actively triggered (Jenkins/gitlabCI/githubActions builds).
    // HEAD-probe results for plain links/artifacts are cheap to recompute on demand.
    const cleaned = {};
    Object.entries(statuses).forEach(([k, status]) => {
      if (!status?.triggered) return;
      const { error, ...rest } = status;
      cleaned[k] = error ? { ...rest, error: true } : rest;
    });
    if (Object.keys(cleaned).length === 0) {
      localStorage.removeItem(LS_PREFIX + commit_id);
      return;
    }
    localStorage.setItem(LS_PREFIX + commit_id, JSON.stringify(cleaned));
    // Update the index, evict the oldest if over the cap
    let index = [];
    try {
      index = JSON.parse(localStorage.getItem(LS_INDEX_KEY) || '[]');
    } catch { index = []; }
    index = index.filter(id => id !== commit_id);
    index.push(commit_id);
    while (index.length > LS_MAX_COMMITS)
      localStorage.removeItem(LS_PREFIX + index.shift());
    localStorage.setItem(LS_INDEX_KEY, JSON.stringify(index));
  } catch (e) {
    console.warn('Failed to save integrationStatuses to localStorage', e);
  }
};

// Prefix carries the parent path so sub-menu items with the same text as a
// sibling elsewhere in the tree don't share a status entry.
export const integration_key = (integration, prefix = '') => prefix + (integration.id || integration.text || integration.name || integration.alt);

// What the backend needs to find the CI jobs of a commit on the project's git host
const gitlab_job = (project, project_data, commit) => ({
  gitlab_host: host_url(project_data),
  project_id: project_data.data?.git?.path_with_namespace ?? project,
  commit_id: commit.id,
});
// The server only starts or reads the workflows of projects users can access, declared in their qaboard.yaml
const github_workflow = (project, project_data, commit) => ({
  project,
  host: host_url(project_data),
  repo: project_data.data?.git?.path_with_namespace ?? project,
  commit_id: commit.id,
  ref: commit.branch?.replace(/^origin\//, ''),
});


// context: {project, project_data, commit, new_batch, integrations, ...template variables}
export function useIntegrationStatuses(context) {
  const commit_id = context.commit?.id;
  const [statuses, setStatuses] = useState(() => loadIntegrationStatuses(commit_id));
  const [statuses_commit, setStatusesCommit] = useState(commit_id);
  // Commit changed: reload from localStorage for the new commit
  if (commit_id !== statuses_commit) {
    setStatusesCommit(commit_id);
    setStatuses(loadIntegrationStatuses(commit_id));
  }
  useEffect(() => {
    if (commit_id && commit_id === statuses_commit) saveIntegrationStatuses(commit_id, statuses);
  }, [commit_id, statuses_commit, statuses]);

  // Polling and requests read the latest values
  const latest = useRef({ context, statuses });
  useEffect(() => { latest.current = { context, statuses } });

  const setStatus = (key, status, { merge = false } = {}) => setStatuses(previous => ({
    ...previous,
    [key]: merge ? { ...previous[key], ...status } : status,
  }));

  const trigger = (integration, key) => () => {
    const { project, project_data = {}, commit = {} } = latest.current.context;
    const { webhook, gitlabCI, githubActions, jenkins } = integration;
    if (!webhook && !gitlabCI && !githubActions && !jenkins) return;
    const entry_key = key ?? integration_key(integration);
    setStatus(entry_key, { loading: true, triggered: true, data: undefined });
    let url, params;
    if (webhook) {
      url = '/api/v1/webhook/proxy/';
      params = webhook;
    } else if (jenkins) {
      url = '/api/v1/jenkins/build/trigger/';
      params = jenkins;
    } else if (githubActions) {
      url = '/api/v1/github/workflow/dispatch/';
      params = { ...github_workflow(project, project_data, commit), ...githubActions };
    } else {
      url = '/api/v1/gitlab/job/play/';
      params = { ...gitlab_job(project, project_data, commit), ...gitlabCI };
    }
    http.post(url, params)
      .then(response => {
        toaster.show({ message: `Webhook sent! [${response.status} ${response.statusText}]`, intent: Intent.SUCCESS });
        setStatus(entry_key, { is_loaded: true, loading: false, triggered: true, error: null, statusText: response.statusText, data: response.data });
        if (!!response.data?.url && response.data?.open)
          window.open(response.data.url, '_blank')?.focus();
      })
      .catch(error => {
        toaster.show({ message: `Something went wrong: ${errorMessage(error)}`, intent: Intent.DANGER });
        setStatus(entry_key, { is_loaded: true, loading: false, error, statusText: error.response?.statusText, data: error.response?.data });
      });
  };

  const update = () => {
    const { context, statuses } = latest.current;
    const { project, project_data = {}, commit = {}, integrations = [] } = context;
    const eval_templates_recursively = make_eval_templates_recursively(context);
    // Flatten integrations so sub-menu entries also get their status probed.
    const flatten = (items, prefix = '') => (items || []).flatMap(i => {
      if (!i) return [];
      const key = integration_key(i, prefix);
      return [{ integration: i, key }, ...(i.sub ? flatten(i.sub, `${key}/`) : [])];
    });
    flatten(integrations)
      .filter(({ integration: i }) => (i?.href !== undefined && i?.href !== "" && i?.src === undefined) || i?.gitlabCI || i?.githubActions || i?.jenkins)
      .forEach(({ integration, key }) => {
        try {
          integration = eval_templates_recursively(integration);
        } catch {
          return;
        }
        if (!integration) return;
        const status = statuses[key] || {};
        if (status.loading) return;
        if (integration.jenkins && status.data?.web_url === undefined && status.data?.url === undefined) return;
        // Those are display-only fields, not part of the request
        const { label: _label, icon: _icon, text: _text, href: _href, alt: _alt, style: _style, ignore_failure, gitlabCI, githubActions, jenkins, ...request } = integration;
        let url, params;
        if (gitlabCI) {
          if (status.triggered !== true) return;
          url = '/api/v1/gitlab/job/';
          params = { ...gitlab_job(project, project_data, commit), job_id: status.data?.id, ...gitlabCI };
        } else if (githubActions) {
          // The latest run for this commit, or the one we started
          url = '/api/v1/github/workflow/';
          // dispatched_at: to find the run we started when the server didn't see it yet
          params = { ...github_workflow(project, project_data, commit), run_id: status.data?.id, dispatched_at: status.data?.dispatched_at, ...githubActions };
        } else if (jenkins) {
          if (status.triggered !== true) return;
          url = '/api/v1/jenkins/build/';
          params = { ...status.data }; // .web_url, .url
        } else { // webhook
          url = '/api/v1/webhook/proxy/';
          params = {
            method: 'HEAD',
            url: integration.href.startsWith('/') ? `${window.location.origin}${integration.href}` : integration.href,
            ...request,
          };
        }
        // Only mark as loading once we know we'll actually fire a request
        setStatus(key, { loading: true }, { merge: true });
        // polling: users didn't ask for it, so no "Log in" toast if they are logged out
        http.post(url, params, { background: true })
          .then(response => setStatus(key, { is_loaded: true, loading: false, error: null, statusText: null, data: response.data }, { merge: true }))
          .catch(error => {
            const statusText = error.response ? error.response.statusText : "Network Error";
            setStatus(key, {
              is_loaded: true,
              loading: false,
              error: (!!ignore_failure || statusText.includes("METHOD NOT ALLOWED")) ? null : error,
              statusText,
              data: error.response?.data,
            }, { merge: true });
          });
      });
  };

  const interval = useRef(null);
  const stop = () => clearInterval(interval.current);
  const start = period => {
    stop();
    update();
    interval.current = setInterval(update, period || 10 * 1000);
  };
  useEffect(() => stop, []);

  return {
    integrationStatuses: statuses,
    triggerIntegration: trigger,
    startUpdateIntegrationStatuses: start,
    stopUpdateIntegrationStatuses: stop,
  };
}
