// Links to the git hosts of projects
import { queryClient } from '../api/queryClient';
import { repo_url, host_url, host_type, commit_url, tree_url, blob_url, commits_url, image_url, default_integrations, git_hostname, hostname_of } from '../git';
import { make_eval_templates_recursively } from '../utils';

const project = git => ({ data: { git } });

const site = config => queryClient.setQueryData(['config'], { git_web_url: 'https://gitlab.example.com', git_hosts: [], ...config });
beforeEach(() => site({}));
afterAll(() => queryClient.removeQueries({ queryKey: ['config'] }));


describe('git host of projects', () => {
  test('from the webhook data', () => {
    expect(host_type(project({ hosting_type: 'github', web_url: 'https://ghe.example.com/a/b' }))).toBe('github');
    expect(host_url(project({ host: 'https://ghe.example.com', web_url: 'https://ghe.example.com/a/b' }))).toBe('https://ghe.example.com');
  });

  test('from the configured hosts, for older projects', () => {
    site({ git_hosts: [{ type: 'gitea', url: 'https://git.example.com' }] });
    expect(host_type(project({ web_url: 'https://git.example.com/a/b' }))).toBe('gitea');
    expect(host_type(project({ web_url: 'https://github.com/a/b' }))).toBe('github');
    expect(host_type(project({ web_url: 'https://bitbucket.org/a/b' }))).toBe('bitbucket');
    expect(host_type(project({ web_url: 'https://codeberg.org/a/b' }))).toBe('gitea');
    // like before hosts were configurable
    expect(host_type(project({ web_url: 'http://gitlab-srv/a/b' }))).toBe('gitlab');
    expect(host_url(project({ web_url: 'http://gitlab-srv:8080/a/b' }))).toBe('http://gitlab-srv:8080');
  });

  test('repository URL without webhook data', () => {
    expect(repo_url(project({ path_with_namespace: 'a/b' }))).toBe('https://gitlab.example.com/a/b');
    const from_qaboard_yaml = url => repo_url({ data: { git: { path_with_namespace: 'a/b' }, qatools_config: { project: { url } } } });
    expect(from_qaboard_yaml('git@github.com:a/b.git')).toBe('https://github.com/a/b');
    expect(from_qaboard_yaml('https://gitlab-srv:8443/a/b.git')).toBe('https://gitlab-srv:8443/a/b');
    // ssh remotes on a configured host use its protocol
    site({ git_web_url: 'http://gitlab-srv' });
    expect(from_qaboard_yaml('git@gitlab-srv:a/b.git')).toBe('http://gitlab-srv/a/b');
    expect(git_hostname({ project: { url: 'git@gitlab-srv:8080:svt/x.git' } })).toBe('http://gitlab-srv:8080');
  });

  test('hostnames', () => {
    expect(hostname_of('https://GitHub.com/a/b')).toBe('github.com');
    expect(hostname_of('https://user@host:8080/a')).toBe('host');
    expect(hostname_of('git@host:a/b.git')).toBe('host');
    expect(hostname_of(null)).toBe(null);
  });
});


describe('links per host', () => {
  const sha = '6113728f27ae82c7b1a177c8d03f9e96e0adf246';
  const links = git => {
    const p = project({ path_with_namespace: 'a/b', ...git });
    return [commit_url(p, sha), tree_url(p, 'feature/x', 'sub/dir'), tree_url(p, sha, 'sub'), blob_url(p, 'main', 'f.yaml'), commits_url(p, 'main')];
  };

  test('GitLab', () => {
    expect(links({ hosting_type: 'gitlab', web_url: 'https://gitlab.com/a/b' })).toEqual([
      `https://gitlab.com/a/b/-/commit/${sha}`,
      'https://gitlab.com/a/b/-/tree/feature/x/sub/dir',
      `https://gitlab.com/a/b/-/tree/${sha}/sub`,
      'https://gitlab.com/a/b/-/blob/main/f.yaml',
      'https://gitlab.com/a/b/-/commits/main',
    ]);
  });

  test('GitHub', () => {
    expect(links({ hosting_type: 'github', web_url: 'https://github.com/a/b' })).toEqual([
      `https://github.com/a/b/commit/${sha}`,
      'https://github.com/a/b/tree/feature/x/sub/dir',
      `https://github.com/a/b/tree/${sha}/sub`,
      'https://github.com/a/b/blob/main/f.yaml',
      'https://github.com/a/b/commits/main',
    ]);
  });

  test('Gitea and Forgejo', () => {
    expect(links({ hosting_type: 'gitea', web_url: 'https://codeberg.org/a/b' })).toEqual([
      `https://codeberg.org/a/b/commit/${sha}`,
      'https://codeberg.org/a/b/src/branch/feature/x/sub/dir',
      `https://codeberg.org/a/b/src/commit/${sha}/sub`,
      'https://codeberg.org/a/b/src/branch/main/f.yaml',
      'https://codeberg.org/a/b/commits/branch/main',
    ]);
  });

  test('Bitbucket', () => {
    expect(links({ hosting_type: 'bitbucket', web_url: 'https://bitbucket.org/a/b' })).toEqual([
      `https://bitbucket.org/a/b/commits/${sha}`,
      'https://bitbucket.org/a/b/src/feature/x/sub/dir',
      `https://bitbucket.org/a/b/src/${sha}/sub`,
      'https://bitbucket.org/a/b/src/main/f.yaml',
      'https://bitbucket.org/a/b/commits/branch/main',
    ]);
  });

  test('a folder at the root', () => {
    const p = project({ hosting_type: 'github', web_url: 'https://github.com/a/b' });
    expect(tree_url(p, 'main')).toBe('https://github.com/a/b/tree/main');
  });
});


describe('images', () => {
  test('public images are loaded directly, others via the server', () => {
    expect(image_url('https://avatars.githubusercontent.com/u/1?v=4')).toBe('https://avatars.githubusercontent.com/u/1?v=4');
    // closed networks may only reach gravatar through the server
    expect(image_url('https://www.gravatar.com/avatar/abc?d=identicon')).toMatch(/^\/api\/v1\/git\/proxy/);
    expect(image_url('http://gitlab-srv/uploads/a b.png?x=1&y=2')).toBe('/api/v1/git/proxy?url=http%3A%2F%2Fgitlab-srv%2Fuploads%2Fa%20b.png%3Fx%3D1%26y%3D2');
    site({ git_hosts: [{ type: 'gitea', url: 'https://git.example.com' }, { type: 'gitlab', url: 'https://gitlab.example.com' }] });
    expect(image_url('https://git.example.com/avatars/1')).toBe('https://git.example.com/avatars/1');
    expect(image_url('https://gitlab.example.com/uploads/1.png')).toMatch(/^\/api\/v1\/git\/proxy/);
    expect(image_url('/s/some/file.png')).toBe('/s/some/file.png');
    expect(image_url(null)).toBe(null);
    expect(image_url(undefined)).toBe(null);
  });

  test('urls that only look like public hosts go through the server', () => {
    for (const url of [
      '//evil.example/p.png',
      'https://evil.example#@github.com/x.png',
      'https://evil.example?@github.com/x.png',
      'https://evil.example\\@github.com/x.png',
      'http://avatars.githubusercontent.com/u/1',
    ])
      expect([url, image_url(url)]).toEqual([url, `/api/v1/git/proxy?url=${encodeURIComponent(url)}`]);
  });
});


describe('refs in links', () => {
  test('are encoded, but keep their slashes', () => {
    const p = project({ hosting_type: 'github', web_url: 'https://github.com/a/b/' });
    expect(tree_url(p, 'feature/#12 x', 'sub dir')).toBe('https://github.com/a/b/tree/feature/%2312%20x/sub%20dir');
    expect(commit_url(p, 'abc123')).toBe('https://github.com/a/b/commit/abc123');
  });
});


describe('default integrations', () => {
  const evaluated = (git, branch) => {
    const project_data = project({ path_with_namespace: 'a/b', ...git });
    const evaluate = make_eval_templates_recursively({ project: 'a/b', project_data, branch });
    return default_integrations(project_data).map(i => { try { return evaluate(i); } catch { return null; } });
  };

  test('per host', () => {
    expect(evaluated({ hosting_type: 'gitlab', web_url: 'https://gitlab.com/a/b' }, 'main')[0].src).toBe('https://gitlab.com/a/b/badges/main/pipeline.svg');
    expect(evaluated({ hosting_type: 'github', web_url: 'https://github.com/a/b' }, 'main')[0].href).toBe('https://github.com/a/b/actions?query=branch%3Amain');
    expect(evaluated({ hosting_type: 'gitea', web_url: 'https://codeberg.org/a/b' }, 'main')).toEqual([]);
    expect(evaluated({ hosting_type: 'github', web_url: 'https://github.com/a/b' }, 'fix/#1')[0].href).toBe('https://github.com/a/b/actions?query=branch%3Afix%2F%231');
    // we don't show badges for hosts we can only guess
    expect(evaluated({ web_url: 'https://unknown.example/a/b' }, 'main')).toEqual([]);
  });

  test('only on branch pages', () => {
    expect(evaluated({ hosting_type: 'github', web_url: 'https://github.com/a/b' }, undefined)).toEqual([null]);
  });
});
