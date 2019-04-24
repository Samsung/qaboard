import qs from "qs";



const controls_defaults = props => {
  let state_controls = {
    show: {},
  };
  if (!!props.project_data &&
      !!props.project_data.data &&
      !!props.project_data.data.qatools_config &&
      !!props.project_data.data.qatools_config.outputs) {
    let controls = props.project_data.data.qatools_config.outputs.controls || [];
    controls.forEach(control => {
      state_controls[control.name] = control.default;
    })
    let detailed_views = props.project_data.data.qatools_config.outputs.detailed_views || []
    detailed_views.forEach( (view, idx) => {
      if (view.default_hidden)
        state_controls.show[view.name] = false;
    })
  }

  let query = qs.parse(window.location.search.substring(1));
  if (!!query.controls) {
    let query_controls = JSON.parse(query.controls)
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