import React, { lazy, Suspense } from "react";
import { is_image } from "./images/utils"

const LoadableTextViewer = lazy(() => import('./textViewer' /* webpackChunkName: "text-viewer" */));
const LoadableImageViewer = lazy(() => import('./images/images' /* webpackChunkName: "image-viewer" */));
const LoadableVideoViewer = lazy(() => import('./videos' /* webpackChunkName: "video-viewer" */));
const LoadableHtmlViewer = lazy(() => import('./html' /* webpackChunkName: "html-viewer" */));
const LoadableBitAccuracyViewer = lazy(() => import('./bit_accuracy/bitAccuracyViewer' /* webpackChunkName: "bit-accuracy-viewer" */));
const LoadablePlotlyViewer = lazy(() => import('./plotly' /* webpackChunkName: "plotly-viewer" */));
const LoadableTofViewer = lazy(() => import('./tof/TofOutputCard' /* webpackChunkName: "tof-viewer" */));
const LoadableSlamViewer = lazy(() => import('./slam/SlamOutputCard' /* webpackChunkName: "slam-viewer" */));

const OutputViewer = props_ => {
    const { type, output_ref, ...props } = props_;
    const maybe_output_ref = (props_.show_reference === undefined || props_.show_reference) ? output_ref : undefined;
    let viewer;
    if (is_image(props_)) {
      viewer =  <LoadableImageViewer {...props} output_ref={maybe_output_ref}/>
    } else
    if (!!type) {
      if (type === "6dof/txt")
        viewer =  <LoadableSlamViewer {...props} output_ref={maybe_output_ref}/>
      else if (type === "pointcloud/txt")
        viewer = <LoadableTofViewer {...props} output_ref={maybe_output_ref}/>
      else if (type === "plotly/json")
        viewer = <LoadablePlotlyViewer {...props} output_ref={maybe_output_ref}/>
      else if (type.startsWith('video'))
        viewer = <LoadableVideoViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type.startsWith('image'))
        viewer = <LoadableImageViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type === 'text/plain')
        viewer = <LoadableTextViewer {...props} type={type} output_ref={output_ref}/>
      else if (type === 'text/html')
        viewer = <LoadableHtmlViewer {...props} type={type} output_ref={maybe_output_ref}/>
      else if (type === 'files/bit-accuracy')
        viewer = <LoadableBitAccuracyViewer {...props} type={type} output_ref={output_ref}/>
      else viewer = <span>No viewer is defined for type: {type}</span>;
    } else {
      const { path='' } = props_;
      if (path.endsWith('plotly.json')) {
        viewer = <LoadablePlotlyViewer {...props} type={type} output_ref={maybe_output_ref}/>
      } else if (path.endsWith('html')) {
        viewer = <LoadableHtmlViewer {...props} type={type} output_ref={maybe_output_ref}/>
      } else {
        viewer = <LoadableTextViewer {...props} type={type} output_ref={output_ref}/>
      }
    }
  return (
    <Suspense fallback={<span/>}>
      {viewer}
    </Suspense>
  );
}


export { OutputViewer };