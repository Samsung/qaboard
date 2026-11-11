// Flame graphs: the run's profile against the reference run's, from the files profilers write.
// The formats and how they're detected: flamegraph/formats.js. The viewer alone, with generated profiles, for its
// development: npm start, then /flame-graph-viewer.html (flamegraph/playground.jsx).
//
// We could also embed speedscope (http://jamie-wong.com/post/speedscope/), but it has no diffs
// (https://github.com/jlfwong/speedscope/issues/228).
import { useQuery } from "@tanstack/react-query";

import { fileQuery } from "../api/queries";
import { ViewerError, ViewerLoading } from "./ViewerStates";
import { useLabels } from "../hooks";
import { FlameGraphReport } from "./flamegraph/FlameGraphReport";
import { decodeProfileBytes } from "./flamegraph/formats";

// gzipped profiles (cpu.folded.gz) are fetched as bytes, and decompressed in the browser.
// Files are cached: switching between views doesn't fetch them again.
const profileQuery = (url, is_running) => {
  if (!/\.gz$/i.test(url ?? ''))
    return fileQuery(url, { is_running, responseType: 'text' });
  const query = fileQuery(url, { is_running, responseType: 'arraybuffer' });
  return { ...query, queryKey: [...query.queryKey, 'gzip'], queryFn: context => query.queryFn(context).then(decodeProfileBytes) };
};

// unit: the values' unit, from the visualization's options in qaboard.yaml: it wins over the file's `# unit:` line
const FlameGraphViewer = ({ output_new, output_ref, path, labels: labels_, unit }) => {
  const labels = useLabels(labels_);
  const url_new = output_new?.output_dir_url && path ? `${output_new.output_dir_url}/${path}` : undefined;
  const url_ref = url_new && output_ref?.output_dir_url ? `${output_ref.output_dir_url}/${path}` : undefined;
  const query_new = useQuery(profileQuery(url_new, output_new?.is_running));
  // without the reference's profile, we show the new one alone
  const query_ref = useQuery(profileQuery(url_ref, output_ref?.is_running));

  if (query_new.isError) return <ViewerError path={path} error={query_new.error}/>;
  if (!url_new || query_new.isPending || (url_ref && query_ref.isPending)) return <ViewerLoading/>;
  return <FlameGraphReport
    text_new={query_new.data}
    text_ref={query_ref.isSuccess ? query_ref.data : undefined}
    path={path}
    unit={unit}
    labels={labels}
  />;
};


export default FlameGraphViewer;
