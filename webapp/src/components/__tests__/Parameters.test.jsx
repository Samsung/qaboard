/**
 * Tests for the comparison of commits' artifacts.
 * Run with: cd webapp && npm test -- Parameters
 */
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { CommitParameters } from '../Parameters';
import { history } from '../../router';
import { renderWithProviders } from '../../test-utils';

vi.mock('copy-to-clipboard', () => ({ default: vi.fn() }));
vi.mock('../../viewers/OutputViewer', () => ({
  OutputViewer: ({ manifests, expand_all, show_all_files }) => <div data-testid="viewer">{JSON.stringify({ manifests, expand_all, show_all_files })}</div>,
}));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

describe('CommitParameters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('compares the manifests of the commits, with options from the URL', async () => {
    history.replace('/p/commit/new?params_artifact=binaries');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.startsWith('/new')
      ? json({ 'a.bin': { st_size: 2048 } })
      : json({ 'a.bin': { st_size: 1024 } }));
    renderWithProviders(<HistoryRouter history={history}>
      <CommitParameters
        config={{ artifacts: { binaries: {}, configurations: {} } }}
        new_commit={{ id: 'new', artifacts_url: '/new' }}
        ref_commit={{ id: 'ref', artifacts_url: '/ref' }}
      />
    </HistoryRouter>, { siteConfig: {} });
    const viewer = await screen.findByTestId('viewer');
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(['/new/manifests/binaries.json', '/ref/manifests/binaries.json']);
    await waitFor(() => expect(JSON.parse(viewer.textContent)).toEqual({
      manifests: { new: { 'a.bin': { st_size: 2048 } }, reference: { 'a.bin': { st_size: 1024 } } },
      expand_all: true,
      show_all_files: false,
    }));
    expect(screen.getByText('Total: 2.0 kB')).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByText('Show all files')));
    expect(history.location.search).toBe('?params_artifact=binaries&params_show_all_files=true');
    expect(JSON.parse(screen.getByTestId('viewer').textContent).show_all_files).toBe(true);
  });

  it('loads the artifacts of commits that load after it shows, and of the next commit', async () => {
    history.replace('/p/commit/a?params_artifact=build');
    const manifests = {
      '/a/manifests/build.json': { 'build/flags.json': { st_size: 1, md5: 'a' } },
      '/b/manifests/build.json': { 'build/flags.json': { st_size: 2, md5: 'b' } },
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url in manifests ? json(manifests[url]) : json({}, 404));
    const config = { artifacts: { build: { glob: 'build/flags.json' } } };
    const page = commit => <HistoryRouter history={history}>
      <CommitParameters config={config} new_commit={commit} ref_commit={{ id: 'r' }}/>
    </HistoryRouter>;
    const { rerender } = renderWithProviders(page({ id: 'a' }));
    rerender(page({ id: 'a', artifacts_url: '/a' }));
    expect(await screen.findByTestId('viewer')).toHaveTextContent('"md5":"a"');
    rerender(page({ id: 'b', artifacts_url: '/b' }));
    expect(await screen.findByText(/"md5":"b"/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not find/)).not.toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/b/manifests/build.json');
  });

  it('explains how to save missing artifacts', async () => {
    history.replace('/p/commit/new');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({}, 404));
    renderWithProviders(<HistoryRouter history={history}>
      <CommitParameters config={{}} new_commit={{ id: 'new', artifacts_url: '/new' }}/>
    </HistoryRouter>, { siteConfig: {} });
    expect(await screen.findByText('Could not find the configurations')).toBeInTheDocument();
  });

  it('says when the commit has no artifacts', () => {
    history.replace('/p/commit/new');
    renderWithProviders(<HistoryRouter history={history}>
      <CommitParameters config={{}} new_commit={{ id: 'new', is_loaded: true }}/>
    </HistoryRouter>, { siteConfig: {} });
    expect(screen.getByText('No artifacts were saved for this commit')).toBeInTheDocument();
    expect(screen.getByText('Learn more')).toHaveAttribute('href', expect.stringMatching(/docs\/storage\/artifacts$/));
  });
});

