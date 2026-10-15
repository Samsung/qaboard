// Links to the projects' git hosts: GitLab, GitHub, Gitea/Forgejo, Bitbucket...
// Push webhooks describe repositories in project_data.data.git (see backend/git_hosts/__init__.py):
//   {hosting_type, host, web_url, path_with_namespace, name, avatar_url, default_branch...}
// Older projects may only have some of it: we then use qaboard.yaml's project.url and the site's git hosts.
/*eslint no-template-curly-in-string: "off"*/
import { queryClient } from "./api/queryClient";


// The site configuration (/api/v1/config), from the query cache
const site_config = () => queryClient.getQueryData(['config']) ?? {};

// Used when a project does not define project.url in qaboard.yaml, set from /api/v1/config (GITLAB_HOST)
let default_git_hostname = "https://gitlab.com"
const setDefaultGitHostname = hostname => {
  if (hostname)
    default_git_hostname = hostname.replace(/\/+$/, '')
}
const default_host_url = () => (site_config().git_web_url ?? default_git_hostname).replace(/\/+$/, '')


// https://host:8080/a/b => host, git@host:a/b.git => host
const hostname_of = url => {
  if (!url) return null;
  const match = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:?#]+)/i) ?? url.match(/^(?:[^@/\s]+@)?([^:/@\s]+)/);
  return match ? match[1].toLowerCase() : null;
}

// The web root of the host in qaboard.yaml's project.url, if any
const git_hostname = qaboard_config => {
  const project_url = qaboard_config?.project?.url
  // const project_url = "git@gitlab-srv:svt/te-testing.git"      //=> gitlab-srv
  // const project_url = "git@gitlab-srv:8080:svt/te-testing.git" //=> gitlab-srv:8080
  // const project_url = "https://gitlab-srv/svt/te-testing.git"  //=> gitlab-srv
  let hostname = null
  if (project_url) {
    let match = project_url.match(/@([^/:]+(:[0-9]+)?)[:/]/)
    if (match) {
      // For SSH remotes we don't know the protocol: we use the one of a git host with the same name
      const host = [{ url: default_host_url() }, ...(site_config().git_hosts ?? [])].find(h => hostname_of(h.url) === hostname_of(match[1]))
      const protocol = host?.url?.match(/^(https?):/)?.[1] ?? 'https'
      hostname = `${protocol}://${match[1]}`
    }
    match = project_url.match(/(https?:\/\/[^/:]+(:[0-9]+)?)\//)
    if (match)
      hostname = match[1]
  }
  return hostname
}


// The repository's web page
const repo_url = project_data => {
  const git = project_data?.data?.git ?? {};
  return (git.web_url ?? `${git_hostname(project_data?.data?.qatools_config) ?? default_host_url()}/${git.path_with_namespace}`).replace(/\/+$/, '');
}

// The web root of the repository's host, e.g. https://github.com
const host_url = project_data => project_data?.data?.git?.host ?? repo_url(project_data).split('/').slice(0, 3).join('/');

// The type of host we know the project is on: from its push webhooks, or the site's git hosts
const known_host_type = project_data => {
  const git = project_data?.data?.git ?? {};
  if (git.hosting_type)
    return git.hosting_type;
  const hostname = hostname_of(repo_url(project_data)) ?? '';
  return (site_config().git_hosts ?? []).find(h => hostname_of(h.url) === hostname)?.type;
}

// gitlab, github, gitea, bitbucket or generic
const host_type = project_data => {
  const known = known_host_type(project_data);
  if (known)
    return known;
  const hostname = hostname_of(repo_url(project_data)) ?? '';
  if (hostname.includes('github')) return 'github';
  if (hostname.includes('bitbucket')) return 'bitbucket';
  if (hostname.includes('gitea') || hostname.includes('forgejo') || hostname === 'codeberg.org') return 'gitea';
  return 'gitlab'; // like before git hosts were configurable
}


// URLs of pages, relative to the repository's web page
const is_sha = ref => /^[0-9a-f]{7,64}$/i.test(ref ?? '');
// Branches can contain e.g. "#" or spaces, but their "/" separate path segments in URLs
const encode_path = path => String(path ?? '').split('/').map(encodeURIComponent).join('/');
const url_patterns = {
  gitlab: {
    commit: sha => `-/commit/${sha}`,
    tree: (ref, path) => `-/tree/${ref}/${path}`,
    blob: (ref, path) => `-/blob/${ref}/${path}`,
    commits: ref => `-/commits/${ref}`,
  },
  github: {
    commit: sha => `commit/${sha}`,
    tree: (ref, path) => `tree/${ref}/${path}`,
    blob: (ref, path) => `blob/${ref}/${path}`,
    commits: ref => `commits/${ref}`,
  },
  gitea: {
    commit: sha => `commit/${sha}`,
    tree: (ref, path) => `src/${is_sha(ref) ? 'commit' : 'branch'}/${ref}/${path}`,
    blob: (ref, path) => `src/${is_sha(ref) ? 'commit' : 'branch'}/${ref}/${path}`,
    commits: ref => `commits/branch/${ref}`,
  },
  bitbucket: {
    commit: sha => `commits/${sha}`,
    tree: (ref, path) => `src/${ref}/${path}`,
    blob: (ref, path) => `src/${ref}/${path}`,
    commits: ref => `commits/branch/${ref}`,
  },
};
url_patterns.generic = url_patterns.github;

const link = (kind, project_data, ...args) => {
  const patterns = url_patterns[host_type(project_data)] ?? url_patterns.generic;
  return `${repo_url(project_data)}/${patterns[kind](...args.map(encode_path))}`.replace(/\/+$/, '');
}
const commit_url = (project_data, sha) => link('commit', project_data, sha);
// A folder at a branch or commit, e.g. a subproject
const tree_url = (project_data, ref, path = '') => link('tree', project_data, ref, path);
const blob_url = (project_data, ref, path) => link('blob', project_data, ref, path);
const commits_url = (project_data, ref) => link('commits', project_data, ref);


// Images from git hosts (avatars, CI badges...). Those of public git hosts are loaded directly. The others go through the server:
// it may have a session on GitLab hosts (GITLAB_AUTH), or can reach hosts users can't (e.g. gravatar from closed networks).
const public_image_hosts = ['avatars.githubusercontent.com', 'github.com', 'bitbucket.org', 'codeberg.org'];
const image_url = url => {
  if (!url) return null;
  if (url.startsWith('data:image/')) return url;
  let parsed;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  // our own files, but not //other.host/...
  if (parsed.origin === window.location.origin && url.startsWith('/') && !url.startsWith('//')) return url;
  const is_public = parsed.protocol === 'https:' && (public_image_hosts.includes(parsed.hostname)
    || (site_config().git_hosts ?? []).some(h => h.type !== 'gitlab' && hostname_of(h.url) === parsed.hostname));
  return is_public ? parsed.href : `/api/v1/git/proxy?url=${encodeURIComponent(url)}`;
}


// What projects show in their "Integrations" menu if their qaboard.yaml doesn't have `integrations`.
// Templates are filled by utils.make_eval_templates_recursively. ${branch} hides them on commit pages.
const default_integrations_per_host = {
  gitlab: [
    {
      href: "${git.web_url}/-/commits/${branch}",
      alt: "Pipeline status",
      src: "${git.web_url}/badges/${branch}/pipeline.svg",
    },
  ],
  github: [
    {
      text: "GitHub Actions",
      icon: "build",
      href: "${git.web_url}/actions?query=branch%3A${encodeURIComponent(branch)}",
      ignore_failure: true,
    },
  ],
};
// Only for hosts we know: guessing wrong would show broken badges
const default_integrations = project_data => default_integrations_per_host[known_host_type(project_data)] ?? [];


export {
  default_git_hostname,
  setDefaultGitHostname,
  git_hostname,
  hostname_of,
  repo_url,
  host_url,
  host_type,
  commit_url,
  tree_url,
  blob_url,
  commits_url,
  image_url,
  default_integrations,
};
