import { useQuery } from "@tanstack/react-query";

import Plot from "../components/Plot";
import { fileQuery } from "../api/queries";
import { overlay } from "./plotlyOverlay";
import { ViewerError } from "./ViewerStates";
import { OUTPUT_FRAME_SANDBOX } from "./htmlDocument";
import { plot_color } from "../sideColors";
import { useIsDark } from "../theme";
import { useLabels } from "../hooks";


// TODO: keep the zoom in the state, like explained here
//        https://github.com/plotly/react-plotly.js/#state-management
//       and like we did in the history-over-time plot...
// TODO: sync zoom across new and ref
// TODO: sync zoom across all plots sharing the same path, like we do for images
// TODO: add magic to e.g. compare tables with a diff  

// Files are cached: switching between views doesn't fetch them again


const px = (value, fallback) => parseFloat(String(value ?? fallback).replace(/px$/, ''));


const PlotlyViewer = ({ output_new, output_ref, path, path_groundtruth, style, side_by_side = true, layout, labels: labels_ }) => {
  const labels = useLabels(labels_);
  const is_dark = useIsDark();
  const width = style?.width || '840px';
  const height = style?.height || '525';

  // plotly can be saved as embeddable stand-alone html: its scripts run sandboxed, in an origin of their own
  const is_html = !!path && path.endsWith('.html');
  const can_fetch = !!output_new?.output_dir_url && !!path && !is_html;
  const has_ref = !!output_ref;
  const url = (output, file) => can_fetch && output?.output_dir_url && file ? `${output.output_dir_url}/${file}` : undefined;
  const query_new = useQuery(fileQuery(url(output_new, path), { is_running: output_new?.is_running }));
  // we don't really care about errors for reference / groundtruth outputs
  const query_ref = useQuery(fileQuery(url(output_ref, path), { is_running: output_ref?.is_running }));
  const query_groundtruth = useQuery(fileQuery(url(output_new, path_groundtruth), { is_running: output_new?.is_running }));

  if (is_html)
    return <div style={{display: "flex"}}>
        <iframe title={labels.new} scrolling="no" style={{border: "none"}} sandbox={OUTPUT_FRAME_SANDBOX} src={`${output_new.output_dir_url}/${path}`} height={height} width={width}></iframe>
        {has_ref &&
        <iframe title={labels.reference} scrolling="no" style={{border: "none"}} sandbox={OUTPUT_FRAME_SANDBOX} src={`${output_ref.output_dir_url}/${path}`} height={height} width={width}></iframe>
        }
    </div>

  const queries = { new: query_new, ref: query_ref, groundtruth: query_groundtruth };
  // we wait for all the files
  const is_loading = Object.values(queries).some(q => q.isPending && q.isFetching);
  if (!can_fetch || is_loading || query_new.isPending) return <span/>;
  if (query_new.isError) return <ViewerError path={path} error={query_new.error}/>

  const data = {};
  for (const [label, query] of Object.entries(queries)) {
    if (query.data)
      data[label] = query.data.data ?? [];
  }
  const layout_new = query_new.data?.layout ?? {};
  const width_full = px(width, '840px');

  if (!side_by_side) {
    // the plot's and the configuration's widths win, like before
    const layout_ = {
      width: width_full,
      ...layout_new,
      ...layout,
    };
    const merged_layout = {
      ...layout_,
      xaxis: { ...layout_.xaxis, automargin: true },
      yaxis: { ...layout_.yaxis, automargin: true },
      legend: { ...layout_.legend, traceorder: 'reversed' },
    };
    // named and colored like the labels compared, e.g. "ISP v2 | p99"; without names, "new | p99" and "ref | p99"
    const traces = overlay(data, has_ref, {
      names: { new: labels.new, ref: labels.reference },
      colors: { new: `${plot_color(labels.colors.new, is_dark)}dd`, ref: `${plot_color(labels.colors.reference, is_dark)}dd` },
    });
    if (traces.length === 0)
      return <span></span>
    return <Plot data={traces} layout={merged_layout}/>;
  }

  const layout_ = {
    ...layout_new,
    ...layout,
  };
  const merged_layout = {
    ...layout_,
    xaxis: { ...layout_.xaxis, automargin: true },
    yaxis: { ...layout_.yaxis, automargin: true },
    width: data.ref ? (width_full / 2 - 40) : width_full,
  };
  return <>
    <Plot key="new" data={data.new} layout={merged_layout}/>
    {!!data.ref && <Plot key="ref" data={data.ref} layout={merged_layout}/>}
  </>
}

export default PlotlyViewer;
