import { parse, compile } from 'path-to-regexp';
import { matchPath } from 'react-router';

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
function extractPathContext(path, token) {
  if (!path) return null;
  
  // For paths like ":frame/output.jpg" or "(.*)/debug.jpg"
  // Try to identify what the capturing group represents
  
  if (path.includes(':frame')) return 'frame';
  if (path.includes(':step')) return 'step';
  if (path.includes(':iteration')) return 'iteration';
  if (path.includes(':number')) return 'number';
  
  // For regex patterns like "(.*\.jpg)" or "(debug_.*)"
  if (path.includes('.*\.jpg')) return 'jpg_files';
  if (path.includes('.*\.png')) return 'png_files';
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
export const parseVisualizationOptions = (views, manifests = {}) => {
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
        const pathPart = extractPathContext(view.path, token);
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
  
  return Array.from(values.values()).sort((a, b) => a.localeCompare(b));
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
        } catch (error) {
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

// Merge compatible options from multiple outputs
export const mergeCompatibleOptions = (optionsList) => {
  const merged = {};
  
  optionsList.forEach(outputOptions => {
    Object.entries(outputOptions).forEach(([name, option]) => {
      if (!merged[name]) {
        const optionValues = option.values || [];
        merged[name] = {
          ...option,
          compatible_outputs: [option.output_id],
          all_values: new Set(optionValues)
        };
      } else {
        // Check if options are compatible (same type, overlapping values)
        const existingOption = merged[name];
        const optionValues = option.values || [];
        const hasOverlap = optionValues.some(v => existingOption.all_values.has(v));
        
        if (hasOverlap) {
          existingOption.compatible_outputs.push(option.output_id);
          optionValues.forEach(v => existingOption.all_values.add(v));
          existingOption.values = Array.from(existingOption.all_values).sort((a, b) => a.localeCompare(b));
        } else {
          // Create separate option for incompatible values
          const incompatibleName = `${name}_${option.output_id}`;
          merged[incompatibleName] = {
            ...option,
            name: incompatibleName,
            compatible_outputs: [option.output_id],
            all_values: new Set(optionValues)
          };
        }
      }
    });
  });
  
  // Convert sets back to arrays and reconfigure options
  Object.values(merged).forEach(option => {
    if (option.all_values) {
      const finalValues = Array.from(option.all_values).sort((a, b) => a.localeCompare(b));
      Object.assign(option, configureOption(option, finalValues));
      delete option.all_values;
    }
  });
  
  return merged;
};

// Check if an option is compatible with a specific output
export const isOptionCompatible = (option, outputId) => {
  return !option.compatible_outputs || option.compatible_outputs.includes(outputId);
};

// Get sync preferences from localStorage
export const getSyncPreferences = () => {
  try {
    const saved = localStorage.getItem('dynamic-options-sync');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
};

// Save sync preferences to localStorage
export const setSyncPreferences = (preferences) => {
  try {
    localStorage.setItem('dynamic-options-sync', JSON.stringify(preferences));
  } catch (error) {
    console.warn('Failed to save sync preferences:', error);
  }
};