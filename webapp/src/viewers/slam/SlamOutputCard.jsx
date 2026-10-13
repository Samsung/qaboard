import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { tsvParse } from "d3-dsv";

import Plot from "../../components/Plot";
import { fileQuery } from "../../api/queries";

// No "Send to Cloud" or "Edit chart" links: they would upload the data to Plotly's public Chart Studio
const config = {
  displayModeBar: true,
  showSendToCloud: false,
  showLink: false,
};

const colors = {
  groundtruth: "#4daf4a",
  new: "rgba(255, 131, 0, .9)",
  reference: "rgb(25,34,231)"
};


// The files are tab-separated values
const text_file_query = url => ({
  ...fileQuery(url, { responseType: 'text' }),
  // while we load other outputs, we keep showing the current ones
  placeholderData: keepPreviousData,
});

// Without url, there is nothing to load
const useTextFile = url => {
  const query = useQuery(text_file_query(url));
  return {
    data: url ? query.data : undefined,
    is_settled: !url || query.isSuccess || query.isError,
  };
};

// Returns undefined if the data is missing or can't be parsed
const try_parse = (text, parse, label) => {
  if (text === undefined) return undefined;
  try {
    return parse(text);
  } catch {
    console.log(`error at ${label}`);
    return undefined;
  }
};


const SlamOutputCard = ({ output_new, output_ref, show_debug, select_debug = "", path = 'camera_poses_debug.csv', show_3d = true, layout }) => {
  const has_groundtruth = output_new.metrics.translation_aape !== null;
  const has_reference = output_ref !== undefined && output_ref !== null && output_ref.output_dir_url !== undefined;

  const file_new = useTextFile(`${output_new.output_dir_url}/${path}`);
  const file_gt = useTextFile(has_groundtruth ? `${output_new.output_dir_url}/GT_final.txt` : null);
  const file_ref = useTextFile(has_reference ? `${output_ref.output_dir_url}/${path}` : null);
  const file_debug_new = useTextFile(show_debug ? `${output_new.output_dir_url}/DebugExtensions.txt` : null);
  const file_debug_ref = useTextFile(show_debug && has_reference ? `${output_ref.output_dir_url}/DebugExtensions.txt` : null);

  const { test_input_path } = output_new;
  const poses_new = useMemo(() => try_parse(file_new.data, text => parse_poses(text, test_input_path), "get_new"), [file_new.data, test_input_path]);
  const poses_gt = useMemo(() => try_parse(file_gt.data, text => parse_poses(text, test_input_path), "get_gt"), [file_gt.data, test_input_path]);
  const poses_ref = useMemo(() => try_parse(file_ref.data, text => parse_poses(text, test_input_path), "get_ref"), [file_ref.data, test_input_path]);
  const data_debug_new = useMemo(() => try_parse(file_debug_new.data, parse_debug, "get_new_debug"), [file_debug_new.data]);
  const data_debug_ref = useMemo(() => try_parse(file_debug_ref.data, parse_debug, "get_ref_debug"), [file_debug_ref.data]);

  // other traces are made with regards to the columns of the new data
  const data_set = poses_new?.data_set;
  const traces_6dof = useMemo(() => ({
    groundtruth: poses_gt && make_traces(poses_gt, "groundtruth", data_set),
    reference: poses_ref && make_traces(poses_ref, "reference", data_set),
    new: poses_new && make_traces(poses_new, "new", data_set),
  }), [poses_gt, poses_ref, poses_new, data_set]);
  const traces_3d = useMemo(() => ({
    groundtruth: poses_gt && make_traces3d(poses_gt, "groundtruth"),
    reference: poses_ref && make_traces3d(poses_ref, "reference"),
    new: poses_new && make_traces3d(poses_new, "new"),
  }), [poses_gt, poses_ref, poses_new]);
  const traces_debug = useMemo(() => ({
    new: data_debug_new && make_traces_debug(data_debug_new, "new", select_debug),
    reference: data_debug_ref && make_traces_debug(data_debug_ref, "reference", select_debug),
  }), [data_debug_new, data_debug_ref, select_debug]);

  const is_loaded = file_new.is_settled && file_gt.is_settled && file_ref.is_settled;
  if (!is_loaded) {
    return <>
    </>
  }
  if (data_set === undefined){
    console.log("Error: data_set undefined at render!");
  }

  let traces = [];
  ["groundtruth", "reference", "new"].forEach(label => {
    if (traces_6dof[label])
      traces = [...traces, ...traces_6dof[label]];
  });
  if (show_debug) {
    ["reference", "new"].forEach(label => {
      if (traces_debug[label])
        traces = [...traces, ...traces_debug[label]];
    });
  }

  const data_3d = ["groundtruth", "reference", "new"]
    .map(label => traces_3d[label])
    .filter(trace => !!trace);

  return <>
    <Plot
      data={traces}
      layout={{
        ...make_layout(show_debug, traces_debug.new, data_set),
        ...layout
      }}
      config={config}
    />
    {show_3d &&
      <Plot
        data={data_3d}
        layout={layout3d}
        config={config}
      />
    }
  </>
}

const parse_debug = text_string => {
  let data = tsvParse(text_string);
  var output = {};
  data.columns.forEach(c => (output[c] = []));

  let t0 = data[0]["t"];
  for (let i = 1; i < data.length; i++) {
    // we don't plot the 1st point, often far away in time...
    let row = data[i];
    row["t"] = parseFloat(row["t"] - t0);
    data.columns.forEach(c => output[c].push(parseFloat(row[c])));
  }
  return output;
};

// we want to share the same t0 for a given recording
// var t0s = {}; // maps recording -> t0
/*
const parse_poses_old = (text_string, test_input_path) => {
  let headers = [
    "rX",
    "rY",
    "rZ",
    "tX",
    "tY",
    "tZ",
    "t",
    "confidence",
    "tracking_state\n"
  ].join("\t");
  let data = tsvParse(headers + text_string);

  let data_set = {}; 
  let keys = Object.keys(data[0]);
  for (let i = 0; i < keys.length; i++ ) {
    if (keys[i] !== 't')
        data_set[keys[i]] = [];
  }
  let t = [];
  keys = Object.keys(data_set);
  // we ignore the 1st point, often far away in time...
  for (let i = 1; i < data.length; i++) {
    let row = data[i];
    for (let j = 0; j < keys.length; j++ ) {
      data_set[keys[j]].push(parseFloat(row[keys[j]]));
    }
    t.push(parseFloat(row['t']));
  }
  return {data_set, t};

  // let tX = [],
  //   tY = [],
  //   tZ = [];
  // let rX = [],
  //   rY = [],
  //   rZ = [];
  // let t = [];
  // let confidence = [],
  //   tracking_state = [];

  // let starts_at_zero = parseFloat(data[0]["t"]) === 0.0;
  // if (!starts_at_zero && t0s[test_input_path] === undefined)
  //   t0s[test_input_path] = parseFloat(data[0]["t"]);
  // let t0 = !starts_at_zero ? t0s[test_input_path] : 0;

  // // we ignore the 1st point, often far away in time...
  // for (let i = 1; i < data.length; i++) {
  //   let row = data[i];
	// rX.push(parseFloat(row["rX"]));
  //   rY.push(parseFloat(row["rY"]));
  //   rZ.push(parseFloat(row["rZ"]));
  //   tX.push(parseFloat(row["tX"]));
  //   tY.push(parseFloat(row["tY"]));
  //   tZ.push(parseFloat(row["tZ"]));
  //   t.push(parseFloat(row["t"] - t0));
  //   confidence.push(parseFloat(row["confidence"] / 100));
  //   tracking_state.push(parseFloat(row["tracking_state"]));
  // }
  // return { rX, rY, rZ, tX, tY, tZ, t, confidence, tracking_state};
};
*/

const is_old_format = text_string => {
  let data = tsvParse(text_string);
  if (Object.keys(data[0]).includes('t'))
    return false;
  return true;
}

const parse_poses = (text_string, test_input_path) => {
  let data = {}
  let old_farmat = false;
  if (is_old_format(text_string, test_input_path)) old_farmat = true;
  if (old_farmat) {
    let headers = [
      "rX",
      "rY",
      "rZ",
      "x",
      "y",
      "z",
      "t\n"
    ].join("\t");
    data = tsvParse(headers + text_string);
  }
  else{
    data = tsvParse(text_string);
  }
  let data_set = {columns: []}; 
  let keys = data.columns;
  let idx = 0
  for (let i = 0; i < keys.length; i++ ) {
    if (keys[i] !== 't') {
      data_set.columns.push(keys[i]);
      data_set[keys[i]] = {order: idx, values: []};
      idx++;
    }
  }
  let t = [];
  keys = data_set.columns
  // we ignore the 1st point, often far away in time...
  for (let i = 1; i < data.length; i++) {
    let row = data[i];
    for (let j = 0; j < keys.length; j++ ) {
      data_set[keys[j]].values.push(parseFloat(row[keys[j]]));
    }
    if (old_farmat) {
      t.push(parseFloat(row['t'] / 1000));
    }
    else {
      t.push(parseFloat(row['t']));
    }
  }
  return {data_set, t};
};

const make_traces = function(poses, label, data_set) {
  try{
    var columns = ['q_w', 'q_x', 'q_y', 'q_z', 'x', 'y', 'z']
    if (data_set !== undefined) {
      columns = data_set.columns;
    }
    else {
      console.log("Error: make_trace for ".concat(label).concat(" called with undefined data_set!"));
    }
    //create a trace only for data that also appears in the new data set
    var filtered_columns = poses.data_set.columns.filter(c => columns.includes(c))
    return filtered_columns.map((c) => {
      var index = columns.indexOf(c);
      return {
        x: poses.t,
        y: poses.data_set[c].values,
        line: {
          color: colors[label],
          width: label === "reference" ? 3 : 2 // ref wider to highlight bit accuracy
        },
        marker: {
          color: colors[label],
          size: 5
        },
        mode: "lines",
        name: label,
        legendgroup: label,
        yaxis: `y${(index + 1)}`,
        showlegend: index === 4 ? true : false
      };
    });
  }catch{console.log("error at make traces for ".concat(label))}  
};

const make_traces3d = function(poses, label) {
  const sample = (x, i) => i % 5 === 0;
  const include_reducer = (accum, curr) => accum && poses.data_set.columns.includes(curr);
  
  if (['x', 'y', 'z'].reduce(include_reducer)){
    return {
      type: "scatter3d",
      x: poses.data_set['x'].values.filter(sample),
      y: poses.data_set['y'].values.filter(sample),
      z: poses.data_set['z'].values.filter(sample),
      mode: "lines",
      line: {
        width: label === "reference" ? 3 : 2,
        color: colors[label],
        opacity: 0.8
      },
      name: label,
      legendgroup: label,
      showlegend: true
    };
  }
  else{
    console.log("could not find 3 axis for ".concat(label));
  }
  
};

const make_traces_debug = (data, label, select_string) => {
  if (!data) return [];
  var select = c => {
    if (select_string.length === 0) return false;
    let searched = c.toLowerCase();
    let tokens = select_string.split(" ");
    for (var i in tokens) {
      let search = tokens[i].toLowerCase();
      if (searched.includes(search)) return true;
    }
    return false;
  };
  let traces = Object.keys(data)
    .filter(select)
    .filter(c => c !== "t")
    .sort()
    .map((c, index) => {
      return {
        x: data.t,
        y: data[c],
        line: {
          color: colors[label],
          width: label === "reference" ? 3 : 2 // reference wider to highlight bit accuracy
        },
        marker: {
          color: colors[label],
          size: 5
        },
        mode: "lines",
        name: c,
        legendgroup: label,
        yaxis: `y${7 + index}`,
        showlegend: false
      };
    });
  return traces;
};

const make_layout = (show_debug, debug_data, data_set) => {
  var axes = ['q_w', 'q_x', 'q_y', 'q_z', 'x', 'y', 'z'];
  if (data_set !== undefined) {
    axes = data_set.columns;
  }
  else {
    console.log("Error: make_layout called with undefined data_Set!");
  }
  var n_columns = axes.length;  

  // 6dof+confidence and the debug info
  var n_yaxis =
    (show_debug && debug_data !== undefined) ? (n_columns + Object.keys(debug_data).length) : n_columns;
  var frac_v = 1.0 / (n_yaxis+1);
  var layout = {
    type: "scattergl", // try scatter
    // height:Math.min(85*n_yaxis, 1200),
    height: (show_debug ? 120 : 85) * n_yaxis,
    width: 350,
    // autosize: false,
    margin: { l: 60, r: 0, b: 50, t: 50, pad: 10 },
    legend: {
      x: 0,
      y: 1,
      bgcolor: "rgba(255,255,255,0.5)",
      traceorder: "grouped",
      tracegroupgap: 0
    }
  };
  if (show_debug && debug_data !== undefined) {
    let debug_axes = Object.values(debug_data).map(t => t.name);
    axes = axes.concat(debug_axes);
  }
  axes.forEach((title, index) => {
    let yaxis = `yaxis${index === 0 ? "" : index + 1}`;
    layout[yaxis] = {
      domain: [index * frac_v, (index + 1) * frac_v],
      titlefont: { size: index > 7 ? 12 : 12 },
      // side: (index <= 6 || index % 2 === 0) ? 'left' : 'right',
      title
    };
  });
  return layout;
};

const layout3d = {
  width: 350,
  height: 350,
  margin: { l: 60, r: 0, b: 50, t: 50, pad: 10 },
  legend: {
    x: 0,
    y: 1,
    bgcolor: "rgba(255,255,255,0.5)",
    traceorder: "grouped",
    tracegroupgap: 0
  }
};

export default SlamOutputCard;
