import { interpolateRainbow } from "d3-scale-chromatic";
import md5 from "js-md5";
import { median as mathjs_median } from "mathjs";

// import math from '@mathjs';

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
  return array_filtered.length>0 ? mathjs_median(array_filtered) : null;
};


const groupBy = (array, prop) => {
  return array.reduce(function(groups, item) {
    var val = item[prop];
    groups[val] = groups[val] || [];
    groups[val].push(item);
    return groups;
  }, {});
};

const groupByObject = (array, prop) => {
  return array.reduce(function(groups, item) {
    var val = JSON.stringify(item[prop]);
    groups[val] = groups[val] || [];
    groups[val].push(item);
    return groups;
  }, {});
};

const shortId = (project, id) => {
  return id.substring(0, 8);
};

const empty_output = { metrics: undefined, extra_parameters: {} };

// Finds the most matching output from a batch
const matching_output = ({ output, batch }) => {
  // high => more different
  const match_score = o =>
    5 * ((o.configuration !== output.configuration) | 0) +
    3 * ((o.platform !== output.platform) | 0) +
    1 *
      ((JSON.stringify(o.extra_parameters) !==
        JSON.stringify(output.extra_parameters)) |
        0);

  // let soft_match = true;
  let matching_outputs = Object.values(batch.outputs || {})
    .filter(o => !o.is_pending)
    .filter(o => o.test_input_path === output.test_input_path)
    // .filter(o => o.platform===output.platform || soft_match)
    // .filter(o => o.configuration===output.configuration || soft_match)
    // We prefer to compare an ouput versus a similar one
    .sort((a, b) => match_score(a) - match_score(b));
  // if (matching_outputs) console.log(matching_outputs)
  let output_ref = matching_outputs[0] || empty_output;
  let imperfect_match = match_score(output_ref) > 0;
  let warning =
    imperfect_match && matching_outputs.length > 0
      ? `vs ${output_ref.configuration} @${
          output_ref.platform
        }  with ${JSON.stringify(output_ref.extra_parameters)}`
      : null;
  return { output_ref, warning, imperfect_match };
};

const sortOutputs = (sort_by, order) => {
  // console.log(sort_by, order)
  return ([ka, a], [kb, b]) => {
    const a_value = a.metrics[sort_by] || a.extra_parameters[sort_by] || a[sort_by];
    const b_value = b.metrics[sort_by] || b.extra_parameters[sort_by] || b[sort_by];
    if (a_value === undefined || a_value === null) return 1;
    // console.log(a_value, b_value)
    if (a_value > b_value) {
      return order;
    }
    if (a_value < b_value) {
      return -order;
    }
    return 0;
  };
};



const filter_batch = (batch, filter_values) => {
  // console.log(filter_values)
  if (filter_values === undefined || filter_values === null || filter_values.length === 0)
  	return batch;
  //if (typeof filter_values !== 'string' || !(filter_values instanceof String))
  //  return batch;

  // console.log(filter_values)
  let filter_tokens = filter_values
    .toLowerCase()
    .replace(/"/g, "")
    .replace(/=+/g, ":")
    .replace(/: /g, ":")
    .split(" ");

  let batch_filtered = Object.create(batch); // copy
  batch_filtered.outputs = {};

  Object.entries(batch.outputs).forEach(([id, output]) => {
    let extra_parameters_s = Object.keys(output.extra_parameters || {}).length > 0 ? JSON.stringify(output.extra_parameters || {}) : "";
    let metadata_s = Object.keys(output.test_input_metadata || {}).length > 0 ? JSON.stringify(output.test_input_metadata || {}) : "";
    let extra_parameters = extra_parameters_s.replace(/"/g, "");
    let metadata = metadata_s.replace(/"/g, "");
    let searched = `${output.test_input_path} ${output.platform} ${output.configuration} ${metadata} ${extra_parameters}`.toLowerCase();

    let negative_filter_tokens = filter_tokens
      .filter(t => t[0] === "-")
      .map(t => t.substring(1));
    if (negative_filter_tokens.some(token => !!token && searched.includes(token)))
      return;

    let positive_filter_tokens = filter_tokens.filter(t => t[0] !== "-");
    let found = positive_filter_tokens.every(token =>
      searched.includes(token)
    );
    if (positive_filter_tokens.length === 0 || found)
      batch_filtered.outputs[id] = output;
  });
  // we update the summary metrics
  batch_filtered.valid_outputs = 0
  batch_filtered.running_outputs = 0
  batch_filtered.pending_outputs = 0
  batch_filtered.failed_outputs = 0
  Object.values(batch_filtered.outputs).forEach(o => {
    if (o.is_running)
      batch_filtered.running_outputs += 1
    else if (o.is_pending && !o.is_running)
      batch_filtered.pending_outputs += 1
    else if (o.is_failed)
      batch_filtered.failed_outputs += 1
    else
      batch_filtered.valid_outputs += 1
  })
  return batch_filtered;
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

const hash_color = str => {
  let hash = md5.array(str);
  let hash_numeric = hash.reduce(
    (accumulator, current, current_idx, array) =>
      accumulator + (current >> 7) / Math.pow(2, current_idx + 1),
    0
  );
  let correction = 1 + Math.pow(2, -16);
  let color = interpolateRainbow(hash_numeric * correction);
  return color;
};


const deserialize_config = configuration => {
  if (configuration === undefined || configuration === null || configuration.length === 0) {
  	return []
  }
  let configurations = []
  let configuration_part = ''
  for (const token of configuration.split(':')) {
    if (configuration_part.length === 0 && !token.startsWith('{')) {
      configurations.push(token)    	
    } else {
      configuration_part = configuration_part ? `${configuration_part}:${token}` : token;
      try {
        configurations.push(JSON.parse(configuration_part))
        configuration_part = '';
      } catch {}
    }
  }
  return configurations
}



const linux_to_windows = path => {
  let windows_path = path
                       .replace(/\/s\//, '/')
                       .replace('//home', '//mars/raid/users')
                       .replace('/home', '//mars/raid/users')
                       .replace('//stage', '//netapp')
                       .replace('/stage', '//netapp')
  // if (!windows_path.startsWith('//mars') || !windows_path.startsWith('//netapp'))
  //   windows_path = `//mars/raid/users/arthurf${windows_path}` 
  return windows_path.replace(/\//g, '\\')

}

export {
  average,
  median,
  groupBy,
  groupByObject,
  matching_output,
  calendarStrings,
  shortId,
  sortOutputs,
  filter_batch,
  hash_color,
  plotly_palette,
  deserialize_config,
  linux_to_windows,
};
