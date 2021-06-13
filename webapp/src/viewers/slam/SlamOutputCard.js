import React, { Component } from "react";
import Plot from 'react-plotly.js';
import { get, all, spread, CancelToken } from "axios";
import { tsvParse } from "d3-dsv";

const config = {
  showSendToCloud: true,
  displayModeBar: true,
  plotlyServerURL: "https://chart-studio.plotly.com",
  showSendToCloud: true,
};

var colors = {
  groundtruth: "#4daf4a",
  new: "rgba(255, 131, 0, .9)",
  reference: "rgb(25,34,231)"
};

class SlamOutputCard extends Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
      is_loaded_debug: false,
      select_debug: "",
	  quat_orientation: true,
	  ref_quat_orientation: true,

      traces_6dof: {},
      traces_3d: {},
      traces_debug: {},
      data_debug: {},

      plot_revision: 0,
      data_set: undefined,
    };
  }

  componentDidUpdate(nextProps, prevState) {
    if (prevState.is_loaded) {
      let updated_new =
        nextProps.output_new !== undefined &&
        nextProps.output_new !== null &&
        (this.props.output_new == null ||
          nextProps.output_new.id !== this.props.output_new.id);
      let updated_ref =
        nextProps.output_ref !== undefined &&
        nextProps.output_ref !== null &&
        (this.props.output_ref == null ||
          nextProps.output_ref.id !== this.props.output_ref.id);
      if (updated_new || updated_ref) {
        if (this.state.cancel_source) this.state.cancel_source.cancel();
        this.getData(nextProps);
      }
    }
    if (!prevState.is_loaded_debug && nextProps.show_debug) this.loadDebug();
    if (nextProps.select_debug !== prevState.select_debug)
      this.setState({
        select_debug: nextProps.select_debug,
        traces_debug: {
          ...prevState.traces_debug,
          new: make_traces_debug(
            prevState.data_debug["new"],
            "new",
            nextProps.select_debug
          ),
          reference: make_traces_debug(
            prevState.data_debug["reference"],
            "reference",
            nextProps.select_debug
          )
        },
        plot_revision: prevState.plot_revision + 1
      });
  }

  componentDidMount() {
    this.getData(this.props);
  }
  //asynchronous due to weird need for 'await' in call for get_new()
  async getData(props) {
    const { output_new, output_ref, show_debug, path='camera_poses_debug.csv' } = props;
    let has_groundtruth = output_new.metrics.translation_aape !== null;

    const source = CancelToken.source();
    this.setState({ cancel_source: source });
    if (has_groundtruth) {
      var get_gt = () => {
        return get(`${output_new.output_dir_url}/GT_final.txt`, {
          cancelToken: source.token
        })
          .then(response => {
            let poses = parse_poses(response.data, output_new.test_input_path);
            this.setState((previous_state, props) => {
                return {
                    traces_6dof: {
                      ...previous_state.traces_6dof,
                      groundtruth: make_traces(poses, "groundtruth", previous_state.data_set)
                    },
                    traces_3d: {
                      ...previous_state.traces_3d,
                      groundtruth: make_traces3d(poses, "groundtruth")
                    }
                };              
            });
          })
          .catch(e => {console.log("error at get_gt")});
      };
    } else {
      get_gt = () => {};
    }
    //asynchronous arrow function
    var get_new = async () => {
      try {
        var response = await get(`${output_new.output_dir_url}/${path}`, {
          cancelToken: source.token
        });
        let poses = parse_poses(response.data, output_new.test_input_path);

        //first change state to include data_set, then (asynchronously )make traces (and return).
        await this.setState({data_set : poses.data_set});
        this.setState((previous_state, props) => {
          return {
            traces_6dof: {
              ...previous_state.traces_6dof,
              new: make_traces(poses, "new", previous_state.data_set)
            },
            traces_3d: {
              ...previous_state.traces_3d,
              new: make_traces3d(poses, "new")
            }              
          };
        });       
      }
      catch(e) {console.log("error at get_new")}
    };
    var get_ref;
    if (
      output_ref !== undefined &&
      output_ref !== null &&
      output_ref.output_dir_url !== undefined
    ) {
      get_ref = () => {
        return get(`${output_ref.output_dir_url}/${path}`, {
          cancelToken: source.token
        })
          .then(response => {
            let poses = parse_poses(response.data, output_new.test_input_path);
            this.setState((previous_state, props) => {
                return {
                    traces_6dof: {
                      ...previous_state.traces_6dof,
                      reference: make_traces(poses, "reference", previous_state.data_set)
                    },
                    traces_3d: {
                      ...previous_state.traces_3d,
                      reference: make_traces3d(poses, "reference")
                    }
                };
            });
          })
          .catch(e => {console.log("error at get_ref")});
      };
    } else {
      get_ref = () => {};
    }
    
    //first get new data, then make other traces with regards to its columns
    //TODO: somehow option #1 using 'await' works here, but option #2 using 'then' doesn't. WTF?
    //option #1:
    try {
      await get_new();
      all([get_gt(), get_ref()]).then(
        spread((req_gt, req_new, req_ref) => {
          if (this.state.data_set === undefined) {
            console.log("Error: setting is_loaded. but data_set is undefined!!");
          }
          this.setState({
            is_loaded: true,
            plot_revision: this.state.plot_revision + 1
          });
          if (show_debug) this.loadDebug();
        })
      )
      .catch(() => {
        this.setState({ is_loaded: true });
      })
    }
    catch(e) {
      this.setState({ is_loaded: true });
    }
    // //option #2:
    // get_new().then(
    //   all([get_gt(), get_ref()]).then(
    //     spread((req_gt, req_new, req_ref) => {
    //       this.setState({
    //         is_loaded: true,
    //         plot_revision: this.state.plot_revision + 1
    //       });
    //       if (show_debug) this.loadDebug();
    //     })
    //   )
    //   .catch(() => {
    //     this.setState({ is_loaded: true });
    //   })
    // )
    // .catch(() => {
    //   this.setState({ is_loaded: true });
    // });
  }

  loadDebug() {
    const { output_new, output_ref } = this.props;
    var get_new_debug = () => {
      return get(`${output_new.output_dir_url}/DebugExtensions.txt`)
        .then(response => {
          let data = parse_debug(response.data);
          this.setState((previous_state, props) => {
            return {
              data_debug: { ...previous_state.data_debug, new: data },
              traces_debug: {
                ...previous_state.traces_debug,
                new: make_traces_debug(data, "new", previous_state.select_debug)
              }
            };
          });
        })
        .catch(e => {});
    };
    var get_ref_debug = () => {
      return get(`${output_ref.output_dir_url}/DebugExtensions.txt`)
        .then(response => {
          let data = parse_debug(response.data);
          this.setState((previous_state, props) => {
            return {
              data_debug: { ...previous_state.data_debug, reference: data },
              traces_debug: {
                ...previous_state.traces_debug,
                reference: make_traces_debug(
                  data,
                  "reference",
                  previous_state.select_debug
                )
              }
            };
          });
        })
        .catch(e => {});
    };
    all([get_new_debug(), get_ref_debug()])
      .then(
        spread((req_new, req_ref) => {
          this.setState((previous_state, props) => {
            return {
              is_loaded_debug: true,
              plot_revision: previous_state.plot_revision + 1
            };
          });
        })
      )
      .catch(() => {
        this.setState({ is_loaded_debug: true });
      });
  }

  render() {	  
    const { show_debug, show_3d=true } = this.props;
    const { is_loaded, plot_revision } = this.state;
    const layout = this.props.layout || {};
    if (!is_loaded) {
      return <> 
      </>
    }
    if (this.state.data_set === undefined){
      console.log("Error: data_set undefined at render!");
    }

    var traces = [];
    ["groundtruth", "reference", "new"].forEach(label => {
      if (this.state.traces_6dof[label])
        traces = [...traces, ...this.state.traces_6dof[label]];
    });
    if (show_debug) {
      ["reference", "new"].forEach(label => {
        if (this.state.traces_debug[label])
          traces = [...traces, ...this.state.traces_debug[label]];
      });
    }

    if (show_3d) {
      var traces_3d = [];
      ["groundtruth", "reference", "new"].forEach(label => {
        if (this.state.traces_3d[label])
          traces_3d = [...traces_3d, this.state.traces_3d[label]];
      });
    }

    return <>
      {is_loaded &&
        <Plot
          data={traces}
          layout={{
            ...make_layout(show_debug, this.state.traces_debug.new, this.state.data_set),
            ...layout
          }}
          revision={plot_revision}
		  config={config}
        />
      }

	  {show_3d && is_loaded && 
        <Plot
          data={traces_3d}
          layout={layout3d}
          revision={plot_revision}
		  config={config}
        />
      }
    </>
  }
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

const is_old_format = (text_string, test_input_path) => {
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

var make_traces = function(poses, label, data_set) {
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
  }catch(e){console.log("error at make traces for ".concat(label))}  
};

var make_traces3d = function(poses, label) {
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
