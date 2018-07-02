import { interpolateRainbow } from "d3-scale-chromatic";
import md5 from "js-md5";

const calendarStrings = {
  lastDay: "[Yesterday]",
  sameDay: "[Today]",
  nextDay: "[Tomorrow]",
  lastWeek: "[last] dddd",
  nextWeek: "dddd",
  sameElse: "L"
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
  if (project === "dvs/psp_swip" || project === "tof/swip_tof")
    return id.substring(0, 8);

  let parts = id.split("/");
  let name = parts[parts.length - 1];
  let name_parts = name.split("__");
  return name_parts.slice(0, name_parts.length - 1).join("__");
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
    .filter(o => !o.is_pending && !o.is_failed)
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
    const a_value = a.metrics[sort_by] || a[sort_by];
    const b_value = b.metrics[sort_by] || b[sort_by];
    if (a_value === undefined || a_value === null) return 1;
    // console.log(a_value, b_value)
    if (a_value > b_value) {
      return order;
    }
    if (a_value < b_value) {
      return -order;
    }
    // TODO: we may want to sort also by extra_parameters
    // the code below won't sort correctly numbers (5 vs 55)...
    // return JSON.stringify(a.extra_parameters) < JSON.stringify(b.extra_parameters);
    return 0;
  };
};

const input_test_color = (path, label) => {
  let hash = md5.array(path);
  let hash_numeric = hash.reduce(
    (accumulator, current, current_idx, array) =>
      accumulator + (current >> 7) / Math.pow(2, current_idx + 1),
    0
  );
  let correction = 1 + Math.pow(2, -16);
  let color = interpolateRainbow(hash_numeric * correction);
  return color;
};

export {
  groupBy,
  groupByObject,
  matching_output,
  calendarStrings,
  shortId,
  sortOutputs,
  input_test_color
};
