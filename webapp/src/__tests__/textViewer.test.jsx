/**
 * The text viewer shows a file, and diffs it with the reference when there is one.
 * Run with: cd webapp && npm test -- textViewer
 */
import { render, screen } from '@testing-library/react';
import axios from 'axios';

import GenericTextViewer from '../viewers/text';

vi.mock('../components/MonacoEditor', () => ({
  default: ({ value }) => <pre data-testid="editor">{value}</pre>,
  MonacoDiffEditor: ({ original, value }) => <pre data-testid="diff">{original} ➡️ {value}</pre>,
}));

// text.jsx reads axios.get when it's imported
vi.mock('axios', async importOriginal => {
  const axios = await importOriginal();
  return { ...axios, default: { ...axios.default, get: vi.fn() } };
});

const files = { '/new/log.txt': 'new log', '/ref/log.txt': 'reference log' };

beforeEach(() => {
  axios.get.mockImplementation((url, { cancelToken }) => {
    if (url === '/slow/log.txt') // until cancelled
      return new Promise((resolve, reject) => cancelToken.promise.then(reject));
    if (url in files)
      return Promise.resolve({ data: files[url] });
    return Promise.reject(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
  });
});
afterEach(() => vi.resetAllMocks());


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
