// HTML outputs show in an iframe, with their relative links resolved from their own folder (viewers/html.jsx)
import { FRAME_SIZE_MESSAGE, OUTPUT_FRAME_SANDBOX, STATIC_FRAME_SANDBOX, has_scripts, html_base_url, html_for_frame, html_with_base } from '../htmlDocument';

const location = 'http://localhost:5151/kitefin/detector/commit/abc';

describe('html_base_url', () => {
  it('is the folder of the output, absolute', () => {
    expect(html_base_url('/s/mnt/qaboard/kitefin/detector/23/9f/output/x/slices-indoor', 'report.html', location))
      .toBe('http://localhost:5151/s/mnt/qaboard/kitefin/detector/23/9f/output/x/slices-indoor/');
    expect(html_base_url('/s/out/', 'reports/run.html', location)).toBe('http://localhost:5151/s/out/reports/');
  });
});

describe('html_with_base', () => {
  const base = 'http://localhost:5151/s/out/';
  it('puts the base first in the head', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><base href="other/"></head><body><img src="images/1.jpg"></body></html>';
    expect(html_with_base(html, base)).toBe(
      '<!doctype html><html><head><base href="http://localhost:5151/s/out/" target="_blank"><meta charset="utf-8"><base href="other/"></head><body><img src="images/1.jpg"></body></html>');
  });
  it('works without a head, and escapes the URL', () => {
    expect(html_with_base('<p>hi</p>', 'http://h/a"b/')).toBe('<base href="http://h/a&quot;b/" target="_blank"><p>hi</p>');
    expect(html_with_base('<header>x</header>', base)).toBe(`<base href="${base}" target="_blank"><header>x</header>`);
  });
  it('keeps the doctype first', () => {
    expect(html_with_base('<!DOCTYPE html><p>hi</p>', base)).toBe(`<!DOCTYPE html><base href="${base}" target="_blank"><p>hi</p>`);
    expect(html_with_base('<!doctype html><html lang="en"><body>hi</body></html>', base))
      .toBe(`<!doctype html><html lang="en"><base href="${base}" target="_blank"><body>hi</body></html>`);
  });
  it('resolves relative links from the base', () => {
    const doc = new DOMParser().parseFromString(html_with_base('<html><head></head><body><img src="images/1.jpg"></body></html>', base), 'text/html');
    expect(doc.querySelector('img').src).toBe('http://localhost:5151/s/out/images/1.jpg');
  });
});

describe('html_for_frame', () => {
  const base = 'http://localhost:5151/s/out/';
  it('adds the script that says the size of documents with scripts, after the base', () => {
    const html = html_for_frame('<html><head><title>r</title><script src="plotly.js"></script></head><body>x</body></html>', base);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.head.firstElementChild.tagName).toBe('BASE');
    expect(doc.head.children[1].tagName).toBe('SCRIPT');
    expect(doc.head.children[1].textContent).toContain(FRAME_SIZE_MESSAGE);
    expect(doc.title).toBe('r');
  });
  it('adds no script to documents without', () => {
    expect(html_for_frame('<p>hi</p>', base)).toBe(`<base href="${base}" target="_blank"><p>hi</p>`);
  });
});

describe('sandboxes', () => {
  it("run outputs' scripts in an origin of their own", () => {
    const flags = OUTPUT_FRAME_SANDBOX.split(' ');
    expect(flags).toContain('allow-scripts');
    expect(flags).not.toContain('allow-same-origin');
  });
  it('run nothing of documents that keep our origin', () => {
    expect(STATIC_FRAME_SANDBOX.split(' ')).not.toContain('allow-scripts');
  });
  it('know which documents have scripts', () => {
    expect(has_scripts('<SCRIPT>x()</SCRIPT>')).toBe(true);
    expect(has_scripts('<svg><script type="text/javascript">x()</script></svg>')).toBe(true);
    expect(has_scripts('<p>a <scripted> b</p><noscript>no</noscript>')).toBe(false);
  });
});
