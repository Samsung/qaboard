import { describe, expect, it } from 'vitest';
import { reference_branch_of, without_qaboard_yaml } from '../defaults';
import { normalize_project } from '../api/normalize';
import { is_placeholder_commit, shortId } from '../utils';
import { commit_url } from '../git';

// Projects created by qaboard.start_run() or `qa upload`, whose runs never sent a qaboard.yaml
describe('projects without a qaboard.yaml', () => {
  it('use their repository default branch as the reference, like the backend', () => {
    const sdk_project = normalize_project({ data: { git: { default_branch: 'main' } } });
    expect(without_qaboard_yaml(sdk_project)).toBe(true);
    expect(reference_branch_of(sdk_project)).toBe('main');
    expect(reference_branch_of(normalize_project({ data: null }))).toBe('main');
    expect(reference_branch_of(normalize_project({ data: null }), null)).toBe(null);
    // a qaboard.yaml that doesn't say it: the repository's default branch too
    const with_yaml = { data: { git: { default_branch: 'develop' }, qatools_config: { project: { name: 'a/b' } } } };
    expect(without_qaboard_yaml(with_yaml)).toBe(false);
    expect(reference_branch_of(with_yaml)).toBe('develop');
    expect(reference_branch_of({ data: { qatools_config: { project: { name: 'a/b', reference_branch: 'develop' } } } })).toBe('develop');
  });

  it('show the placeholder commit of runs outside git as it is, without a link to the git server', () => {
    expect(is_placeholder_commit('<local:alice>')).toBe(true);
    expect(is_placeholder_commit('0123456789abcdef')).toBe(false);
    expect(shortId('a/b', '<local:alice>')).toBe('<local:alice>');
    expect(shortId('a/b', '0123456789abcdef')).toBe('01234567');
    const project_data = { data: { git: { web_url: 'https://github.com/a/b' } } };
    expect(commit_url(project_data, '<local:alice>')).toBe(undefined);
  });
});
