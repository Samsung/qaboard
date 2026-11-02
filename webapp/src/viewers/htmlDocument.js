// HTML outputs are shown in an iframe (html.jsx): their relative links must resolve from the output's own folder.

// The folder of `path` in the run's output directory, as an absolute URL ending with a slash
export const html_base_url = (output_dir_url, path, location = window.location.href) => {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const dir = output_dir_url.endsWith('/') ? output_dir_url : `${output_dir_url}/`;
  return new URL(`${dir}${folder}`, location).href;
};

const escape_attribute = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The document with a <base> first in its <head>: relative links resolve from `base`, and open in a new tab.
// A <base> the document already has comes after ours, and the first one wins. `extra` comes right after our <base>.
export const html_with_base = (html, base, extra = '') => {
  const tag = `<base href="${escape_attribute(base)}" target="_blank">${extra}`;
  // without a <head>, after <html> or the doctype: before the doctype, browsers would render it in quirks mode
  const after = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  if (after) return html.slice(0, after.index + after[0].length) + tag + html.slice(after.index + after[0].length);
  return tag + html;
};


// Outputs' HTML (reports, plotly figures saved as HTML) comes from the runs, not from QA-Board: its scripts must not
// run in the app's origin, where they could read the page and call the API as the user. Without allow-same-origin,
// frames get an origin of their own: their scripts run (e.g. to draw charts), links open in a new tab, downloads work.
// But what they load is fetched without the user's session (cross-site): files of restricted projects don't load.
export const OUTPUT_FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads';
// So documents without scripts keep our origin, where nothing of theirs can run: their images load with the session
export const STATIC_FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

export const has_scripts = html => /<script[\s>]/i.test(html);

// We can't measure documents of another origin: they tell us their size once their body is laid out, then when it
// changes (e.g. images loaded). Documents whose height follows the frame's (100vh) would grow it forever: not 30 times.
export const FRAME_SIZE_MESSAGE = 'qaboard-frame-size';
const size_script = '<script>(function(){var n=0;function post(){var r=document.documentElement;'
  + `if(n++<30)parent.postMessage({type:"${FRAME_SIZE_MESSAGE}",width:r.scrollWidth,height:r.scrollHeight},"*")}`
  + 'addEventListener("DOMContentLoaded",function(){if(window.ResizeObserver&&document.body)new ResizeObserver(post).observe(document.body)});'
  + 'addEventListener("load",post)})()</script>';

// The document of an output's iframe (srcdoc): links resolve from `base`, and, if it has scripts, it tells us its size
export const html_for_frame = (html, base) => html_with_base(html, base, has_scripts(html) ? size_script : '');
