// Plotly is ~1MB gzipped: it is only downloaded when a plot is rendered.
import { lazy, Suspense } from "react";
import { Spinner } from "@blueprintjs/core";

const PlotlyPlot = lazy(() => import("./PlotlyPlot"));
// To show or hide a plot's hover label, e.g. from the keyboard. Plotly is loaded by then: the plot is drawn
export const hoverPlot = (gd, where) => import("./PlotlyPlot").then(m => m.hover(gd, where));
export const unhoverPlot = gd => import("./PlotlyPlot").then(m => m.unhover(gd));
// Changes attributes of a drawn plot's traces without drawing it again from scratch, e.g. { opacity: [1, 0.1] }
export const restylePlot = (gd, update) => import("./PlotlyPlot").then(m => m.restyle(gd, update));

// Same size as the plot, so that the page doesn't jump when it shows
const Placeholder = ({ style, layout }) => <div style={{ width: layout?.width, height: layout?.height, ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
  <Spinner size={16} aria-label="Loading the plot"/>
</div>

const Plot = props => <Suspense fallback={<Placeholder style={props.style} layout={props.layout}/>}>
  <PlotlyPlot {...props}/>
</Suspense>

export default Plot;
