// HTML outputs show in an iframe, with their relative links resolved from their own folder (viewers/html.jsx)
import { html_base_url, html_with_base } from '../htmlDocument';

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
  it('resolves relative links from the base', () => {
    const doc = new DOMParser().parseFromString(html_with_base('<html><head></head><body><img src="images/1.jpg"></body></html>', base), 'text/html');
    expect(doc.querySelector('img').src).toBe('http://localhost:5151/s/out/images/1.jpg');
  });
});
