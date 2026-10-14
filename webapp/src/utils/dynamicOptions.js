import { parse, compile } from 'path-to-regexp';
import { matchPath } from "../router";

// Adapted from
// https://github.com/ReactTraining/react-router/blob/82ce94c3b4e74f71018d104df6dc999801fa9ab2/packages/react-router/modules/matchPath.js
const cache = {};
const cacheLimit = 10000;
let cacheCount = 0;
function compilePath(path) {
  if (cache[path]) return cache[path];
  const regexp = compile(path);
  if (cacheCount < cacheLimit) {
    cache[path] = regexp;
    cacheCount++;
  }
  return regexp;
}

// Extract meaningful context from path for unnamed groups
function extractPathContext(path) {
  if (!path) return null;
  
  // For paths like ":frame/output.jpg" or "(.*)/debug.jpg"
  // Try to identify what the capturing group represents
  
  if (path.includes(':frame')) return 'frame';
  if (path.includes(':step')) return 'step';
  if (path.includes(':iteration')) return 'iteration';
  if (path.includes(':number')) return 'number';
  
  // For regex patterns like "(.*\.jpg)" or "(debug_.*)"
  // match the escaped dot (.*\.jpg) and the plain one (.*.jpg)
  if (path.includes('.*\\.jpg') || path.includes('.*.jpg')) return 'jpg_files';
  if (path.includes('.*\\.png') || path.includes('.*.png')) return 'png_files';
  if (path.includes('debug_.*')) return 'debug_files';
  if (path.includes('.*')) return 'files';
  
  // Extract from the pattern itself - look for context around the group
  const beforePattern = path.split('(')[0] || '';
  const afterPattern = path.split(')')[1] || '';
  
  if (beforePattern.includes('/')) {
    const dir = beforePattern.split('/').pop();
    if (dir) return dir;
  }
  
  if (afterPattern.includes('.')) {
    const ext = afterPattern.split('.')[1];
    if (ext) return ext;
  }
  
  return null;
}

// Extract option parsing logic from OutputCard.js
export const parseVisualizationOptions = views => {
  const options = {};
  const parseErrors = [];
  
  views.forEach((view, idx) => {
    if (view.path === undefined) return;
    
    let viewOptions;
    try {
      viewOptions = parse(view.path);
    } catch (error) {
      parseErrors.push({ path: view.path, message: error.message });
      return;
    }
    
    viewOptions.forEach(token => {
      if (token.name === undefined) return; // static part
      
      if (Number.isInteger(token.name)) {
        // Unnamed groups get descriptive names based on their position in the path
        token.unnamed_group = token.name;
        
        // Extract the part of the path this group corresponds to
        const pathPart = extractPathContext(view.path);
        const viewIdentifier = view.name || pathPart || `view_${idx}`;
        const cleanPath = viewIdentifier.replace(/[^a-zA-Z0-9]/g, '_');
        
        // Only add group suffix if there are multiple groups in this view
        const groupCount = viewOptions.filter(t => Number.isInteger(t.name)).length;
        const suffix = groupCount > 1 ? `_group_${token.name}` : '';
        token.name = `${cleanPath}${suffix}`;
      }
      
      if (options[token.name] === undefined) {
        options[token.name] = { views: [], paths: [] };
      }
      
      options[token.name] = { ...options[token.name], ...token };
      options[token.name].views.push(view.name);
      options[token.name].paths.push(view.path);
    });
  });
  
  return { options, parseErrors };
};

// "2" before "10"
const by_value = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// Calculate available values for an option based on manifest paths (optimized)
export const calculateOptionValues = (option, manifestPaths) => {
  const values = new Set();
  
  manifestPaths.forEach(path => {
    option.paths.forEach(optionPath => {
      const match = matchPath(path, { path: optionPath });
      if (match === null || match === undefined) return;
      
      const name = option.unnamed_group !== undefined ? option.unnamed_group : option.name;
      if (match.params[name]) {
        values.add(match.params[name]);
      }
    });
  });
  
  return Array.from(values.values()).sort(by_value);
};

// Determine option type and configuration
export const configureOption = (option, values) => {
  const hasMultipleValues = values.length > 1;
  const allIsInteger = hasMultipleValues && values.length > 0 && values.every(v => Number.isInteger(Number(v)));
  const allNumbers = allIsInteger && values.every(v => !isNaN(parseFloat(v)));
  
  if (allIsInteger) {
    const toRaw = {};
    let min = Infinity;
    let max = -Infinity;
    const numericValues = new Set();
    
    values.forEach(v => {
      const vNum = parseFloat(v);
      if (vNum < min) min = vNum;
      if (vNum > max) max = vNum;
      toRaw[vNum] = v;
      numericValues.add(vNum);
    });
    
    const range = [...Array(max - min + 1).keys()].map(v => v + min);
    const sequential = range.every(idx => numericValues.has(idx));
    
    return {
      ...option,
      values,
      type: sequential ? 'slider' : 'select',
      toRaw,
      min,
      max,
      numericValues,
      defaultValue: toRaw[max]
    };
  } else {
    return {
      ...option,
      values,
      type: 'select',
      defaultValue: values[allNumbers ? values.length - 1 : 0]
    };
  }
};

// Generate paths for a view with selected options
export const generateViewPaths = (view, selectedOptions, manifests) => {
  if (view.display === 'viewer' || view.path === undefined) {
    return [view.path];
  }
  
  const { options: viewOptions } = parseVisualizationOptions([view]);
  const relevantOptions = Object.values(viewOptions).filter(option => 
    option.views.includes(view.name)
  );
  
  if (view.display === undefined || view.display === 'single') {
    if (relevantOptions.length === 0) {
      return [view.path];
    }
    
    // Check if all required options have selected values
    const missingOptions = relevantOptions.some(option => 
      !selectedOptions[option.name] || selectedOptions[option.name].length === 0
    );
    
    if (missingOptions) {
      // For single display, fall back to first matching path only
      const manifestPaths = Object.keys(manifests.new || {});
      const matchingPaths = manifestPaths.filter(path => {
        try {
          const match = matchPath(path, { path: view.path });
          return match !== null && match !== undefined;
        } catch {
          return false;
        }
      });
      // Return only first match for single display
      return matchingPaths.length > 0 ? [matchingPaths[0]] : [];
    }
    
    const optionsSelected = relevantOptions.map(option => [
      option.unnamed_group !== undefined ? option.unnamed_group : option.name,
      selectedOptions[option.name][0]
    ]);
    
    try {
      const compiledPath = compilePath(view.path);
      return [compiledPath(Object.fromEntries(optionsSelected))];
    } catch (error) {
      console.warn('Failed to compile path:', view.path, error);
      return [];
    }
  } else if (view.display === 'all') {
    const manifestPaths = Object.keys(manifests.new || {});
    return manifestPaths.filter(path => matchPath(path, { path: view.path }));
  }
  
  return [];
};

// The options of all output cards, as one: what the controls panel shows.
// Runs often have different values (e.g. a different number of frames): we take them all,
// and each card shows the value closest to the one selected (see resolveOptionValue).
export const mergeOptions = optionsList => {
  const merged = {};
  for (const options of optionsList) {
    for (const [name, option] of Object.entries(options)) {
      // what configureOption computes from the values is computed again
      const { values, type: _type, toRaw: _toRaw, min: _min, max: _max, numericValues: _numericValues, defaultValue: _defaultValue, ...rest } = option;
      merged[name] ??= { ...rest, views: [], paths: [], all_values: new Set() };
      const m = merged[name];
      for (const view of option.views ?? []) if (!m.views.includes(view)) m.views.push(view);
      for (const path of option.paths ?? []) if (!m.paths.includes(path)) m.paths.push(path);
      for (const value of values ?? []) m.all_values.add(value);
    }
  }
  return Object.fromEntries(Object.entries(merged).map(([name, { all_values, ...option }]) =>
    [name, configureOption(option, [...all_values].sort(by_value))]
  ));
};

// Which of an option's values to show, given the one we want (e.g. selected for all cards).
// When it's missing, e.g. the run has fewer frames, we use the closest number, or the default.
// {exact: false} lets us tell users why they don't see what they selected.
export const resolveOptionValue = (option, wanted) => {
  const values = option.values ?? [];
  if (wanted === undefined || wanted === null)
    return { value: option.defaultValue, exact: true };
  if (values.includes(wanted))
    return { value: wanted, exact: true };
  const target = Number(wanted);
  if (values.length > 0 && wanted !== '' && !isNaN(target) && values.every(v => v !== '' && !isNaN(Number(v)))) {
    const distance = v => Math.abs(Number(v) - target);
    const closest = values.reduce((best, v) => distance(v) < distance(best) ? v : best);
    return { value: closest, exact: false };
  }
  return { value: option.defaultValue, exact: false };
};
