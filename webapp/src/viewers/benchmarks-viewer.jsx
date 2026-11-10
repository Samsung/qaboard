// The benchmark viewer in QA-Board: downloads the run's file and the reference run's for the standalone viewer,
// benchmarks/BenchmarksReport.jsx, with the names and colors of what the page compares.
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Callout } from "@blueprintjs/core";

import { fileQuery } from "../api/queries";
import { ViewerError, ViewerLoading } from "./ViewerStates";
import { useLabels } from "../hooks";
import { BenchmarksReport } from "./benchmarks/BenchmarksReport";

const LoadableTextViewer = lazy(() => import('./textViewer'));

// - format: from `type: benchmarks/<format>`
// - fallback_to_text: the file was picked by its name (benchmarks.json...), without `type: benchmarks`: if it isn't a
//   benchmark file the viewer reads, it's shown as text, as before the viewer existed
const BenchmarksViewer = ({ output_new, output_ref, path, labels, height, format, fallback_to_text, ...props }) => {
  const resolved_labels = useLabels(labels);
  const url_new = output_new?.output_dir_url && path ? `${output_new.output_dir_url}/${path}` : undefined;
  const url_ref = url_new && output_ref?.output_dir_url ? `${output_ref.output_dir_url}/${path}` : undefined;
  const query_new = useQuery(fileQuery(url_new, { is_running: output_new?.is_running, responseType: 'text' }));
  // without the reference's file, we show the new one alone
  const query_ref = useQuery(fileQuery(url_ref, { is_running: output_ref?.is_running, responseType: 'text' }));
  if (query_new.isError) return <ViewerError path={path} error={query_new.error}/>;
  if (!url_new || query_new.isPending || (url_ref && query_ref.isPending)) return <ViewerLoading height={height}/>;
  const fallback = fallback_to_text ? message => <>
    <Callout compact icon="info-sign" style={{ marginBottom: 6 }}>
      Not a benchmark file the viewer reads ({message}): shown as text.
    </Callout>
    <Suspense fallback={<ViewerLoading height={height}/>}>
      <LoadableTextViewer {...props} output_new={output_new} output_ref={output_ref} path={path} labels={labels}/>
    </Suspense>
  </> : undefined;
  return <BenchmarksReport
    text={query_new.data} ref_text={query_ref.isSuccess ? query_ref.data : null} labels={resolved_labels} path={path} format={format}
    height={height ? parseInt(height, 10) || undefined : undefined}
    fallback={fallback}
  />;
};

export default BenchmarksViewer;
