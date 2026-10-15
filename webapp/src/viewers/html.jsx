import { useQuery } from "@tanstack/react-query";

import { fileQuery } from "../api/queries";
import { html_base_url, html_with_base } from "./htmlDocument";
import { ViewerError, ViewerLoading } from "./ViewerStates";


// An HTML output in its own document: its styles stay out of the app, and its relative links (images/1.jpg) resolve
// from its folder. No scripts: the sandbox only lets the frame be measured (same origin) and open links in a new tab.
// Once it loaded, images included, the frame grows to fit its document: as high, and wider if what's in it doesn't fit.
const HtmlFrame = ({ html, base, width, title }) => {
  const resize = e => {
    const frame = e.currentTarget;
    const root = frame.contentDocument?.documentElement;
    if (!root) return;
    if (root.scrollWidth > frame.clientWidth)
      frame.style.width = `${root.scrollWidth}px`;
    frame.style.height = `${root.scrollHeight}px`;
  };
  return <iframe
    title={title}
    srcDoc={html_with_base(html, base)}
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    onLoad={resize}
    style={{ width, height: '150px', border: 0, display: 'block' }}
  />
}


// Files are cached: switching between views doesn't fetch them again
const htmlQuery = (url, is_running) => fileQuery(url, { is_running, responseType: 'text' });

const HtmlViewer = ({ path, output_new, output_ref, style }) => {
  const url_new = output_new?.output_dir_url && path ? `${output_new.output_dir_url}/${path}` : undefined;
  const has_reference = !!output_ref?.output_dir_url;
  const url_ref = url_new && has_reference ? `${output_ref.output_dir_url}/${path}` : undefined;
  const query_new = useQuery(htmlQuery(url_new, output_new?.is_running));
  // we don't really care about errors for reference outputs
  const query_ref = useQuery(htmlQuery(url_ref, output_ref?.is_running));

  if (!url_new || query_new.isPending || (url_ref && query_ref.isPending)) return <ViewerLoading height="150px"/>;
  if (query_new.isError) return <ViewerError path={path} error={query_new.error}/>

  const width = style?.width || '400px';
  return <>
    {has_reference && <h3>New</h3>}
    <HtmlFrame html={query_new.data ?? ""} base={html_base_url(output_new.output_dir_url, path)} width={width} title={`${path} (new)`}/>
    {has_reference && <>
      <h3>Reference</h3>
      <HtmlFrame html={query_ref.data || ""} base={html_base_url(output_ref.output_dir_url, path)} width={width} title={`${path} (reference)`}/>
    </>}
  </>
}


export default HtmlViewer;
