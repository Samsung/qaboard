import { interpolateRainbow } from "d3-scale-chromatic";
import { median as mathjs_median } from "mathjs/number";
import md5 from "js-md5";

import { levenshtein } from "./levenshtein";


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
  let array_filtered = array.filter(x => x !== undefined && x !== null)
  return array_filtered.length > 0 ? mathjs_median(array_filtered) : null;
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



// Finds the most matching output from a batch
const matching_output = ({ output, batch }) => {
  // high => more different
  const match_score = o =>
    8 * ((o.test_input_path !== output.test_input_path) | 0) +
    4 * ((o.configurations_str !== output.configurations_str) | 0) +
    2 * ((o.platform !== output.platform) | 0) +
    1 * ((o.extra_parameters_str !== output.extra_parameters_str) | 0);

    output.extra_parameters_str = JSON.stringify(output.extra_parameters)
    output.configurations_str = JSON.stringify(output.configurations)

  // console.log('MATCHING')
  // const t0 = performance.now();

  let matching_outputs = batch.filtered.outputs.map(id => batch.outputs[id])
    .filter(o => !o.is_pending)
    .filter(o => o.test_input_path === output.test_input_path || (output.test_input_metadata.id && o.test_input_metadata.id && o.test_input_metadata.id === output.test_input_metadata.id) )
    // We prefer to compare an ouput versus a similar one
    .map(o => {
      o.dist_configurations = levenshtein(o.configurations_str, output.configurations_str)
      o.dist_extra_parameters = levenshtein(o.extra_parameters_str, output.extra_parameters_str)
      return o;
    })
    // .sort((a, b) => match_score(a) - match_score(b));
    .sort((a, b) => {
      // +1: b more similar
      // +-: b less similar
      const dist_config = a.dist_configurations - b.dist_configurations;
      if (dist_config !== 0) {
        return dist_config;
      }
      const dist_extra_parameters = a.dist_extra_parameters - b.dist_extra_parameters;
      if (dist_extra_parameters !== 0) {
        return dist_extra_parameters;
      }
      return (a.platform === output.platform) - (b.platform === output.platform)
  });
  
  // const t1 = performance.now();
  // console.log("Match took " + (t1 - t0) + " ms.")

  let output_ref = matching_outputs[0] || empty_output;
  let ref_match_score = match_score(output_ref);
  let imperfect_match = matching_outputs.length > 0 && ref_match_score > 0;
  let mismatch = imperfect_match ? {
    test_input_path: ref_match_score & 8 ? output_ref.test_input_path : null,
    configurations: ref_match_score & 4 ? output_ref.configurations : null,
    platform: ref_match_score & 2 ? output_ref.platform : null,
    extra_parameters: ref_match_score & 1 ? output_ref.extra_parameters : null,
  } : null;
  return { output_ref, mismatch };
};

const safe_regex = s => {
  // creating regexes with user input can lead to invalid regexes...
  try {
    return new RegExp(s);
  } catch(e) {
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
    let searched = `${output.test_input_path} ${output.configurations_str} ${metadata} ${JSON.stringify(output.params)} ${failed} ${pending} ${output.platform}`;
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
    (accumulator, current, current_idx, array) =>
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


const default_git_hostname = "http://gitlab-srv" // TODO: "https://gitlab.com" in the OSS version
const git_hostname = qaboard_config => {
  const project_url = qaboard_config?.project?.url
  // const project_url = "git@gitlab-srv:svt/te-testing.git"      //=> gitlab-srv
  // const project_url = "git@gitlab-srv:8080:svt/te-testing.git" //=> gitlab-srv:8080
  // const project_url = "https://gitlab-srv/svt/te-testing.git"  //=> gitlab-srv
  let hostname = null
  if (project_url) {
    let match = project_url.match(/@([^/:]+(:[0-9]+)?)[:/]/)
    if (match)
      hostname = `http://${match[1]}` // TODO: https for open-source version...
    match = project_url.match(/(https?:\/\/[^/:]+(:[0-9]+)?\/)/)
    if (match)
      hostname = match[1]
  }
  return hostname

}

// FIXME: make it part of a global user/project/instance configuration
const linux_to_windows = path => {
  if (path === undefined || path === null)
    return path
  let windows_path = decodeURI(path)
    .replace(/\/s\//, '/')
    // .replace('//mnt/datasets', '//F/datasets') // for instance... FIXME: make it configurable in a better way...
  return windows_path.replace(/\//g, '\\')
}



// Apply a function to all elements of a JS object (go into dict, array...)
const recursively_apply = function(object, func) {
  if (typeof object === 'object') {
    Object.keys(object).forEach(k => {object[k] = recursively_apply(object[k], func)})
    return object
  } else {
    object = func(object)
    return object
  }
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


const make_eval_templates_recursively = ({project, project_data, branch, commit, ...rest }) => {
  let project_repo = (project_data && project_data.data && project_data.data.git && project_data.data.git.path_with_namespace) || '';
  let subproject = project.slice(project_repo.length + 1);
  let project_parts = project.split('/');
  let subproject_parts = subproject.split('/');
  let project_parts_tolower = project.toLowerCase().split('/');
  let subproject_parts_tolower = subproject.toLowerCase().split('/');
  let project_name = project_parts[project_parts.length-1];
  let project_name_tolower = project_name.toLowerCase();
  let context = {
      git: project_data && project_data.data && project_data.data.git,
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
      // user,
  }
  if (branch !== undefined){
    context.branch = branch
    context.branch_slug = slug(branch)
  }
  if ((commit !== undefined) && (commit.branch !== undefined)){
    context.commit = commit
    if (commit.branch !== undefined)
      context.commit.branch_slug = slug(commit.branch)
    // backward compatibility
    if (commit.artifacts_url !== undefined)
      context.commit.commit_dir_url = commit.artifacts_url
    if (commit.repo_artifacts_url !== undefined)
      context.commit.repo_commit_dir_url = commit.repo_artifacts_url
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

const metrics_fill_defaults = available_metrics => {
  Object.entries(available_metrics || {}).forEach( ([key, m])  => {
    if (m === undefined || m === null) {
      m = {}
    }
    m.key = key
    m.label = m.label || key
    m.short_label = m.short_label || m.label || key
    m.scale = m.scale  || 1.0
    m.suffix = m.suffix || ''
    if (m.smaller_is_better === undefined || m.smaller_is_better === null) {
      m.smaller_is_better = true;
    } else {
      if (typeof m.smaller_is_better === "string") {
        m.smaller_is_better = m.smaller_is_better.tolower() !== 'false'
      }
    }
    if (key.startsWith('.')) {
      delete available_metrics[key]
    }
  })
  return available_metrics || {}
}


export {
  average,
  median,
  groupBy,
  groupByObject,
  matching_output,
  calendarStrings,
  shortId,
  pretty_label,
  filter_batch,
  match_query,
  hash_numeric,
  project_avatar_style,
  hash_color,
  plotly_palette,
  git_hostname,
  default_git_hostname,
  linux_to_windows,
  make_eval_templates_recursively,
  metrics_fill_defaults,
};
