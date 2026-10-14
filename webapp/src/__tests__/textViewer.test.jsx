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

const files = { '/new/log.txt': 'new log', '/ref/log.txt': 'reference log' };

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

  it('shows the file when the reference is missing', async () => {
    render(<GenericTextViewer filename="log.txt" text_url_new="/new/log.txt" text_url_ref="/missing/log.txt"/>);
    expect(await screen.findByTestId('editor')).toHaveTextContent('new log');
  });

  it('ignores requests cancelled by a newer selection', async () => {
    const { rerender } = render(<GenericTextViewer filename="log.txt" text_url_new="/slow/log.txt"/>);
    rerender(<GenericTextViewer filename="log.txt" text_url_new="/new/log.txt"/>);
    expect(await screen.findByTestId('editor')).toHaveTextContent('new log');
  });
});
