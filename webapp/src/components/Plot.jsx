// Plotly is ~1MB gzipped: it is only downloaded when a plot is rendered.
import { lazy, Suspense } from "react";

const PlotlyPlot = lazy(() => import("./PlotlyPlot"));

const Plot = props => <Suspense fallback={<div style={props.style}/>}>
  <PlotlyPlot {...props}/>
</Suspense>

export default Plot;
