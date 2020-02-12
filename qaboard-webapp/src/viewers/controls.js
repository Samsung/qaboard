import qs from "qs";



const controls_defaults = qatools_config => {
  let state_controls = {
    show: {},
  };
  if (!!qatools_config && !!qatools_config.outputs) {
    let controls = qatools_config.outputs.controls || [];
    controls.forEach(control => {
      state_controls[control.name] = control.default;
    })
    const outputs = qatools_config.outputs;
    let visualizations = outputs.visualizations || outputs.detailed_views || []
    visualizations.forEach( (view, idx) => {
      if (view.default_hidden)
        state_controls.show[view.name] = false;
    })
  }

  let query = qs.parse(window.location.search.substring(1));
  if (!!query.controls) {
    try {
      var query_controls = JSON.parse(query.controls)      
    } catch {
      query_controls = {}
    }
    Object.entries(query_controls).forEach( ([key, value]) => {
      state_controls[key] = value;
    })
  }
  return state_controls;
}



const updateQueryUrl = (history, controls) => {
  if (history === undefined || controls === undefined)
    return
  let query = qs.parse(window.location.search.substring(1));
  history.push({
    pathname: window.location.pathname,
    search: qs.stringify({
      ...query,
      controls: JSON.stringify(controls),
    })
  });
}

export { controls_defaults, updateQueryUrl }