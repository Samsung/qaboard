import React, { lazy, Suspense, useState } from "react";
import {
  Button,
} from "@blueprintjs/core";

import { useComparison, useSiteConfig } from "../hooks";
import { is_image } from "./images/utils"
import { is_series } from "./series/series"
import { ViewerLoading } from "./ViewerStates"
import { ErrorBoundary } from "../components/ErrorBoundary"
import { ViewerErrorFallback } from "../components/ErrorFallback"


const LoadableTextViewer = lazy(() => import('./textViewer' /* webpackChunkName: "text-viewer" */));
const LoadableImageViewer = lazy(() => import('./images/QaboardImageViewer'));
const LoadableVideoViewer = lazy(() => import('./videos/VideoViewer' /* webpackChunkName: "video-viewer" */));
const LoadableHtmlViewer = lazy(() => import('./html' /* webpackChunkName: "html-viewer" */));
const LoadableBitAccuracyViewer = lazy(() => import('./bit_accuracy/bitAccuracyViewer' /* webpackChunkName: "bit-accuracy-viewer" */));
const LoadablePlotlyViewer = lazy(() => import('./plotly' /* webpackChunkName: "plotly-viewer" */));
const LoadableTofViewer = lazy(() => import('./tof/TofOutputCard' /* webpackChunkName: "tof-viewer" */));
const LoadablePointCloudViewer = lazy(() => import('./pointcloud/PointCloudViewer' /* webpackChunkName: "pointcloud-viewer" */));
const LoadableSlamViewer = lazy(() => import('./slam/SlamOutputCard' /* webpackChunkName: "slam-viewer" */));
const LoadableFlameGraphViewer = lazy(() => import('./flame-graph' /* webpackChunkName: "flame-graph-viewer" */));
// Profiles the flame graph viewer reads (flamegraph/formats.js): QA-Board's *flame.json, folded stacks, speedscope,
// Chrome's .cpuprofile, gzipped or not. Other names need `type: flame`
export const is_flame_graph = path => /(flame\.json|\.folded|\.collapsed|\.stacks\.txt|\.speedscope\.json|\.cpuprofile)(\.gz)?$/i.test(path || '');
const LoadableJunitViewer = lazy(() => import('./junit/JunitViewer'));

// JUnit XML test reports: junit.xml, report.junit.xml, Maven's and Gradle's TEST-*.xml
export const is_junit = path => /(^|\/)(junit|[^/]*[._-]junit|TEST-[^/]*)\.xml$/i.test(path || '');

// The viewers in their own folder (src/image-viewer, benchmarks, flamegraph) are standalone components: the app only loads
// their adapters, lazily, and they import nothing from the app (viewers/__tests__/isolation.test.js)
const LoadableBenchmarksViewer = lazy(() => import('./benchmarks-viewer'));
// Benchmark files: benchmarks.json, pytest.benchmarks.json, codec-bench.jsonl... Not a bare bench.json: projects had
// files with that name before the viewer. Other names need `type: benchmarks`. Files picked by their name that aren't
// benchmark files are shown as text, as before.
export const is_benchmarks = path => /(^|\/)(([^/]*[._-])?benchmarks?|[^/]*[._-]bench)\.(json|jsonl|ndjson)$/i.test(path || '');

// What runs logged while they ran, e.g. a training's loss per step: series.json (written by run.log() in Python, see
// qaboard/series.py), series.jsonl, train.series.json... Other names need `type: series`. Files picked by their name
// that aren't series files are shown as text.
const LoadableSeriesViewer = lazy(() => import('./series'));

// labels: what the viewers call the new and reference results, and their colors, by default those of the page
// (useComparison().labels): milestones' names, what users called them...
const OutputViewer = props_ => {
    const [image_viewer, setImageViewer] = useState('image')
    const { docs_root } = useSiteConfig();
    const comparison = useComparison();

    const { type, output_ref, ...props_rest } = props_;
    const props = { ...props_rest, labels: props_.labels ?? comparison?.labels };
    const maybe_output_ref = (props_.show_reference === undefined || props_.show_reference) ? output_ref : undefined;
    let viewer;
    if (is_image(props_)) {
      if (props_.path.endsWith('hex')) {
        viewer = <>
          <div><Button size="small" variant="minimal" icon={image_viewer === 'image' ? 'numerical' : 'media'} onClick={() => setImageViewer(image_viewer === 'image' ? 'text' : 'image')}>{image_viewer === 'image' ? 'Show as text' : 'Show as image'}</Button></div>
          <div>
          {image_viewer === 'text' ? 
              <LoadableTextViewer renderSideBySide={false} {...props} type={type} output_ref={output_ref}/>
            : <LoadableImageViewer {...props} output_ref={maybe_output_ref}/>
          }
          </div>
        </>
      } else {
        viewer =  <LoadableImageViewer {...props} output_ref={maybe_output_ref}/>
      }
    } else
    if (!!type) {
      if (type === "6dof/txt")
        viewer =  <LoadableSlamViewer {...props} output_ref={maybe_output_ref}/>
      else if (type === "pointcloud/txt")
        viewer = <LoadableTofViewer {...props} output_ref={maybe_output_ref}/>
      else if (type === "pointcloud/pcd")
        viewer = <LoadablePointCloudViewer {...props} output_ref={maybe_output_ref}/>
      else if (type === "plotly/json" || type === "plotly/html")
        viewer = <LoadablePlotlyViewer {...props} output_ref={maybe_output_ref}/>
      else if (type.startsWith('video'))
        viewer = <LoadableVideoViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type.startsWith('image'))
        viewer = <LoadableImageViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type === 'text/plain')
        viewer = <LoadableTextViewer {...props} type={type} output_ref={output_ref}/>
      else if (type === 'text/html')
        viewer = <LoadableHtmlViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type.startsWith('flame'))  // flame/json, flame/folded...: the viewer reads the content
        viewer = <LoadableFlameGraphViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type === 'junit/xml')
        viewer = <LoadableJunitViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type === 'benchmarks' || type.startsWith('benchmarks/'))
        viewer = <LoadableBenchmarksViewer {...props} format={type.split('/')[1]} output_ref={maybe_output_ref}/>
      else if (type === 'series')
        viewer = <LoadableSeriesViewer {...props} output_ref={maybe_output_ref}/>
      else if (type === 'files/bit-accuracy')
        viewer = <LoadableBitAccuracyViewer {...props} type={type} output_ref={output_ref}/>
      else viewer = <p>
        No viewer for the type <code>{type}</code>. <a href={`${docs_root}docs/visualizations`} target="_blank" rel="noopener noreferrer">See the supported types</a>
      </p>;
    } else {
      const { path='' } = props_;
      if (path.endsWith('plotly.json') || path.endsWith('plotly.html')) {
        viewer = <LoadablePlotlyViewer {...props} type={type} output_ref={maybe_output_ref}/>
      } else if (path.endsWith('.pcd')) {
        viewer = <LoadablePointCloudViewer {...props} output_ref={maybe_output_ref}/>
      } else if (is_flame_graph(path)) {
        viewer = <LoadableFlameGraphViewer {...props} type={type} output_ref={maybe_output_ref}/>
      } else if (is_junit(path)) {
        viewer = <LoadableJunitViewer {...props} type={type} output_ref={maybe_output_ref}/>
      } else if (is_benchmarks(path)) {
        viewer = <LoadableBenchmarksViewer {...props} output_ref={maybe_output_ref} fallback_to_text/>
      } else if (is_series(path)) {
        viewer = <LoadableSeriesViewer {...props} output_ref={maybe_output_ref} fallback_to_text/>
      } else if (path.endsWith('html')) {
        viewer = <LoadableHtmlViewer {...props} type={type} output_ref={maybe_output_ref}/>
      } else if (/\.(mp4|m4v|mov|webm|mkv|ogv|webp|gif)$/i.test(path)) {
        viewer = <LoadableVideoViewer {...props} type={type} output_ref={maybe_output_ref}/>
      } else {
        viewer = <LoadableTextViewer {...props} type={type} output_ref={output_ref}/>
      }
    }
  // a viewer that crashes, e.g. on a file it doesn't expect, doesn't take the run's card or the page with it.
  // It renders again when it shows another file.
  return (
    <ErrorBoundary name="viewer" resetKeys={[props_.path, props_.path_ref, output_ref?.id, props_.output_new?.id]} fallback={fallback => <ViewerErrorFallback {...fallback} path={props_.path}/>}>
      <Suspense fallback={<ViewerLoading height={props_.style?.height}/>}>
        {viewer}
      </Suspense>
    </ErrorBoundary>
  );
}


export { OutputViewer };