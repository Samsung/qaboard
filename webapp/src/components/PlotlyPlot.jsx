// The prebuilt bundle is already minified, it keeps our builds fast
import Plotly from "plotly.js/dist/plotly.min.js";
import createPlotlyComponent from "react-plotly.js/factory";

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

const PlotlyPlot = props => {
  upgradeFigure(props.data, props.layout);
  return <BasePlot {...props}/>;
};

export default PlotlyPlot;
