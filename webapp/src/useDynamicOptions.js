// Visualizations can have "dynamic options" (e.g. which frame to show), discovered from each output's files.
// Output cards register their options as they load; we merge them to show common controls.
//
// Cards register one by one, possibly thousands of them: we collect registrations without re-rendering,
// and merge them at most a few times per second.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { matchPath } from "./router";
import { mergeOptions } from "./utils/dynamicOptions";

const FLUSH_DELAY = 150;

// The names of the visualizations that have files in a manifest
export const visualizations_with_files = (config, manifest) => {
  const outputs = config?.outputs || {};
  const views = [...(outputs.visualizations || []), ...(outputs.detailed_views || [])];
  const paths = Object.keys(manifest || {});
  const found = new Set();
  views.forEach(view => {
    if (!view.path) return;
    // For simple paths (no patterns), check direct existence
    const has_file = (!view.path.includes(':') && !view.path.includes('('))
      ? paths.includes(view.path)
      : paths.some(path => {
          try {
            return !!matchPath(path, { path: view.path });
          } catch {
            return false;
          }
        });
    if (has_file) found.add(view.name || view.path);
  });
  return found;
};

const empty_state = { options: {}, with_files: new Set() };
const empty_registry = () => ({ options: new Map(), with_files: new Set(), timer: null, dirty: false });


// reset_key: registrations are forgotten when it changes (e.g. another commit or batch)
// files_key: which visualizations have files is forgotten when it changes (e.g. the filter)
export function useDynamicOptions({ config, reset_key, files_key }) {
  const registry = useRef(empty_registry());
  const [state, setState] = useState(empty_state);

  const flush = () => {
    const r = registry.current;
    r.timer = null;
    if (!r.dirty) return;
    r.dirty = false;
    const options = mergeOptions([...r.options.values()]);
    // Most registrations change nothing: we keep the same objects, so that output cards don't re-render
    setState(state => {
      const same_options = JSON.stringify(options) === JSON.stringify(state.options);
      const same_files = r.with_files.size === state.with_files.size && [...r.with_files].every(name => state.with_files.has(name));
      return same_options && same_files ? state : {
        options: same_options ? state.options : options,
        with_files: same_files ? state.with_files : new Set(r.with_files),
      };
    });
  };
  const schedule = () => {
    const r = registry.current;
    r.dirty = true;
    if (r.timer === null) r.timer = setTimeout(flush, FLUSH_DELAY);
  };

  const [last_reset_key, setLastResetKey] = useState(reset_key);
  if (reset_key !== last_reset_key) {
    setLastResetKey(reset_key);
    setState(empty_state);
  }
  // Layout effects run before the passive effects in which output cards register: we don't lose their registrations
  const reset_keys = useRef({ reset_key, files_key });
  useLayoutEffect(() => {
    const previous = reset_keys.current;
    reset_keys.current = { reset_key, files_key };
    const r = registry.current;
    if (previous.reset_key !== reset_key) {
      clearTimeout(r.timer);
      registry.current = empty_registry();
    } else if (previous.files_key !== files_key) {
      r.with_files = new Set();
      setState(state => ({ ...state, with_files: new Set() }));
    }
  }, [reset_key, files_key]);
  useEffect(() => () => clearTimeout(registry.current.timer), []);

  const latest_config = useRef(config);
  useEffect(() => { latest_config.current = config });

  const register = (output_id, options, manifest) => {
    const r = registry.current;
    if (manifest)
      for (const name of visualizations_with_files(latest_config.current, manifest))
        r.with_files.add(name);
    r.options.set(output_id, options);
    schedule();
  };
  return {
    dynamic_options: state.options,
    visualizations_with_files: state.with_files,
    register,
  };
}
