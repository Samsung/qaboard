// The parallel coordinates of Tuning Analysis: loads the standalone viewer (viewers/parallel/) when a report shows it.
import { lazy, Suspense } from "react";
import { Spinner } from "@blueprintjs/core";

const ParallelCoordinates = lazy(() => import("../../viewers/parallel/ParallelCoordinates"));

// As tall as the plot, so that the page doesn't jump when it shows
const ParallelCoordinatesPlot = ({ height = 420, ...props }) => <Suspense fallback={<div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
  <Spinner size={16} aria-label="Loading the plot"/>
</div>}>
  <ParallelCoordinates height={height} {...props}/>
</Suspense>;

export default ParallelCoordinatesPlot;
