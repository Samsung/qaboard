/**
 * The HTML viewer shows the new and reference documents, under their names.
 * Run with: cd webapp && npm test -- htmlViewer
 */
import { fireEvent, screen } from '@testing-library/react';

import HtmlViewer from '../html';
import { renderWithProviders } from '../../test-utils';

const output_new = { output_dir_url: '/s/new' };
const output_ref = { output_dir_url: '/s/ref' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>report</p>')));
});
afterEach(() => vi.unstubAllGlobals());


describe('HtmlViewer', () => {
  it('says which document is new and which the reference, with the names the page gives them', async () => {
    renderWithProviders(<HtmlViewer path="report.html" output_new={output_new} output_ref={output_ref}/>);
    expect(await screen.findByRole('heading', { name: /new/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /reference/ })).toBeInTheDocument();
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

  const scripted = '<div id="chart"></div><script>draw("chart")</script>';
  const sandbox_of = frame => frame.getAttribute('sandbox').split(' ');

  it("runs the scripts of reports sandboxed, outside of the app's origin", async () => {
    fetch.mockImplementation(async () => new Response(scripted));
    renderWithProviders(<HtmlViewer path="report.html" output_new={output_new}/>);
    const frame = await screen.findByTitle('report.html (new)');
    expect(sandbox_of(frame)).toContain('allow-scripts');
    expect(sandbox_of(frame)).not.toContain('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain(scripted);
  });

  it('runs nothing of reports without scripts, which keep our origin to load their images', async () => {
    renderWithProviders(<HtmlViewer path="report.html" output_new={output_new}/>);
    const frame = await screen.findByTitle('report.html (new)');
    expect(sandbox_of(frame)).not.toContain('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('<p>report</p>');
  });

  it('grows to the size its document says, only from its own frame', async () => {
    fetch.mockImplementation(async () => new Response(scripted));
    renderWithProviders(<HtmlViewer path="report.html" output_new={output_new} style={{ width: '400px' }}/>);
    const frame = await screen.findByTitle('report.html (new)');
    const size = { type: 'qaboard-frame-size', width: 0, height: 900 };
    fireEvent(window, new MessageEvent('message', { data: size, source: window }));
    expect(frame.style.height).toBe('150px');
    fireEvent(window, new MessageEvent('message', { data: size, source: frame.contentWindow }));
    expect(frame.style.height).toBe('900px');
    expect(frame.style.width).toBe('400px');
  });
});
