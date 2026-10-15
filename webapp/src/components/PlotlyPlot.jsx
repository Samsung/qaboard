// The prebuilt bundle is already minified, it keeps our builds fast
import Plotly from "plotly.js/dist/plotly.min.js";
import createPlotlyComponent from "react-plotly.js/factory";
import { useIsDark } from "../theme";

const BasePlot = createPlotlyComponent(Plotly);

// Since plotly.js@3, titles must be objects ({text, font...}).
// Users' output files and older code may still use strings or `titlefont`, so we upgrade them in-place.
// It's idempotent, and in-place like plotly.js itself to avoid triggering re-renders.
const upgradeTitle = obj => {
  if (obj === null || typeof obj !== "object") return;
  if (typeof obj.title === "string" || typeof obj.title === "number")
    obj.title = { text: obj.title };
  if (obj.titlefont !== undefined) {
    obj.title = { ...obj.title, font: obj.titlefont };
    delete obj.titlefont;
  }
};

const is_axis = key => /^[xyz]axis\d*$/.test(key) || /^(scene|polar|ternary|coloraxis)\d*$/.test(key);

export const upgradeFigure = (data, layout) => {
  if (layout && typeof layout === "object") {
    upgradeTitle(layout);
    Object.entries(layout).forEach(([key, value]) => {
      if (!is_axis(key) || !value || typeof value !== "object") return;
      upgradeTitle(value);
      Object.entries(value).forEach(([subkey, subvalue]) => is_axis(subkey) && upgradeTitle(subvalue));
      upgradeTitle(value.colorbar);
    });
  }
  (Array.isArray(data) ? data : []).forEach(trace => {
    upgradeTitle(trace?.colorbar);
    upgradeTitle(trace?.marker?.colorbar);
  });
};

// In the dark theme, figures that don't pick their own colors get readable defaults (Blueprint's dark palette)
const axis = { gridcolor: "#383e47", zerolinecolor: "#5f6b7c", linecolor: "#5f6b7c" };
export const dark_template = {
  layout: {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#d3d8de" },
    xaxis: axis, yaxis: axis,
    scene: { xaxis: axis, yaxis: axis, zaxis: axis },
    polar: { bgcolor: "rgba(0,0,0,0)", radialaxis: axis, angularaxis: axis },
    legend: { bgcolor: "rgba(0,0,0,0)" },
    hoverlabel: { bgcolor: "#2f343c", bordercolor: "#5f6b7c", font: { color: "#f6f7f9" } },
    modebar: { bgcolor: "rgba(0,0,0,0)", color: "#abb3bf", activecolor: "#f6f7f9" },
  },
};

// In-place too: we only set or remove our own template
export const applyTemplate = (layout, dark) => {
  if (!layout || typeof layout !== "object") return;
  if (dark && layout.template === undefined)
    layout.template = dark_template;
  else if (!dark && layout.template === dark_template)
    delete layout.template;
};

const PlotlyPlot = props => {
  const dark = useIsDark();
  upgradeFigure(props.data, props.layout);
  applyTemplate(props.layout, dark);
  // react-plotly.js only updates unchanged figures on a new revision
  const revision = `${props.revision ?? ''}-${dark ? 'dark' : 'light'}`;
  return <BasePlot {...props} revision={revision}/>;
};

export default PlotlyPlot;
