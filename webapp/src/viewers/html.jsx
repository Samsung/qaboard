import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { fileQuery } from "../api/queries";
import { FRAME_SIZE_MESSAGE, OUTPUT_FRAME_SANDBOX, STATIC_FRAME_SANDBOX, has_scripts, html_base_url, html_for_frame, html_with_base } from "./htmlDocument";
import { ViewerError, ViewerLoading } from "./ViewerStates";
import { useLabels, useSiteConfig } from "../hooks";


// The frame grows to fit its document: as high, up to its maxHeight (then it scrolls), and wider if what's in it doesn't fit
const fit = (frame, { width, height }) => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || height < 1) return;
  if (width > frame.clientWidth)
    frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
};

// An HTML output in its own document: its styles stay out of the app, and its relative links (images/1.jpg) resolve
// from its folder. It is sandboxed (see htmlDocument.js). With scripts, and if the server isolates the runs' HTML
// (sandbox_html), in an origin of its own: they run but can't reach the app, and the document tells us its size.
// Else, in our origin where nothing of it can run: we measure it once loaded, images included.
const HtmlFrame = ({ html, base, width, maxHeight, title, isolate }) => {
  const frame = useRef(null);
  const scripted = isolate && has_scripts(html);
  useEffect(() => {
    if (!scripted) return;
    const resize = e => {
      if (frame.current && e.source === frame.current.contentWindow && e.data?.type === FRAME_SIZE_MESSAGE)
        fit(frame.current, e.data);
    };
    window.addEventListener('message', resize);
    return () => window.removeEventListener('message', resize);
  }, [scripted]);
  const measure = e => {
    const root = e.currentTarget.contentDocument?.documentElement;
    if (root) fit(e.currentTarget, { width: root.scrollWidth, height: root.scrollHeight });
  };
  return <iframe
    ref={frame}
    title={title}
    srcDoc={scripted ? html_for_frame(html, base) : html_with_base(html, base)}
    sandbox={scripted ? OUTPUT_FRAME_SANDBOX : STATIC_FRAME_SANDBOX}
    onLoad={scripted ? undefined : measure}
    style={{ width, height: '150px', maxHeight, border: 0, display: 'block' }}
  />
}


// like the image viewer's (src/image-viewer/ImageViewer.jsx), with room for the card's header
const DEFAULT_MAX_HEIGHT = 'max(400px, calc(100vh - 160px))';

// Files are cached: switching between views doesn't fetch them again
const htmlQuery = (url, is_running) => fileQuery(url, { is_running, responseType: 'text' });

const HtmlViewer = ({ path, output_new, output_ref, style, labels: labels_ }) => {
  const labels = useLabels(labels_);
  const { sandbox_html } = useSiteConfig();
  const url_new = output_new?.output_dir_url && path ? `${output_new.output_dir_url}/${path}` : undefined;
  const has_reference = !!output_ref?.output_dir_url;
  const url_ref = url_new && has_reference ? `${output_ref.output_dir_url}/${path}` : undefined;
  const query_new = useQuery(htmlQuery(url_new, output_new?.is_running));
  // we don't really care about errors for reference outputs
  const query_ref = useQuery(htmlQuery(url_ref, output_ref?.is_running));

  if (!url_new || query_new.isPending || (url_ref && query_ref.isPending)) return <ViewerLoading height="150px"/>;
  if (query_new.isError) return <ViewerError path={path} error={query_new.error}/>

  // as wide as the card. Not taller than the window: a report as wide as the card can get very tall, e.g. a figure
  // that keeps its aspect ratio. Visualizations change it with `style: {maxHeight: 2000px}` (or `none`), or `height`.
  const width = style?.width || '100%';
  const maxHeight = style?.maxHeight ?? style?.height ?? DEFAULT_MAX_HEIGHT;
  // what the commit page calls them, in their colors
  const heading = key => <h3><span aria-hidden style={{ color: labels.colors[key].css }}>●</span> {labels[key]}</h3>;
  return <>
    {has_reference && heading('new')}
    <HtmlFrame html={query_new.data ?? ""} base={html_base_url(output_new.output_dir_url, path)} width={width} maxHeight={maxHeight} title={`${path} (${labels.new})`} isolate={sandbox_html}/>
    {has_reference && <>
      {heading('reference')}
      <HtmlFrame html={query_ref.data || ""} base={html_base_url(output_ref.output_dir_url, path)} width={width} maxHeight={maxHeight} title={`${path} (${labels.reference})`} isolate={sandbox_html}/>
    </>}
  </>
}


export default HtmlViewer;
