import { interpolateRainbow } from "d3-scale-chromatic";
import md5 from "js-md5";

import { config_distance } from "./configurations/tokens";
import { setPathMappings, linux_to_windows } from "./utils/paths";
import { repo_url } from "./git";
import { toaster } from "./toaster";


const calendarStrings = {
  lastDay: "[Yesterday]",
  sameDay: "[Today]",
  nextDay: "[Tomorrow]",
  lastWeek: "[last] dddd",
  nextWeek: "dddd",
  sameElse: "L"
};

const average = array => {
  return array.filter(x => x !== undefined).reduce((a, b) => a + b, 0) / array.length;
};
const median = array => {
  const sorted = array.filter(x => x !== undefined && x !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Formats numbers like mathjs' format(value, {precision}), that we no longer bundle (65kB):
// `precision` significant digits rounded half up from the shortest representation (1.005 => "1.01"), no trailing zeros,
// exponential notation below 1e-3 and from 1e5. format(1234.5, {precision: 3}) => "1230", format(123456, {precision: 3}) => "1.23e+5"
const format = (value, { precision } = {}) => {
  if (!Number.isFinite(value)) return String(value);
  // 1234.5 => digits "12345", exponent 3
  const [, sign, mantissa, exp = '0'] = /^(-?)([\d.]+)(?:e([+-]\d+))?$/.exec(String(value));
  const dot = mantissa.indexOf('.');
  let digits = mantissa.replace('.', '');
  let exponent = Number(exp) + (dot === -1 ? mantissa.length : dot) - 1;
  const leading_zeros = /^0*/.exec(digits)[0].length;
  exponent -= leading_zeros;
  digits = digits.slice(leading_zeros).replace(/0+$/, '');
  if (!digits) { digits = '0'; exponent = 0; }
  if (precision && digits.length > precision) {
    const round_up = digits[precision] >= '5';
    digits = digits.slice(0, precision);
    if (round_up) {
      // 999 => 1000
      const rounded = String(BigInt(digits) + 1n);
      if (rounded.length > digits.length) exponent++;
      digits = rounded.slice(0, precision);
    }
    digits = digits.replace(/0+$/, '') || '0';
  }
  if (exponent < -3 || exponent >= 5)
    return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${exponent >= 0 ? '+' : ''}${exponent}`;
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  if (digits.length <= exponent + 1) return sign + digits.padEnd(exponent + 1, '0');
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
};


const groupBy = (array, prop) => {
  return array.reduce(function (groups, item) {
    var val = item[prop];
    groups[val] = groups[val] || [];
    groups[val].push(item);
    return groups;
  }, {});
};

const groupByObject = (array, prop) => {
  return array.reduce(function (groups, item) {
    var val = JSON.stringify(item[prop]);
    groups[val] = groups[val] || [];
    groups[val].push(item);
    return groups;
  }, {});
};

const shortId = (project, id) => {
  return id.substring(0, 8);
};

const pretty_label = batch => {
  if ((batch.data || {}).type === 'local' || !!batch.label.match(/^@.+\| .+/)) {
    var [user, label] = batch.label.replace('@', '').split('| ');
    return `${user} 🏠 ${label !== 'default' ? label : ''}`;
  } else {
    return batch.label === "default" ? "CI" : batch.label;
  }
}

const empty_output = { metrics: undefined, extra_parameters: {} };


// Finds the reference output that best matches an output.
// Pass an index made with index_outputs(batch) when matching many outputs against the same batch.
const matching_output = ({ output, batch, index }) => {
  index = index ?? index_outputs(batch);
  // high => more different
  const match_score = o =>
    8 * ((o.input_path !== output.input_path) | 0) +
    4 * ((o.configurations_str !== output.configurations_str) | 0) +
    2 * ((o.platform !== output.platform) | 0) +
    1 * ((o.extra_parameters_str !== output.extra_parameters_str) | 0);

  // Most of the time there's an identical run: no need to measure how different the others are
  const exact = index.exact.get(run_key(output));
  if (exact !== undefined)
    return { output_ref: index.outputs[exact], mismatch: null };

  // Candidates run on the same input, in the batch's order
  const positions = new Set([
    ...(index.by_input_path.get(output.input_path) ?? []),
    ...(index.by_test_input_path.get(output.test_input_path) ?? []),
    ...((output.test_input_metadata?.id && index.by_metadata_id.get(output.test_input_metadata.id)) || []),
  ]);
  const candidates = [...positions].sort((a, b) => a - b).map(i => {
    const o = index.outputs[i];
    return {
      o,
      dist_input_path: 1 - Number(o.input_path === output.input_path || o.test_input_path === output.test_input_path),
      dist_configurations: config_distance(o.configurations, output.configurations),
      dist_extra_parameters: config_distance(o.extra_parameters, output.extra_parameters),
    };
  });
  // We prefer to compare an ouput versus a similar one
  candidates.sort((a, b) =>
    (a.dist_input_path - b.dist_input_path) ||
    (a.dist_configurations - b.dist_configurations) ||
    (a.dist_extra_parameters - b.dist_extra_parameters) ||
    // same platform first (it used to sort them last)
    ((b.o.platform === output.platform) - (a.o.platform === output.platform))
  );

  let output_ref = candidates[0]?.o ?? empty_output;
  let ref_match_score = match_score(output_ref);
  let imperfect_match = candidates.length > 0 && ref_match_score > 0;
  let mismatch = imperfect_match ? {
    test_input_path: ref_match_score & 8 ? output_ref.test_input_path : null,
    configurations: ref_match_score & 4 ? output_ref.configurations : null,
    platform: ref_match_score & 2 ? output_ref.platform : null,
    extra_parameters: ref_match_score & 1 ? output_ref.extra_parameters : null,
  } : null;
  // only when there are some: the mismatch is compared with the backend's in tests/fixtures/metrics-compare.json
  const alternatives = imperfect_match ? count_alternatives(candidates) : 0;
  if (alternatives > 0) mismatch.alternatives = alternatives;
  return { output_ref, mismatch };
};

// How many reference runs, with other settings, have as many different settings as the one we picked:
// only how similar their values are (the distances' fractional part) made us choose.
const count_alternatives = candidates => {
  const [best] = candidates;
  const same = (a, b) => Math.floor(a) === Math.floor(b);
  const settings = new Set();
  for (const c of candidates.slice(1)) {
    if (c.dist_input_path !== best.dist_input_path) continue;
    if (!same(c.dist_configurations, best.dist_configurations) || !same(c.dist_extra_parameters, best.dist_extra_parameters)) continue;
    if (c.o.configurations_str === best.o.configurations_str && c.o.extra_parameters_str === best.o.extra_parameters_str) continue;
    settings.add(`${c.o.configurations_str}\u0000${c.o.extra_parameters_str}`);
  }
  return settings.size;
};

const run_key = o => `${o.input_path}\u0000${o.configurations_str}\u0000${o.extra_parameters_str}\u0000${o.platform}`;

// Lookups by input, for the outputs of a batch that are shown and not pending
const index_outputs = batch => {
  const outputs = (batch.filtered?.outputs ?? Object.keys(batch.outputs ?? {}))
    .map(id => batch.outputs[id])
    .filter(o => !!o && !o.is_pending);
  const by_input_path = new Map();
  const by_test_input_path = new Map();
  const by_metadata_id = new Map();
  const exact = new Map();
  const add = (map, key, i) => {
    if (key === undefined || key === null) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  };
  outputs.forEach((o, i) => {
    add(by_input_path, o.input_path, i);
    add(by_test_input_path, o.test_input_path, i);
    if (o.test_input_metadata?.id) add(by_metadata_id, o.test_input_metadata.id, i);
    if (!exact.has(run_key(o))) exact.set(run_key(o), i);
  });
  return { outputs, by_input_path, by_test_input_path, by_metadata_id, exact };
};

const safe_regex = s => {
  // creating regexes with user input can lead to invalid regexes...
  try {
    return new RegExp(s);
  } catch {
    const s_safe = s.replace(/[\W]/g, ".")
    return new RegExp(s_safe)
  }
}

const match_query = pattern => {
  if (pattern === undefined || pattern === null)
    return () => true
  const tokens = pattern
    .trim()
    .toLowerCase()
    .replace(/"/g, "")
    .replace(/(=+|: )/g, ":")
    // CDE has pipes in register names, so we're willing to be accomodating!
    .replace(/\.sim\|/g, ".sim.")
    .replace(/\.def\|/g, ".def.")
    .replace(/\.eco\|/g, ".eco.")
    .split(" ");
  const negative_tokens = tokens
    .filter(t => t[0] === "-" && t.length > 1)
    .map(t => t.substring(1));
  const positive_tokens = tokens.filter(t => t[0] !== "-");
  const positive_regexps = positive_tokens.map(t => safe_regex(t))
  // console.log(positive_tokens, negative_tokens)
  // console.log(pattern, positive_regexps)
  return query => {
    // console.log("query", query)
    const searched = query.toLowerCase().replace(/(=+|: )/g, ":").replace(/"/g, "");
    // console.log("searched", searched)
    if (negative_tokens.some(token => searched.includes(token)))
      return false;
    if (positive_tokens.length === 0)
      return true;
    return positive_regexps.every(r => searched.match(r))
  }
}

const filter_batch = (batch, filter_values) => {
  if (filter_values === undefined || filter_values === null || filter_values.length === 0)
    return {
      outputs: Object.keys(batch.outputs || {}),
      valid_outputs: batch.valid_outputs,
      running_outputs: batch.running_outputs,
      pending_outputs: batch.pending_outputs,
      failed_outputs: batch.failed_outputs,
      deleted_outputs: batch.deleted_outputs,    
    };

  const matcher = match_query(filter_values)

  let filtered = {
    outputs: [],
    valid_outputs: 0,
    running_outputs: 0,
    pending_outputs: 0,
    failed_outputs: 0,
    deleted_outputs: 0,  
  }

  Object.entries(batch.outputs).forEach(([id, output]) => {
    let metadata = Object.keys(output.test_input_metadata ?? {}).length > 0 ? JSON.stringify(output.test_input_metadata ?? {}) : "";
    let failed = output.is_failed ? 'fail crash' : '';
    let pending = output.is_pending ? 'pending running' : ''
    let searched = `${output.test_input_path} ${output.configurations_str} ${metadata} ${JSON.stringify(output.params)} ${output.data?.batch} ${failed} ${pending} ${output.platform} id:${id}`;
    // console.log(searched)
    if (matcher(searched)) {
      filtered.outputs.push(id);
      if (output.is_running)
        filtered.running_outputs += 1
      else if (output.is_pending && !output.is_running)
        filtered.pending_outputs += 1
      else if (output.is_failed)
        filtered.failed_outputs += 1
      else
        filtered.valid_outputs += 1
      if (output.deleted)
        filtered.deleted_outputs += 1
    }
  });

  return filtered;
};

const plotly_palette_colors = [
  '#1f77b4',  // muted blue
  '#ff7f0e',  // safety orange
  '#2ca02c',  // cooked asparagus green
  '#d62728',  // brick red
  '#9467bd',  // muted purple
  '#8c564b',  // chestnut brown
  '#e377c2',  // raspberry yogurt pink
  '#7f7f7f',  // middle gray
  '#bcbd22',  // curry yellow-green
  '#17becf'   // blue-teal
]
const plotly_palette = idx => plotly_palette_colors[idx % plotly_palette_colors.length]


const hash_numeric = str => {
  const md5_array = md5.array(str);
  const md5_value = md5_array.reduce(
    (accumulator, current, current_idx) =>
      accumulator + (current >> 7) / Math.pow(2, current_idx + 1),
    0
  );
  const correction = 1 + Math.pow(2, -16);
  return md5_value * correction
}

const hash_color = str => {
  return interpolateRainbow(hash_numeric(str));
};


const project_avatar_style = project_id => {
  const hue_rotate = hash_numeric(project_id) * 360;
  const saturate = hash_numeric(`saturate-${project_id}`);
  // const invert = hash_numeric(`invert-${project_id}`);
  return {
    filter: `hue-rotate(${hue_rotate}deg) saturate(${1-Math.log(saturate)})`,
  }
};


// Link to a storage quota dashboard, if the site has one (QABOARD_QUOTA_URL_TEMPLATE)
const quota_url = (template, user_name, project) => {
  if (!template || !user_name)
    return null
  return template
    .replace('{user_name}', encodeURIComponent(user_name))
    .replace('{project}', encodeURIComponent(project ?? ''))
}

// The project's page on its git server
const project_web_url = project_data => repo_url(project_data);


const path_regex = /^(\\\\[^\\]+)(\\[^\\]+)/;
const extract_drive_and_folder = path => {
  // e.g. "\\netapp\folder\subfolder" => "\\netapp\folder"
  //
  // we currently assume windows-flavoured paths with backslashes 
  // path = path.replace(/\//g, '\\');
  const match = path.match(path_regex);
  if (match) {
    return match[1] + match[2];
  }
  return null
}

const are_on_same_filesystem = (path1, path2) => {
  // path2 = path2.replace(/\//g, '\\');
  const drive_folder_1 = extract_drive_and_folder(path1);
  const drive_folder_2 = extract_drive_and_folder(path2);
  return drive_folder_1 && drive_folder_2 && drive_folder_1 === drive_folder_2;
}


// Apply a function to all elements of a JS object (go into dict, array...)
// Returns a new object/array; does NOT mutate its input. This matters because
// integration configs come from Redux state and are reused across renders:
// mutating them in-place replaces template strings like "${commit.x}" with
// concrete values from the *first* render, so when the user navigates to a
// different commit the template no longer exists and the stale URL is used
// (leading to 404s on artifact links, etc.).
const recursively_apply = function(object, func) {
  if (object === null || typeof object !== 'object') {
    return func(object)
  }
  if (Array.isArray(object)) {
    return object.map(item => recursively_apply(item, func))
  }
  const result = {}
  Object.keys(object).forEach(k => {result[k] = recursively_apply(object[k], func)})
  return result
}

// Evaluated JS-style templated strings using a dict of variables (like backticks).
// ```
// ( "${key}", {key: "value"} ) => "value"
// ```
const fill_template = (template_string, parameters) => {
  if (typeof template_string !== 'string') return template_string;
   // eslint-disable-next-line
  var func = new Function(...Object.keys(parameters),  "return `" + template_string + "`;")
  const filled_templated = func(...Object.values(parameters));
  // Many errors are git.web_url not being loaded/defined already,
  // then it leads to 500 errors dow 
  // We could be less aggressive and raise exception on .startsWith()...
  if (filled_templated.includes('undefined')) {
    const error = `[fill_template] A template parameter was not not found: ${filled_templated}`;
    // console.log(error)
    throw error; 
  }
  return filled_templated
}


const make_eval_templates_recursively = ({project, project_data, branch, commit, batch, ...rest }) => {
  let project_repo = (project_data && project_data.data && project_data.data.git && project_data.data.git.path_with_namespace) || '';
  let subproject = project.slice(project_repo.length + 1);
  let project_parts = project.split('/');
  let subproject_parts = subproject.split('/');
  let project_parts_tolower = project.toLowerCase().split('/');
  let subproject_parts_tolower = subproject.toLowerCase().split('/');
  let project_name = project_parts[project_parts.length-1];
  let project_name_tolower = project_name.toLowerCase();
  let context = {
      // integrations' templates use e.g. ${git.web_url}
      git: { ...project_data?.data?.git, web_url: project_web_url(project_data) },
      project,                  // "group/project/my/Subproject"
      subproject,               // "my/Subproject"
      project_name,             // "Subproject"
      project_parts,            // ["group", "project", "my", "Subproject"]
      subproject_parts,         // ["my", "Subproject"]
      project_name_tolower,     // "subproject"
      project_parts_tolower,    // ["group", "project", "my", "subproject"]
      subproject_parts_tolower, // ["my", "subproject"]
      ...rest,
      // branch,
      // commit,
      // batch,
      // user,
  }
  if (batch !== undefined && batch !== null) {
    context.batch = batch.label
  }
  if (branch !== undefined){
    context.branch = branch
    context.branch_slug = slug(branch)
  }
  if (commit?.branch !== undefined) {
    context.commit = {
      ...commit,
      branch_slug: slug(commit.branch),
      // backward compatibility
      ...(commit.artifacts_url !== undefined ? { commit_dir_url: commit.artifacts_url } : {}),
      ...(commit.repo_artifacts_url !== undefined ? { repo_commit_dir_url: commit.repo_artifacts_url } : {}),
    }
  }
  
  return integration => {
    // try {
      // console.log("[before]", integration)
      // console.log(context.commit)
      const evaled_integration = recursively_apply(integration, s => fill_template(s, context));
      // console.log("[after]", evaled_integration)
    // } catch {
      // problem can happen when the project/commit data is not loaded yet... 
      // we should wait for everything to be loaded
    // }
      return evaled_integration;
  }
}

const slug = text => {
  const maxlength = 64
  return text
    .toString()                     // Cast to string
    .slice(0, maxlength - 1)        // truncate to maxlength
    .toLowerCase()                  // Convert the string to lowercase letters
    .trim()                         // Remove whitespace from both sides of a string
    .replace(/[^0-9a-z.=]+/g, '-')  // Remove all non-word chars
    .replace(/--+/g, '-')         // Replace multiple '-' with single '-'
    .replace(/^-+|-+$/g, '');     // Remove excess '-' from both sides of a string
}

// Returns a new mapping of metrics, with defaults for label, scale, suffix...
// Metrics whose key starts with a dot are hidden.
// The value of input events, or the value itself
const event_value = e => (e?.target && e.target.value !== undefined) ? e.target.value : e;

const metrics_fill_defaults = available_metrics => {
  const filled = {};
  Object.entries(available_metrics || {}).forEach(([key, m]) => {
    if (key.startsWith('.'))
      return;
    m = m ?? {};
    let smaller_is_better = m.smaller_is_better ?? true;
    if (typeof smaller_is_better === "string")
      smaller_is_better = smaller_is_better.toLowerCase() !== 'false';
    filled[key] = {
      ...m,
      key,
      label: m.label || key,
      short_label: m.short_label || m.label || key,
      scale: m.scale || 1.0,
      suffix: m.suffix || '',
      smaller_is_better,
    };
  });
  return filled;
}


// A width from qaboard.yaml (e.g. outputs.style.width: 1180px), as a maximum: narrower when the page is, e.g. when
// the View options take room on the right
const at_most = width => width === undefined || width === null || width === ''
  ? undefined
  : `min(${typeof width === 'number' ? `${width}px` : width}, 100%)`;

const checked_cde_attrs = ["width", "height", "format", "imageType", "md5_data"]
const is_same_data = (path, meta_1, meta_2) => {
  if (meta_1 === undefined || meta_1 === null || meta_2 === undefined || meta_2 === null)
    return false
  if (path.match(/\.(hex)$/)) {
    return checked_cde_attrs.filter(attr => meta_1[attr] !== undefined && meta_2[attr] !== undefined)
                            .every(attr => meta_1[attr] === meta_2[attr])
  } else {
    // for images we ignore metadata, and only look at a hash of pixel values
    return meta_1.md5_data && meta_2.md5_data
    ? meta_1.md5_data === meta_2.md5_data
    : meta_1.md5 === meta_2.md5;
  }
}


// message_renderer shows the success messages, errors are shown as danger toasts
const copyElementToClipboard = async (element, name, message_renderer) => {
  if (!element) return;
  const failed = error => toaster.show({ message: `Could not copy the ${name}: ${error?.message ?? error}`, intent: "danger" }, 'copy');
  // browsers only let focused pages write to the clipboard
  if (!document.hasFocus()) {
    toaster.show({ message: `Could not copy the ${name}: click on the page, then try again.`, intent: "warning" }, 'copy');
    return;
  }
  try {
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(element, { useCORS: true });

    // Convert to Blob. Errors in the callback would escape the try/catch.
    canvas.toBlob(async (blob) => {
      try {
        if (!blob) {
          failed("the image is empty");
        } else if (navigator.clipboard && window.ClipboardItem) {
          // Clipboard API is available
          const item = new ClipboardItem({ "image/png": blob });
          await navigator.clipboard.write([item]);
          message_renderer(`Copied ${name} to the clipboard.`);
        } else {
          // Fallback: Offer download
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = `${name.replace(" ", "-")}.png`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          message_renderer(`Your browser does not support clipboard copy. Downloading instead.`);
        }
      } catch (error) {
        failed(error);
      }
    }, "image/png");
  } catch (error) {
    failed(error);
  }
};


// Moved to git.js, kept here for compatibility
export { git_hostname, default_git_hostname, setDefaultGitHostname } from './git';

export {
  average,
  median,
  format,
  groupBy,
  groupByObject,
  matching_output,
  index_outputs,
  calendarStrings,
  shortId,
  pretty_label,
  filter_batch,
  match_query,
  hash_numeric,
  project_avatar_style,
  hash_color,
  plotly_palette,
  linux_to_windows,
  setPathMappings,
  quota_url,
  are_on_same_filesystem, extract_drive_and_folder,
  make_eval_templates_recursively,
  metrics_fill_defaults,
  event_value,
  project_web_url,
  is_same_data,
  at_most,
  copyElementToClipboard,
};
