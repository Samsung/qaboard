// HTML outputs are shown in an iframe (html.jsx): their relative links must resolve from the output's own folder.

// The folder of `path` in the run's output directory, as an absolute URL ending with a slash
export const html_base_url = (output_dir_url, path, location = window.location.href) => {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const dir = output_dir_url.endsWith('/') ? output_dir_url : `${output_dir_url}/`;
  return new URL(`${dir}${folder}`, location).href;
};

const escape_attribute = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The document with a <base> first in its <head>: relative links resolve from `base`, and open in a new tab.
// A <base> the document already has comes after ours, and the first one wins.
export const html_with_base = (html, base) => {
  const tag = `<base href="${escape_attribute(base)}" target="_blank">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
};
