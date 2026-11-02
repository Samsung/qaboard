// Plotly is ~1MB gzipped: it is only downloaded when a plot is rendered.
import { lazy, Suspense } from "react";
import { Spinner } from "@blueprintjs/core";

const PlotlyPlot = lazy(() => import("./PlotlyPlot"));

// Same size as the plot, so that the page doesn't jump when it shows
const Placeholder = ({ style, layout }) => <div style={{ width: layout?.width, height: layout?.height, ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
  <Spinner size={16} aria-label="Loading the plot"/>
</div>

const Plot = props => <Suspense fallback={<Placeholder style={props.style} layout={props.layout}/>}>
  <PlotlyPlot {...props}/>
</Suspense>

export default Plot;
