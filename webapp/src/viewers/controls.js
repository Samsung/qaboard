import { useState } from "react";

import { parse_query, updateSelected } from "../selection";

const parse_query_controls = search => {
  const query = parse_query(search);
  if (!query.controls) return {};
  try {
    const controls = JSON.parse(query.controls);
    return controls !== null && typeof controls === 'object' && !Array.isArray(controls) ? controls : {};
  } catch {
    return {};
  }
}

// The visual controls of the outputs: defaults from the project's configuration, overriden by ?controls= in the URL
const controls_defaults = (qatools_config, search = window.location.search) => {
  const outputs = qatools_config?.outputs;
  const show = {};
  const from_config = {};
  for (const control of outputs?.controls ?? [])
    from_config[control.name] = control.default;
  for (const view of outputs?.visualizations ?? outputs?.detailed_views ?? []) {
    if (view.default_hidden)
      show[view.name] = false;
  }
  // The URL only has what differs from the defaults
  const from_url = parse_query_controls(search);
  return {
    ...from_config,
    ...from_url,
    show: { ...show, ...from_url.show },
    dynamic_options: { ...from_url.dynamic_options },
    dynamic_options_sync: { ...from_url.dynamic_options_sync },
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const drop_empty = object => Object.keys(object).length === 0 ? undefined : object;

// What differs from the defaults: that's all we need in URLs, which stay short
const controls_changes = (controls, defaults) => {
  const changes = {};
  for (const [key, value] of Object.entries(controls)) {
    if (value === undefined) continue;
    if (key === 'show')
      // visualizations are shown unless hidden by default
      changes.show = drop_empty(Object.fromEntries(Object.entries(value ?? {}).filter(([name, shown]) => shown !== (defaults.show[name] ?? true))));
    else if (key === 'dynamic_options' || key === 'dynamic_options_sync')
      changes[key] = drop_empty(Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined && v !== null)));
    else if (!same(value, defaults[key]))
      changes[key] = value;
  }
  return JSON.parse(JSON.stringify(changes)); // without undefined
}

// Saves the controls in the URL. Toggling visual controls replaces the history entry:
// users don't expect the back button to undo each toggle.
const save_controls = (controls, qatools_config) => {
  const changes = controls_changes(controls, controls_defaults(qatools_config, ''));
  updateSelected({ controls: Object.keys(changes).length > 0 ? JSON.stringify(changes) : undefined }, { replace: true });
}


// Controls of the output viewers (e.g. image diff on/off), which visualizations are shown,
// and the values of dynamic options: [controls, setControls]
const useViewerControls = config => {
  const [controls, setControls] = useState(() => controls_defaults(config));
  // When the configuration changes, we keep users' choices
  const [controls_outputs, setControlsOutputs] = useState(config?.outputs);
  if (controls_outputs !== config?.outputs) {
    setControlsOutputs(config?.outputs);
    const defaults = controls_defaults(config);
    setControls({
      ...defaults,
      show: { ...defaults.show, ...controls.show },
      dynamic_options: controls.dynamic_options || {},
      dynamic_options_sync: controls.dynamic_options_sync || {},
    });
  }
  const update = controls => {
    setControls(controls);
    save_controls(controls, config);
  };
  return [controls, update];
}

export { controls_changes, controls_defaults, save_controls, useViewerControls }
