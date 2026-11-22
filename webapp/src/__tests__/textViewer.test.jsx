/**
 * The text viewer shows a file, and diffs it with the reference when there is one.
 * Run with: cd webapp && npm test -- textViewer
 */
import { screen } from '@testing-library/react';

import GenericTextViewer from '../viewers/text';
import { renderWithProviders } from '../test-utils';

vi.mock('../components/MonacoEditor', () => ({
  default: ({ value }) => <pre data-testid="editor">{value}</pre>,
  MonacoDiffEditor: ({ original, value }) => <pre data-testid="diff">{original} ➡️ {value}</pre>,
  preloadMonaco: () => {},
}));

const files = { '/new/log.txt': 'new log', '/ref/log.txt': 'reference log', '/run/media/a/20.txt': 'step 20', '/run/media/a/10.txt': 'step 10', '/run/media/b/20.txt': 'same', '/run/media/b/10.txt': 'same' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url, { signal } = {}) => {
    if (url === '/slow/log.txt') // until cancelled
      return new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    if (url in files)
      return Promise.resolve(new Response(files[url]));
    return Promise.resolve(new Response('not found', { status: 404, statusText: 'NOT FOUND' }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

const render = ui => renderWithProviders(ui);


describe('GenericTextViewer', () => {
  it('diffs with the reference', async () => {
    render(<GenericTextViewer filename="log.txt" text_url_new="/new/log.txt" text_url_ref="/ref/log.txt"/>);
    expect(await screen.findByTestId('diff')).toHaveTextContent('reference log ➡️ new log');
  });

  it("says what it diffs: the page's names", async () => {
    const { unmount } = render(<GenericTextViewer filename="log.txt" text_url_new="/new/log.txt" text_url_ref="/ref/log.txt"/>);
    expect(await screen.findByText(/reference →/)).toHaveTextContent('● reference → ● new');
    unmount();
    const labels = { new: 'ISP v2', reference: 'v1.4', colors: { new: { css: 'var(--qa-side-0)' }, reference: { css: 'var(--qa-side-1)' } } };
    render(<GenericTextViewer filename="log.txt" text_url_new="/new/log.txt" text_url_ref="/ref/log.txt" labels={labels}/>);
    const header = await screen.findByText(/v1.4 →/);
    expect(header).toHaveTextContent('● v1.4 → ● ISP v2');
    expect(header.querySelector('[aria-hidden]')).toHaveStyle({ color: 'var(--qa-side-1)' });
  });

  it("says it quietly without the file's name, e.g. under a logged key", async () => {
    render(<GenericTextViewer filename="log.txt" hide_filename text_url_new="/new/log.txt" text_url_ref="/ref/log.txt"/>);
    const line = await screen.findByText(/reference →/);
    expect(line).toHaveClass('bp6-text-muted');
  });

  it('shows the file when the reference is missing', async () => {
    render(<GenericTextViewer filename="log.txt" text_url_new="/new/log.txt" text_url_ref="/missing/log.txt"/>);
    expect(await screen.findByTestId('editor')).toHaveTextContent('new log');
  });

  it('ignores requests cancelled by a newer selection', async () => {
    const { rerender } = render(<GenericTextViewer filename="log.txt" text_url_new="/slow/log.txt"/>);
    rerender(<GenericTextViewer filename="log.txt" text_url_new="/new/log.txt"/>);
    expect(await screen.findByTestId('editor')).toHaveTextContent('new log');
  });

  it("says whether the file compared is the same, not the reference's at the same path", async () => {
    // the reference's manifest has the same file at the path: it isn't what is compared
    const manifests = { new: { 'media/a/20.txt': { md5: 'x' } }, reference: { 'media/a/20.txt': { md5: 'x' } } };
    const { unmount } = render(<GenericTextViewer filename="media/a/20.txt" filename_ref="media/a/10.txt" text_url_new="/run/media/a/20.txt" text_url_ref="/run/media/a/10.txt" manifests={manifests} compared_to="step 10"/>);
    expect(await screen.findByText('Next diff')).toBeInTheDocument();
    expect(screen.queryByText(/Identical/)).not.toBeInTheDocument();
    unmount();
    render(<GenericTextViewer filename="media/b/20.txt" filename_ref="media/b/10.txt" text_url_new="/run/media/b/20.txt" text_url_ref="/run/media/b/10.txt" compared_to="step 10"/>);
    expect(await screen.findByText('Identical to step 10')).toBeInTheDocument();
    expect(screen.queryByText('Next diff')).not.toBeInTheDocument();
  });
});
