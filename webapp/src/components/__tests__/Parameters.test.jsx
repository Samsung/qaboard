/**
 * Artifacts & Configurations: the artifacts' manifests of the new and reference commits, diffed.
 * Run with: cd webapp && npm test -- Parameters
 */
import { render, screen } from '@testing-library/react';
import axios from 'axios';

import { CommitParameters } from '../Parameters';

vi.mock('../../viewers/OutputViewer', () => ({
  OutputViewer: ({ manifests }) => <pre data-testid="viewer">{JSON.stringify(manifests)}</pre>,
}));

vi.mock('axios', async importOriginal => {
  const axios = await importOriginal();
  return { ...axios, default: { ...axios.default, get: vi.fn() } };
});

const manifests = {
  '/a/manifests/build.json': { 'build/flags.json': { st_size: 1, md5: 'a' } },
  '/b/manifests/build.json': { 'build/flags.json': { st_size: 2, md5: 'b' } },
};

beforeEach(() => {
  window.history.replaceState(null, '', '/?params_artifact=build');
  axios.get.mockImplementation((url, { cancelToken }) => {
    if (cancelToken.reason) return Promise.reject(new axios.Cancel('cancelled'));
    if (url in manifests) return Promise.resolve({ data: manifests[url] });
    return Promise.reject(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
  });
});
afterEach(() => vi.resetAllMocks());

const props = { config: { artifacts: { build: { glob: 'build/flags.json' } } }, history: { push: vi.fn() } };

describe('CommitParameters', () => {
  it('loads the artifacts of commits that load after it shows', async () => {
    const { rerender } = render(<CommitParameters {...props} new_commit={{ id: 'a' }} ref_commit={{ id: 'r' }}/>);
    rerender(<CommitParameters {...props} new_commit={{ id: 'a', artifacts_url: '/a' }} ref_commit={{ id: 'r' }}/>);
    expect(await screen.findByTestId('viewer')).toHaveTextContent('"md5":"a"');
    // then another commit: its manifest, not "Could not find the build"
    rerender(<CommitParameters {...props} new_commit={{ id: 'b', artifacts_url: '/b' }} ref_commit={{ id: 'r' }}/>);
    expect(await screen.findByText(/"md5":"b"/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not find/)).not.toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/b/manifests/build.json', expect.anything());
  });

  it('says when a commit has no artifacts', async () => {
    render(<CommitParameters {...props} new_commit={{ id: 'c', artifacts_url: '/c' }}/>);
    expect(await screen.findByText('Could not find the build')).toBeInTheDocument();
  });
});
