/**
 * The HTML viewer shows the new and reference documents, under their names.
 * Run with: cd webapp && npm test -- htmlViewer
 */
import { screen } from '@testing-library/react';

import HtmlViewer from '../html';
import { renderWithProviders } from '../../test-utils';

const output_new = { output_dir_url: '/s/new' };
const output_ref = { output_dir_url: '/s/ref' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>report</p>')));
});
afterEach(() => vi.unstubAllGlobals());


describe('HtmlViewer', () => {
  it('says which document is new and which the reference', async () => {
    renderWithProviders(<HtmlViewer path="report.html" output_new={output_new} output_ref={output_ref}/>);
    expect(await screen.findByRole('heading', { name: /New/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Reference/ })).toBeInTheDocument();
    expect(screen.getByTitle('report.html (reference)')).toBeInTheDocument();
  });

  it('uses the names of what the commit page compares', async () => {
    const labels = { new: 'ISP v2', reference: 'v1.4', colors: { new: { css: 'var(--qa-side-0)' }, reference: { css: 'var(--qa-side-1)' } } };
    renderWithProviders(<HtmlViewer path="report.html" output_new={output_new} output_ref={output_ref} labels={labels}/>);
    expect(await screen.findByRole('heading', { name: /ISP v2/ })).toBeInTheDocument();
    const reference = screen.getByRole('heading', { name: /v1.4/ });
    expect(reference.querySelector('[aria-hidden]')).toHaveStyle({ color: 'var(--qa-side-1)' });
    expect(screen.getByTitle('report.html (v1.4)')).toBeInTheDocument();
  });
});
