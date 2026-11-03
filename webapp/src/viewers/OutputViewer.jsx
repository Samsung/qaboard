import React, { lazy, Suspense, useEffect, useState } from "react";
import {
  Button,
} from "@blueprintjs/core";

import { useComparison, useSiteConfig } from "../hooks";
import { track } from "../analytics";
import { is_image } from "./images/utils"
import { ViewerLoading } from "./ViewerStates"


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
const LoadableJunitViewer = lazy(() => import('./junit/JunitViewer'));

// JUnit XML test reports: junit.xml, report.junit.xml, Maven's and Gradle's TEST-*.xml
export const is_junit = path => /(^|\/)(junit|[^/]*[._-]junit|TEST-[^/]*)\.xml$/i.test(path || '');

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
    // what shows it, for the usage analytics
    let kind = null;
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
        kind = image_viewer === 'text' ? 'text' : 'images';
      } else {
        viewer =  <LoadableImageViewer {...props} output_ref={maybe_output_ref}/>
        kind = 'images';
      }
    } else
    if (!!type) {
      if (type === "6dof/txt") {
        viewer =  <LoadableSlamViewer {...props} output_ref={maybe_output_ref}/>
        kind = 'slam';
      } else if (type === "pointcloud/txt") {
        viewer = <LoadableTofViewer {...props} output_ref={maybe_output_ref}/>
        kind = 'tof';
      } else if (type === "pointcloud/pcd") {
        viewer = <LoadablePointCloudViewer {...props} output_ref={maybe_output_ref}/>
        kind = 'pointcloud';
      } else if (type === "plotly/json" || type === "plotly/html") {
        viewer = <LoadablePlotlyViewer {...props} output_ref={maybe_output_ref}/>
        kind = 'plotly';
      } else if (type.startsWith('video')) {
        viewer = <LoadableVideoViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'video';
      } else if (type.startsWith('image')) {
        viewer = <LoadableImageViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'images';
      } else if (type === 'text/plain') {
        viewer = <LoadableTextViewer {...props} type={type} output_ref={output_ref}/>
        kind = 'text';
      } else if (type === 'text/html') {
        viewer = <LoadableHtmlViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'html';
      } else if (type === 'flame/json') {
        viewer = <LoadableFlameGraphViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'flame_graph';
      } else if (type === 'junit/xml') {
        viewer = <LoadableJunitViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'junit';
      } else if (type === 'files/bit-accuracy') {
        viewer = <LoadableBitAccuracyViewer {...props} type={type} output_ref={output_ref}/>
        kind = 'bit_accuracy';
      } else viewer = <p>
        No viewer for the type <code>{type}</code>. <a href={`${docs_root}docs/visualizations`} target="_blank" rel="noopener noreferrer">See the supported types</a>
      </p>;
    } else {
      const { path='' } = props_;
      if (path.endsWith('plotly.json') || path.endsWith('plotly.html')) {
        viewer = <LoadablePlotlyViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'plotly';
      } else if (path.endsWith('.pcd')) {
        viewer = <LoadablePointCloudViewer {...props} output_ref={maybe_output_ref}/>
        kind = 'pointcloud';
      } else if (path.endsWith('flame.json')) {
        viewer = <LoadableFlameGraphViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'flame_graph';
      } else if (is_junit(path)) {
        viewer = <LoadableJunitViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'junit';
      } else if (path.endsWith('html')) {
        viewer = <LoadableHtmlViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'html';
      } else if (/\.(mp4|m4v|mov|webm|mkv|ogv|webp|gif)$/i.test(path)) {
        viewer = <LoadableVideoViewer {...props} type={type} output_ref={maybe_output_ref}/>
        kind = 'video';
      } else {
        viewer = <LoadableTextViewer {...props} type={type} output_ref={output_ref}/>
        kind = 'text';
      }
    }
  // Usage analytics: a run's output is shown, once per run and viewer
  const output_id = props_.output_new?.id;
  const project_id = props_.project ?? comparison?.project;
  useEffect(() => {
    if (!kind || !output_id) return;
    track('output_open', { viewer: kind }, { project_id });
  }, [kind, output_id, project_id]);
  return (
    <Suspense fallback={<ViewerLoading height={props_.style?.height}/>}>
      {viewer}
    </Suspense>
  );
}


export { OutputViewer };